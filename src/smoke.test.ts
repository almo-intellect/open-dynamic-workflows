// smoke.test.ts — end-to-end proof that the workflow runtime works WITHOUT spending real
// claude tokens. We inject FAKE Executors via the required RunOptions.executors map, and every
// agent() call names one with {executor:'...'}, so no `claude --print` subprocess is ever
// spawned. Each test pins a unique runDir to avoid journal clashes.
//
// Run: npx tsx --test src/smoke.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";

import { runWorkflow } from "./runtime/run.js";
import type { Executor, ExecOptions, ExecResult, ProgressEvent, RunOptions } from "./types.js";

// ────────────────────────────────────────────────────────────────────────────
// Fake executor (per task spec). Resolves instantly; never touches `claude`.
// ────────────────────────────────────────────────────────────────────────────

function makeFakeResult(opts: ExecOptions): ExecResult {
  return {
    text: "FAKE:" + opts.prompt.slice(0, 20),
    structuredOutput: opts.schema ? { ok: true } : undefined,
    sessionId: "fake",
    costUsd: 0,
    durationMs: 1,
    resultSubtype: "success",
    isError: false,
    usage: { inputTokens: 1, outputTokens: 5 },
  };
}

const fakeExecutor: Executor = async (opts) => makeFakeResult(opts);

// Test scratch lives in the OS temp dir — never pollutes the repo.
const RUNS_ROOT = path.join(os.tmpdir(), "odw-smoke-runs");

let dirSeq = 0;
/** A unique runDir under the temp dir for each test, so journals never collide. */
function uniqueRunDir(tag: string): string {
  dirSeq += 1;
  return path.join(RUNS_ROOT, `smoke-${tag}-${dirSeq}`);
}

/** Base RunOptions with the fake executor registered as 'fake'; per-test runDir + script. */
function opts(tag: string, script: string, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    script,
    executors: { fake: fakeExecutor },
    runDir: uniqueRunDir(tag),
    ...extra,
  };
}

const META = `export const meta = { name: 'smoke', description: 'smoke test workflow' }\n`;

// ────────────────────────────────────────────────────────────────────────────
// (a) phase()/log()/agent() — script value returned; agent() text = "FAKE:..."
// ────────────────────────────────────────────────────────────────────────────

test("(a) script with phase/log/agent returns its value; agent() text is FAKE:prompt", async () => {
  const script = `${META}
phase('Scan');
log('starting');
const t = await agent('hello world prompt for the agent', { executor: 'fake' });
return { text: t };
`;
  const res = await runWorkflow(opts("a", script));
  assert.equal(typeof res.value, "object");
  const value = res.value as { text: string };
  // "FAKE:" + first 20 chars of the prompt.
  assert.equal(value.text, "FAKE:hello world prompt f");
  assert.ok(value.text.startsWith("FAKE:"));
});

// ────────────────────────────────────────────────────────────────────────────
// (b) agent() with schema returns the validated structured object { ok: true }
// ────────────────────────────────────────────────────────────────────────────

