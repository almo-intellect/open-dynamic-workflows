// gemini.test.ts — the gemini executor end to end against a FAKE `gemini` (a small node
// script that speaks stream-json), so argv mapping, permissions, repair turns, retries and
// the edit-safety rule are tested deterministically: no network, no real Gemini CLI.
//
// Run: npx tsx --test src/executor/gemini/gemini.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExecOptions } from "../../types.js";
import {
  buildGeminiArgs,
  buildGeminiPrompt,
  createGeminiExecutor,
  resolveGeminiModel,
  type GeminiExecutorOptions,
} from "./gemini.js";

// The fake CLI: each call takes the next step of FAKE_GEMINI_PLAN (the last one repeats),
// echoes --resume's session id (or invents sess-N), and logs {argv, input} per call.
const FAKE_GEMINI = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const statePath = process.env.FAKE_GEMINI_STATE;
  const plan = JSON.parse(process.env.FAKE_GEMINI_PLAN);
  const n = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).calls : 0;
  writeFileSync(statePath, JSON.stringify({ calls: n + 1 }));
  appendFileSync(process.env.FAKE_GEMINI_LOG, JSON.stringify({ argv, input }) + "\n");
  const step = plan[Math.min(n, plan.length - 1)];
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const session = at("--resume") ?? "sess-" + (n + 1);
  const model = at("--model") ?? "gemini-default";
  const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
  const stats = (m) => ({ total_tokens: 15, input_tokens: 10, output_tokens: 5, cached: 0, input: 10,
    duration_ms: 1, tool_calls: 0, models: { [m]: { total_tokens: 15, input_tokens: 10, output_tokens: 5, cached: 0, input: 10 } } });
  const init = () => out({ type: "init", session_id: session, model });
  const say = (t) => out({ type: "message", role: "assistant", content: t, delta: true });
  const done = (m = model) => out({ type: "result", status: "success", stats: stats(m) });
  switch (step) {
    case "ok-text": init(); say("all done"); done(); break;
    case "ok-json": init(); say('{"ok":'); say("true}"); done(); break;
    case "bad-json": init(); say('Here you go: {"ok": tru'); done(); break;
    case "schema-miss": init(); say('{"ok":"yes"}'); done(); break;
    case "loop": init(); say('{"ok": "======'); out({ type: "error", severity: "warning", message: "Loop detected, stopping execution" }); done(); break;
    case "fallback": init(); say('{"ok":true}'); done("gemini-2.5-flash"); break;
    case "crash": process.stderr.write("Error: EBUSY: resource busy or locked, open settings.json\n"); process.exitCode = 1; break;
    case "auth": process.stderr.write('[ERROR] {\n  "error": {\n    "type": "FatalAuthenticationError",\n    "message": "API key not valid."\n  }\n}\n'); process.exitCode = 41; break;
    case "mutate-then-die":
      init();
      out({ type: "tool_use", tool_name: "write_file", tool_id: "w1", parameters: { file_path: "x.txt" } });
      out({ type: "tool_result", tool_id: "w1", status: "success", output: "ok" });
      process.stderr.write("Error: read ECONNRESET\n");
      process.exitCode = 1;
      break;
    default: process.stderr.write("unknown step " + step + "\n"); process.exitCode = 3;
  }
});
`;

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

interface Harness {
  run: (opts?: Partial<ExecOptions>) => ReturnType<ReturnType<typeof createGeminiExecutor>>;
  calls: () => Array<{ argv: string[]; input: string }>;
  dir: string;
}

function harness(plan: string[], extra: GeminiExecutorOptions = {}): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "odw-gemini-"));
  const fake = path.join(dir, "fake-gemini.mjs");
  writeFileSync(fake, FAKE_GEMINI);
  const log = path.join(dir, "calls.jsonl");
  const exec = createGeminiExecutor({
    command: process.execPath,
    commandArgs: [fake],
    retryDelayMs: 0,
    spawnGapMs: 0,
    ...extra,
    env: {
      FAKE_GEMINI_PLAN: JSON.stringify(plan),
      FAKE_GEMINI_STATE: path.join(dir, "state.json"),
      FAKE_GEMINI_LOG: log,
    },
  });
  return {
    dir,
    run: (opts = {}) =>
      exec({ prompt: "do the task", cwd: dir, tracePath: path.join(dir, "agent-1.jsonl"), ...opts }),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l) as { argv: string[]; input: string })
        : [],
  };
}

const flagValue = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

// ── pure helpers ────────────────────────────────────────────────────────────

test("buildGeminiArgs: read-only vs edit approval modes; never yolo", () => {
  const base: ExecOptions = { prompt: "p", cwd: "." };
  const ro = buildGeminiArgs({ ...base, model: "m" }, { readOnly: true, policyPaths: ["/p.toml"], extensions: ["none"] });
  assert.deepEqual(ro, [
    "--output-format",
    "stream-json",
    "--approval-mode",
    "default",
    "--model",
    "m",
    "--extensions",
    "none",
    "--policy",
    "/p.toml",
  ]);
  const edit = buildGeminiArgs({ ...base, resumeSessionId: "s1" }, { readOnly: false, policyPaths: [], extensions: [] });
  assert.equal(flagValue(edit, "--approval-mode"), "auto_edit");
  assert.equal(flagValue(edit, "--resume"), "s1");
  for (const argv of [ro, edit]) {
    assert.ok(!argv.includes("--yolo") && !argv.includes("yolo"), "INVARIANT: never yolo");
  }
});

test("buildGeminiPrompt: preset, permission note, prompt, schema — a leading '/' can never start the input", () => {
  const prompt = buildGeminiPrompt(
    { prompt: "/deploy now", cwd: ".", appendSystemPrompt: "PRESET", schema: SCHEMA },
    true,
  );
  assert.ok(prompt.startsWith("PRESET\n\n[odw]"));
  assert.ok(prompt.includes("READ-ONLY"));
  assert.ok(prompt.includes("/deploy now"));
  assert.ok(prompt.includes('"required":["ok"]'));
  assert.ok(!buildGeminiPrompt({ prompt: "/x", cwd: "." }, false).startsWith("/"));
});

test("resolveGeminiModel: aliases, defaults, allowlist", () => {
  const cfg = {
    modelAliases: { flash: "gemini-3.8-flash" },
    allowedModels: ["gemini-3.8-flash"],
    defaultModel: "flash",
  };
  assert.equal(resolveGeminiModel(undefined, cfg), "gemini-3.8-flash");
  assert.equal(resolveGeminiModel("flash", cfg), "gemini-3.8-flash");
  assert.throws(() => resolveGeminiModel("gemini-2.5-pro", cfg), /not allowed/);
  assert.equal(resolveGeminiModel(undefined, {}), undefined);
});

// ── end to end against the fake CLI ─────────────────────────────────────────

test("success: schema answer parsed; Explore runs read-only, no agentType runs auto_edit; extensions off", async () => {
  const h = harness(["ok-json"]);
  const res = await h.run({ schema: SCHEMA, agentType: "Explore", model: "gemini-3.8-flash" });
  assert.equal(res.isError, false);
  assert.deepEqual(res.structuredOutput, { ok: true });
  const [call] = h.calls();
  assert.equal(flagValue(call!.argv, "--approval-mode"), "default");
  assert.equal(flagValue(call!.argv, "--extensions"), "none");
  assert.equal(flagValue(call!.argv, "--output-format"), "stream-json");
  assert.match(call!.input, /READ-ONLY/);

  const h2 = harness(["ok-text"]);
  const res2 = await h2.run();
  assert.equal(res2.text, "all done");
  assert.equal(flagValue(h2.calls()[0]!.argv, "--approval-mode"), "auto_edit");
});

test("invalid JSON is repaired by resuming the same session (no fresh run)", async () => {
  const h = harness(["bad-json", "ok-json"]);
  const res = await h.run({ schema: SCHEMA });
  assert.equal(res.isError, false);
  assert.deepEqual(res.structuredOutput, { ok: true });
  const calls = h.calls();
  assert.equal(calls.length, 2);
  assert.equal(flagValue(calls[0]!.argv, "--resume"), undefined);
  assert.equal(flagValue(calls[1]!.argv, "--resume"), "sess-1");
  assert.match(calls[1]!.input, /could not be used/);
  assert.ok(existsSync(path.join(h.dir, "agent-1.jsonl")), "first attempt trace");
  assert.ok(existsSync(path.join(h.dir, "agent-1.attempt-2.jsonl")), "repair attempt keeps its own trace");
});

test("a loop-detector truncation is repaired the same way", async () => {
  const h = harness(["loop", "ok-json"]);
  const res = await h.run({ schema: SCHEMA });
  assert.equal(res.isError, false);
  assert.equal(flagValue(h.calls()[1]!.argv, "--resume"), "sess-1");
});

test("JSON that parses but misses the schema gets a repair turn too", async () => {
  const h = harness(["schema-miss", "ok-json"]);
  const res = await h.run({ schema: SCHEMA });
  assert.equal(res.isError, false);
  assert.match(h.calls()[1]!.input, /does not match the schema/);
});

test("a startup crash (no session yet) is retried with a fresh process", async () => {
  const h = harness(["crash", "ok-text"]);
  const res = await h.run();
  assert.equal(res.isError, false);
  const calls = h.calls();
  assert.equal(calls.length, 2);
  assert.equal(flagValue(calls[1]!.argv, "--resume"), undefined);
});

test("fatal errors are not retried and keep their reason", async () => {
  const h = harness(["auth", "ok-text"]);
  const res = await h.run();
  assert.equal(res.isError, true);
  assert.equal(res.resultSubtype, "error_fatal");
  assert.match(res.text, /API key not valid/);
  assert.equal(h.calls().length, 1);
});

test("an edit agent that changed files and then died is resumed, never restarted", async () => {
  const h = harness(["mutate-then-die", "ok-text"]);
  const res = await h.run();
  assert.equal(res.isError, false);
  const second = h.calls()[1]!;
  assert.equal(flagValue(second.argv, "--resume"), "sess-1");
  assert.match(second.input, /do not repeat changes that were already applied/);
});

test("a model outside the allowlist fails before anything is spawned", async () => {
  const h = harness(["ok-text"], { allowedModels: ["gemini-3.8-flash"] });
  await assert.rejects(h.run({ model: "gemini-2.5-pro" }), /not allowed/);
  assert.equal(h.calls().length, 0);
});

test("a silent fallback to another model is caught when an allowlist is set", async () => {
  const h = harness(["fallback"], { allowedModels: ["gemini-3.8-flash"] });
  const res = await h.run({ model: "gemini-3.8-flash", schema: SCHEMA });
  assert.equal(res.isError, true);
  assert.equal(res.resultSubtype, "error_model_fallback");
  assert.equal(h.calls().length, 1);
});

test("attempts are bounded; the error names the last reason and the attempt history", async () => {
  const h = harness(["bad-json"], { maxAttempts: 3 });
  const res = await h.run({ schema: SCHEMA });
  assert.equal(res.isError, true);
  assert.equal(h.calls().length, 3);
  assert.match(res.text, /not a JSON object/);
  assert.match(res.text, /#1 error_invalid_json → #2 resumed error_invalid_json → #3 resumed error_invalid_json/);
  assert.equal(res.usage.outputTokens, 15, "usage adds up across attempts");
});
