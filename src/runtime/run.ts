// run.ts — runWorkflow(): the INTEGRATOR.
//
// Wires sandbox (meta + script) + hooks + executor + journal + progress into one run
// (SPEC §2, §5, §9, §10). Resolves the script source, opens the journal, builds the
// shared concurrency/agent/abort primitives, then drives the (possibly nested)
// script under a single RunContext. workflow() nesting is one level only (SPEC §4).

import os from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  RunOptions,
  WorkflowResult,
  RunContext,
  ProgressEvent,
  WorkflowMeta,
  EventSink,
  WorkflowRef,
} from "../types.js";
import { TOTAL_AGENT_CAP } from "../types.js";
import { extractMeta, runScript } from "./sandbox.js";
import { createHooks } from "./hooks.js";
import { createSemaphore, createCounter } from "./semaphore.js";
import { openJournal } from "../journal/journal.js";

const now = (): string => new Date().toISOString();

/** Resolve a registry workflow source by name, trying `.js` then `.mjs`. */
export async function readRegistryScript(
  registryDir: string,
  name: string,
): Promise<{ source: string; ext: string }> {
  // Each workflow is a self-contained folder: <registryDir>/<name>/script.{js,mjs}.
  for (const ext of ["js", "mjs"] as const) {
    try {
      const source = await readFile(path.join(registryDir, name, `script.${ext}`), "utf8");
      return { source, ext };
    } catch {
      // try next extension
    }
  }
  throw new Error(
    `cannot resolve workflow "${name}" — expected ${path.join(registryDir, name, "script.js")} (or script.mjs)`,
  );
}

/** Sanitize a workflow name into a filesystem-safe folder slug (its self-contained home). */
function workflowSlug(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return s.length > 0 ? s : "workflow";
}

/** Resolve the top-level script source + extension by precedence: scriptPath → script → name. */
async function resolveSource(
  options: RunOptions,
  registryDir: string,
): Promise<{ source: string; ext: string }> {
  if (options.scriptPath !== undefined) {
    const source = await readFile(options.scriptPath, "utf8");
    const ext = path.extname(options.scriptPath).replace(/^\./, "") || "js";
    return { source, ext };
  }
  if (options.script !== undefined) {
    return { source: options.script, ext: "js" };
  }
  if (options.name !== undefined) {
    // Named scripts resolve from the registry dir (defaults to <cwd>/.odw).
    return readRegistryScript(registryDir, options.name);
  }
  throw new Error("runWorkflow requires one of: scriptPath, script, or name");
}

export async function runWorkflow(options: RunOptions): Promise<WorkflowResult> {
  // (1) Resolve top-level source + extension.
  // Each workflow gets a self-contained home <cwd>/.odw/<slug>/: the authored script
  // (script.{js,mjs}) plus all its runs under runs/<runId>/. registryDir is the .odw root.
  const cwd = options.cwd ?? process.cwd();
  const registryDir = options.registryDir ?? path.join(cwd, ".odw");
  const { source, ext } = await resolveSource(options, registryDir);

  // Extract meta early — its name (or the --name used to launch) is the slug that keeps
  // this workflow's script and runs together in one folder.
  const meta: WorkflowMeta = extractMeta(source);
  const slug = workflowSlug(options.name ?? meta.name);

  // (2) Journal base dir: <cwd>/.odw/<slug>/runs (override with runDir).
  const baseDir = options.runDir ?? path.join(cwd, ".odw", slug, "runs");

  // (3) Open journal + persist the resolved script.
  const journal = await openJournal({
    baseDir,
    ...(options.resumeFromRunId !== undefined ? { resumeFromRunId: options.resumeFromRunId } : {}),
  });
  const persistedPath = await journal.persistScript(source, ext);

  // (4) Concurrency cap.
  const concurrency = options.concurrency ?? Math.max(1, Math.min(16, os.cpus().length - 2));

  // (5) Shared run primitives.
  const sem = createSemaphore(concurrency);
  const counter = createCounter(TOTAL_AGENT_CAP);
  // Run-level output-token tally — pure observability (reported as tokensSpent), no ceiling.
  let tokensSpent = 0;
  const abort = new AbortController();

  // Forward external cancellation (RunOptions.signal) into the run's shared abort, which
  // is what the executor watches to kill in-flight subprocesses.
  if (options.signal) {
    if (options.signal.aborted) abort.abort();
    else options.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  // (6) Event sink: accumulate + fan out to onEvent.
  const events: ProgressEvent[] = [];
  const emit: EventSink = (e) => {
    events.push(e);
    journal.appendEvent(e);
    options.onEvent?.(e);
  };

  // (7) Executor registry. Required and non-empty — there is NO default executor;
  // each agent() must name one by key (resolved in hooks.ts). Fail fast otherwise.
  const executors = options.executors;
  if (!executors || Object.keys(executors).length === 0) {
    throw new Error("runWorkflow requires a non-empty 'executors' map");
  }

  // Run a script body at a given nesting depth under a fresh RunContext that shares the
  // run-global primitives (semaphore, counter, abort, journal, emit).
  const runInternal = async (src: string, scriptArgs: unknown, depth: number): Promise<unknown> => {
    const ctx: RunContext = {
      runId: journal.runId,
      runDir: journal.runDir,
      cwd,
      executors,
      concurrency,
      depth,
      emit,
      abort: abort.signal,
      currentPhase: { value: null },
      nextAgentId: () => counter.next(),
      takeCached: (k) => journal.takeCached(k),
      record: (r) => journal.append(r),
      addTokens: (n) => {
        tokensSpent += n;
      },
      registryDir,
      ...(options.model !== undefined ? { defaultModel: options.model } : {}),
      ...(options.agentTimeoutMs !== undefined ? { agentTimeoutMs: options.agentTimeoutMs } : {}),
    };

    // workflow() — one level of nesting only; shares all run-global primitives.
    const runNested = async (ref: WorkflowRef, a?: unknown): Promise<unknown> => {
      if (depth >= 1) {
        throw new Error("workflow() nesting is one level only");
      }
      let childSource: string;
      if (typeof ref === "string") {
        childSource = (await readRegistryScript(registryDir, ref)).source;
      } else {
        childSource = await readFile(ref.scriptPath, "utf8");
      }
      const name = typeof ref === "string" ? ref : ref.scriptPath;

      emit({ type: "workflow_start", name, ts: now() });
      try {
        return await runInternal(childSource, a, depth + 1);
      } finally {
        emit({ type: "workflow_end", name, ok: true, ts: now() });
      }
    };

    const hooks = createHooks(ctx, { semaphore: sem, runNested, args: scriptArgs });
    return await runScript(src, hooks);
  };

  // TOP LEVEL.
  emit({ type: "run_start", runId: journal.runId, runDir: journal.runDir, meta, ts: now() });

  const startedAt = Date.now();
  let ok = true;
  let value: unknown;
  try {
    value = await runInternal(source, options.args, 0);
  } catch (err) {
    ok = false;
    const durationMs = Date.now() - startedAt;
    emit({
      type: "run_end",
      runId: journal.runId,
      ok,
      tokensSpent: tokensSpent,
      durationMs,
      ts: now(),
    });
    await journal.close();
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  emit({
    type: "run_end",
    runId: journal.runId,
    ok,
    tokensSpent: tokensSpent,
    durationMs,
    ts: now(),
  });
  await journal.close();

  return {
    runId: journal.runId,
    scriptPath: persistedPath,
    meta,
    value,
    events,
    tokensSpent: tokensSpent,
    agentCount: counter.count,
    durationMs,
  };
}