test("(b) agent() with schema returns the structured object { ok: true }", async () => {
  const script = `${META}
const obj = await agent('give me structured output', {
  executor: 'fake',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
});
return obj;
`;
  const res = await runWorkflow(opts("b", script));
  assert.deepEqual(res.value, { ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// (c) parallel([ok, throwing]) → [value, null]; call never rejects, order kept
// ────────────────────────────────────────────────────────────────────────────

test("(c) parallel([ok, throwing]) resolves to [value, null]", async () => {
  const script = `${META}
const out = await parallel([
  async () => await agent('the good one', { executor: 'fake' }),
  async () => { throw new Error('boom'); },
]);
return out;
`;
  const res = await runWorkflow(opts("c", script));
  const out = res.value as unknown[];
  assert.equal(out.length, 2);
  assert.equal(out[0], "FAKE:the good one");
  assert.equal(out[1], null);
});

// ────────────────────────────────────────────────────────────────────────────
// (d) pipeline([1,2,3], s1, s2) maps correctly; a throwing stage → null at that
//     position while the other items still succeed.
// ────────────────────────────────────────────────────────────────────────────

test("(d) pipeline maps (prev,original,index) and drops a throwing item to null", async () => {
  const script = `${META}
const out = await pipeline(
  [1, 2, 3],
  async (prev, original, index) => {
    // s1 receives the original item as prev for the first stage.
    if (prev !== original) throw new Error('stage1 prev should equal original');
    if (original === 2) throw new Error('blow up item 2 in stage 1');
    return prev * 10 + index;     // 1->10+0=10 ; 3->30+2=32
  },
  async (prev) => prev + 1,        // 10->11 ; 32->33
);
return out;
`;
  const res = await runWorkflow(opts("d", script));
  // item 1: (1*10+0)+1 = 11 ; item 2: thrown in stage 1 -> null ; item 3: (3*10+2)+1 = 33
  assert.deepEqual(res.value, [11, null, 33]);
});

// ────────────────────────────────────────────────────────────────────────────
// (f) sandbox determinism traps (SPEC §6): Date.now() and Math.random() throw
//     inside the script → runWorkflow rejects.
// ────────────────────────────────────────────────────────────────────────────

test("(f) wall-clock-now API (Date.now) makes the run reject", async () => {
  const script = `${META}
const t = Date.now();
return t;
`;
  await assert.rejects(runWorkflow(opts("f-date", script)));
});

test("(f) randomness API (Math.random) makes the run reject", async () => {
  const script = `${META}
const r = Math.random();
return r;
`;
  await assert.rejects(runWorkflow(opts("f-rand", script)));
});

test("(f) argless new Date() is rejected by the static determinism scan", async () => {
  await assert.rejects(
    runWorkflow(opts("f-newdate", `${META}\nreturn new Date();\n`)),
    /deterministic/i,
  );
});

test("(f) argless Intl.DateTimeFormat().format() is trapped (no ambient wall-clock leak)", async () => {
  // ECMA-402 defaults a missing/undefined date arg to the system clock in engine C++,
  // bypassing the SafeDate override — must be trapped at the Intl layer.
  await assert.rejects(
    runWorkflow(opts("f-intl-fmt", `${META}\nreturn Intl.DateTimeFormat().format();\n`)),
  );
  await assert.rejects(
    runWorkflow(opts("f-intl-parts", `${META}\nreturn Intl.DateTimeFormat().formatToParts();\n`)),
  );
  await assert.rejects(
    runWorkflow(opts("f-intl-undef", `${META}\nreturn Intl.DateTimeFormat().format(undefined);\n`)),
  );
});

test("(f) explicit Intl.DateTimeFormat().format(ts) + NumberFormat still work", async () => {
  const script = `${META}
const d = Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(0);
const n = Intl.NumberFormat('en-US').format(1234.5);
return { d, n };
`;
  const res = await runWorkflow(opts("f-intl-ok", script));
  const v = res.value as { d: string; n: string };
  assert.equal(v.d, "01/01/1970");
  assert.equal(v.n, "1,234.5");
});

test("(f) Intl formatRange: explicit args work (this bound), argless trapped", async () => {
  const ok = `${META}
return Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatRange(0, 86400000);
`;
  const res = await runWorkflow(opts("f-intl-range", ok));
  assert.equal(typeof res.value, "string");
  assert.ok((res.value as string).includes("1970"));

  await assert.rejects(
    runWorkflow(opts("f-intl-range-argless", `${META}\nreturn Intl.DateTimeFormat().formatRange();\n`)),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// (g) non-literal meta rejects (SPEC §3) — a meta that references a variable is
//     not a pure literal, so extractMeta throws and the run rejects.
// ────────────────────────────────────────────────────────────────────────────

test("(g) non-literal meta rejects", async () => {
  const nameVar = "computed-name";
  const script = `const n = ${JSON.stringify(nameVar)};
export const meta = { name: n, description: 'meta references a variable -> not a pure literal' }
return 'unreachable';
`;
  await assert.rejects(runWorkflow(opts("g", script)));
});

// ────────────────────────────────────────────────────────────────────────────
// (h) WorkflowResult shape: runId/value present; events include run_start,
//     agent_start, agent_end, run_end.
// ────────────────────────────────────────────────────────────────────────────

test("(h) WorkflowResult shape + event lifecycle (run_start/agent_start/agent_end/run_end)", async () => {
  const script = `${META}
const t = await agent('one agent for the lifecycle', { executor: 'fake' });
return t;
`;
  const res = await runWorkflow(opts("h", script));

  assert.equal(typeof res.runId, "string");
  assert.ok(res.runId.length > 0);
  assert.equal(res.value, "FAKE:one agent for the li");
  assert.ok(Array.isArray(res.events));

  const types = res.events.map((e) => e.type);
  assert.ok(types.includes("run_start"), "events should include run_start");
  assert.ok(types.includes("agent_start"), "events should include agent_start");
  assert.ok(types.includes("agent_end"), "events should include agent_end");
  assert.ok(types.includes("run_end"), "events should include run_end");

  // run_start first, run_end last; agent events sit between them.
  assert.equal(types[0], "run_start");
  assert.equal(types[types.length - 1], "run_end");
});

// ────────────────────────────────────────────────────────────────────────────
// (i) sandbox Date trap is NOT escapable via an instance's .constructor (SPEC §6).
//     `new Date(0).constructor.now()`, `Date.prototype.constructor.now()`, and the
//     argless `new (instance.constructor)()` all reach the trapped SafeDate, so the
//     run must reject — the determinism guarantee can't be defeated.
// ────────────────────────────────────────────────────────────────────────────

test("(i) Date trap is not escapable via instance.constructor.now()", async () => {
  await assert.rejects(
    runWorkflow(opts("i-ctor-now", `${META}\nreturn new Date(0).constructor.now();\n`)),
  );
});

test("(i) Date trap is not escapable via Date.prototype.constructor.now()", async () => {
  await assert.rejects(
    runWorkflow(opts("i-proto-ctor", `${META}\nreturn Date.prototype.constructor.now();\n`)),
  );
});

test("(i) Date trap is not escapable via argless new (instance.constructor)()", async () => {
  await assert.rejects(
    runWorkflow(opts("i-ctor-new", `${META}\nconst C = new Date(0).constructor; return new C();\n`)),
  );
});

test("(i) Date trap is not escapable via structuredClone (host back-channel removed)", async () => {
  // structuredClone reconstructs Dates on the real untrapped prototype; it must not be
  // exposed, so referencing it inside the script throws (ReferenceError) → run rejects.
  await assert.rejects(
    runWorkflow(opts("i-sclone", `${META}\nreturn structuredClone(new Date(0)).constructor.now();\n`)),
  );
  await assert.rejects(
    runWorkflow(opts("i-sclone-nested", `${META}\nreturn structuredClone({ d: new Date(5) }).d.constructor.now();\n`)),
  );
});

test("(i) explicit Date construction + parse still work (legit path not broken)", async () => {
  const script = `${META}
return {
  t: new Date(0).getTime(),
  iso: new Date(0).toISOString(),
  parsed: Date.parse('1970-01-01T00:00:00.000Z'),
};
`;
  const res = await runWorkflow(opts("i-legit", script));
  // NB: the script's returned object literal carries the vm context's Object.prototype,
  // so assert.deepEqual (=deepStrictEqual, prototype-sensitive) would fail across realms.
  // Assert fields individually, like the other tests do.
  const v = res.value as { t: number; iso: string; parsed: number };
  assert.equal(v.t, 0);
  assert.equal(v.iso, "1970-01-01T00:00:00.000Z");
  assert.equal(v.parsed, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// (j) Every ProgressEvent is persisted to runDir/events.jsonl (SPEC §10), not just
//     buffered in-memory / fanned to onEvent.
// ────────────────────────────────────────────────────────────────────────────

test("(j) events.jsonl is appended to disk with the full lifecycle", async () => {
  const baseDir = uniqueRunDir("j");
  const script = `${META}\nphase('Scan');\nconst t = await agent('persist my events', { executor: 'fake' });\nreturn t;\n`;
  const res = await runWorkflow({ script, executors: { fake: fakeExecutor }, runDir: baseDir });

  const eventsPath = path.join(baseDir, res.runId, "events.jsonl");
  const raw = await readFile(eventsPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);

  assert.ok(types.includes("run_start"), "events.jsonl should include run_start");
  assert.ok(types.includes("phase_start"), "events.jsonl should include phase_start");
  assert.ok(types.includes("agent_start"), "events.jsonl should include agent_start");
  assert.ok(types.includes("agent_end"), "events.jsonl should include agent_end");
  assert.ok(types.includes("run_end"), "events.jsonl should include run_end");
  // On-disk events match the in-memory events array length.
  assert.equal(lines.length, res.events.length);
});

// ────────────────────────────────────────────────────────────────────────────
// (k) resume: a second run against the same baseDir replays unchanged (prompt,opts)
//     agent() results from the journal — zero executor calls, zero token spend.
// ────────────────────────────────────────────────────────────────────────────

test("(k) resume replays cached agent results with zero spend on the second run", async () => {
  const baseDir = uniqueRunDir("k");
  let calls = 0;
  const countingExecutor: Executor = async (o) => {
    calls += 1;
    return makeFakeResult(o);
  };
  const script = `${META}\nconst a = await agent('first', { executor: 'fake' });\nconst b = await agent('second', { executor: 'fake' });\nreturn [a, b];\n`;

  const r1 = await runWorkflow({ script, executors: { fake: countingExecutor }, runDir: baseDir });
  assert.equal(calls, 2, "first run spawns both agents");
  assert.equal(r1.tokensSpent, 10, "first run spends 2 × 5 output tokens");

  const callsAfterFirst = calls;
  const r2 = await runWorkflow({
    script,
    executors: { fake: countingExecutor },
    runDir: baseDir,
    resumeFromRunId: r1.runId,
  });
  assert.equal(calls, callsAfterFirst, "resume makes NO new executor calls");
  assert.equal(r2.tokensSpent, 0, "resume spends zero tokens (full cache hit)");

  const v1 = r1.value as string[];
  const v2 = r2.value as string[];
  assert.equal(v2[0], v1[0]);
  assert.equal(v2[1], v1[1]);
});

// ────────────────────────────────────────────────────────────────────────────
// (l) cancellation: aborting RunOptions.signal mid-run kills in-flight agents, makes
//     parallel() re-throw (run rejects), and surfaces a `skipped` agent_end event.
// ────────────────────────────────────────────────────────────────────────────

test("(l) RunOptions.signal aborts an in-flight run; parallel re-throws + emits skipped", async () => {
  const controller = new AbortController();
  // Resolves only after a long delay, but rejects promptly when its signal aborts —
  // standing in for a real `claude --print` subprocess that gets SIGKILLed.
  const slowExecutor: Executor = (o) =>
    new Promise<ExecResult>((resolve, reject) => {
      if (o.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timer = setTimeout(() => resolve(makeFakeResult(o)), 5_000);
      o.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

  const events: ProgressEvent[] = [];
  const script = `${META}\nreturn await parallel([() => agent('a', { executor: 'fake' }), () => agent('b', { executor: 'fake' })]);\n`;
  const p = runWorkflow({
    script,
    executors: { fake: slowExecutor },
    runDir: uniqueRunDir("l"),
    signal: controller.signal,
    onEvent: (e) => {
      events.push(e);
    },
  });

  setTimeout(() => controller.abort(), 50);

  await assert.rejects(p, /aborted/);
  assert.ok(
    events.some((e) => e.type === "agent_end" && e.skipped === true),
    "a cancelled agent emits agent_end{skipped:true}",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// (m) per-node routing: with two distinguishable executors registered, each agent()
//     dispatches to the one named by its {executor} — the choice is per-call, not per-run.
// ────────────────────────────────────────────────────────────────────────────

test("(m) per-node {executor} routes each agent() to its named executor", async () => {
  // Two fakes with distinct text prefixes so we can prove which one handled each call.
  const fakeA: Executor = async (o) => ({ ...makeFakeResult(o), text: "A:" + o.prompt });
  const fakeB: Executor = async (o) => ({ ...makeFakeResult(o), text: "B:" + o.prompt });

  const script = `${META}
const a = await agent('routed to a', { executor: 'a' });
const b = await agent('routed to b', { executor: 'b' });
return [a, b];
`;
  const res = await runWorkflow(
    opts("m", script, { executors: { a: fakeA, b: fakeB } }),
  );
  // Each call hit the executor named in its own options, not a single per-run default.
  // NB: the script's `return [a, b]` literal carries the vm context's Array.prototype, so a
  // direct deepStrictEqual against a host-realm literal fails on prototype identity (see test (i),
  // lines 321-325). Spread into a host-realm array to compare element values across realms.
  assert.deepEqual([...(res.value as unknown[])], ["A:routed to a", "B:routed to b"]);
});

// ────────────────────────────────────────────────────────────────────────────
// (n) missing executor: agent() with no {executor} → runWorkflow rejects (no default,
//     fail fast). TS allows the call (opts is optional), so the runtime enforces it.
// ────────────────────────────────────────────────────────────────────────────

test("(n) agent() with no executor rejects the run (executor is required)", async () => {
  // No {executor} on the call at all — the registered 'fake' is never named.
  const script = `${META}\nreturn await agent('no executor named here');\n`;
  await assert.rejects(runWorkflow(opts("n", script)), /executor/i);
});

// ────────────────────────────────────────────────────────────────────────────
// (o) unknown executor name: {executor:'nope'} that isn't in the registry → rejects.
// ────────────────────────────────────────────────────────────────────────────

test("(o) agent() naming an unregistered executor rejects the run", async () => {
  // 'fake' is registered (by opts()), but the call asks for 'nope', which is not.
  const script = `${META}\nreturn await agent('pick an unknown one', { executor: 'nope' });\n`;
  await assert.rejects(runWorkflow(opts("o", script)), /nope/);
});

// ────────────────────────────────────────────────────────────────────────────
// (p) executor-neutral replay (SPEC §9): the journal stores only the reduced result, so
//     resume replays from disk and NEVER invokes any executor. We prove it by resuming
//     with an executor that throws on call — the resumed run still succeeds with zero spend.
// ────────────────────────────────────────────────────────────────────────────

test("(p) resume is executor-neutral: replays from journal without invoking the executor", async () => {
  const baseDir = uniqueRunDir("p");
  const script = `${META}\nconst a = await agent('codex first', { executor: 'codex' });\nconst b = await agent('codex second', { executor: 'codex' });\nreturn [a, b];\n`;

  // First run: a normal fake registered under the name the script asks for ('codex').
  const fakeCodex: Executor = async (o) => makeFakeResult(o);
  const r1 = await runWorkflow({ script, executors: { codex: fakeCodex }, runDir: baseDir });
  assert.equal(r1.tokensSpent, 10, "first run spends 2 × 5 output tokens");

  // Resume with an executor that throws if ever called. If replay touched the executor,
  // the run would reject; instead it must replay the recorded results from the journal.
  let throwingCalls = 0;
  const throwingExecutor: Executor = async () => {
    throwingCalls += 1;
    throw new Error("executor must NOT be invoked during a journal replay");
  };
  const r2 = await runWorkflow({
    script,
    executors: { codex: throwingExecutor },
    runDir: baseDir,
    resumeFromRunId: r1.runId,
  });

  assert.equal(throwingCalls, 0, "resume invokes the executor zero times");
  assert.equal(r2.tokensSpent, 0, "resume spends zero tokens (full cache hit)");
  // Both runs return `[a, b]` literals built in their own vm realms, so each carries that
  // realm's Array.prototype — a direct deepStrictEqual fails on prototype identity (see test (i),
  // lines 321-325). Spread both into host-realm arrays to compare the replayed element values.
  assert.deepEqual(
    [...(r2.value as unknown[])],
    [...(r1.value as unknown[])],
    "resume reproduces the first run's value verbatim",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// (q) default on-disk layout (multi-script): each workflow is self-contained at
//     <cwd>/.odw/<slug>/ — runs land under <slug>/runs/<runId>/, grouped by the
//     --name used to launch, so a script and its runs stay in one folder.
// ────────────────────────────────────────────────────────────────────────────

test("(q) default layout groups a run under .odw/<name>/runs/<runId>", async () => {
  // A throwaway project cwd with one authored workflow at .odw/<name>/script.js.
  const cwd = await mkdtemp(path.join(os.tmpdir(), "odw-layout-"));
  const name = "demo-flow";
  await mkdir(path.join(cwd, ".odw", name), { recursive: true });
  await writeFile(
    path.join(cwd, ".odw", name, "script.js"),
    `${META}\nconst t = await agent('hi', { executor: 'fake' });\nreturn t;\n`,
  );

  // Launch by name with no runDir override → the default slug-grouped layout applies.
  // slug = the --name used to launch (here 'demo-flow'), even though meta.name is 'smoke'.
  const res = await runWorkflow({ name, cwd, executors: { fake: fakeExecutor } });

  const runDir = path.join(cwd, ".odw", name, "runs", res.runId);
  const journal = await readFile(path.join(runDir, "journal.jsonl"), "utf8");
  assert.ok(journal.trim().length > 0, "journal.jsonl lives under .odw/<name>/runs/<runId>/");
  assert.equal(res.value, "FAKE:hi");
});

// ────────────────────────────────────────────────────────────────────────────
// (r) a failing agent surfaces the executor's REASON (res.text), not just the subtype —
//     so a usage-limit / auth death reads as a real message in the error + agent_end.
// ────────────────────────────────────────────────────────────────────────────

test("(r) a failing agent surfaces the executor's reason in the error + agent_end event", async () => {
  const failing: Executor = async () => ({
    text: "You've hit your usage limit. Try again later.",
    sessionId: null,
    costUsd: 0,
    durationMs: 1,
    resultSubtype: "error_during_execution",
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
  });

  const events: ProgressEvent[] = [];
  const script = `${META}\nreturn await agent('do thing', { executor: 'boom' });\n`;
  await assert.rejects(
    runWorkflow({
      script,
      executors: { boom: failing },
      runDir: uniqueRunDir("r"),
      onEvent: (e) => events.push(e),
    }),
    /usage limit/i,
  );

  // the agent_end event carries the same reason, so the progress tree renders it.
  assert.ok(
    events.some(
      (e) => e.type === "agent_end" && e.ok === false && /usage limit/i.test(e.error ?? ""),
    ),
    "agent_end.error should include the executor's reason",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// (s) agentType reaches the executor verbatim, so an executor can enforce it as a
//     CLI-level permission (the gemini executor runs Explore/Plan read-only).
// ────────────────────────────────────────────────────────────────────────────

test("(s) agentType is passed through to the executor alongside its preset", async () => {
  const seen: Array<{ agentType: string | undefined; preset: string | undefined }> = [];
  const recording: Executor = async (o) => {
    seen.push({ agentType: o.agentType, preset: o.appendSystemPrompt });
    return makeFakeResult(o);
  };
  const script = `${META}
await agent('look around', { executor: 'rec', agentType: 'Explore' });
await agent('change things', { executor: 'rec' });
return 'ok';
`;
  await runWorkflow({ script, executors: { rec: recording }, runDir: uniqueRunDir("s") });
  assert.equal(seen[0]?.agentType, "Explore");
  assert.match(seen[0]?.preset ?? "", /read-only/);
  assert.equal(seen[1]?.agentType, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// (t) run_start announces where the run lives, so hosts (the CLI snapshot) can act
//     before any agent starts.
// ────────────────────────────────────────────────────────────────────────────

test("(t) run_start carries the absolute runDir", async () => {
  const events: ProgressEvent[] = [];
  const runDir = uniqueRunDir("t");
  const res = await runWorkflow({
    script: `${META}\nreturn 1;\n`,
    executors: { fake: fakeExecutor },
    runDir,
    onEvent: (e) => events.push(e),
  });
  const start = events.find((e) => e.type === "run_start");
  assert.ok(start && start.type === "run_start");
  assert.equal(start.runDir, path.join(runDir, res.runId));
});
