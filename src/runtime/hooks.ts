// hooks.ts — the orchestration hooks (agent/parallel/pipeline/phase/log/args/
// workflow) bound to a single RunContext. See SPEC §4, §5, §12.
//
// All "framework config" (cwd, model, semaphore, abort, journal) is captured
// here via the ctx + deps closure; the workflow script sees only the ScriptHooks shape.

import { execFileSync } from "node:child_process";
import path from "node:path";

import type {
  AgentOptions,
  AgentRecord,
  ExecOptions,
  RunContext,
  ScriptHooks,
  Thunk,
  WorkflowRef,
} from "../types.js";
import { keyFor } from "../journal/journal.js";
import { assertObjectRootSchema, validateAgainstSchema } from "../schema/validate.js";
import type { Semaphore } from "./semaphore.js";

export interface HookDeps {
  semaphore: Semaphore;
  runNested: (ref: WorkflowRef, args: unknown) => Promise<unknown>;
  args: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// agentType → system-prompt preset (SPEC §4). Built-in map; unknown → warn once.
// ────────────────────────────────────────────────────────────────────────────

const AGENT_TYPE_PRESETS: Readonly<Record<string, string>> = {
  Explore:
    "You are a read-only exploration subagent. Investigate and report findings; do not modify files.",
  Plan: "You are a planning subagent. Produce a concrete, ordered plan; do not modify files.",
  General: "You are a general-purpose subagent.",
};

const warnedAgentTypes = new Set<string>();

function presetFor(agentType?: string): string | undefined {
  if (agentType === undefined) return undefined;
  const preset = AGENT_TYPE_PRESETS[agentType];
  if (preset !== undefined) return preset;
  if (!warnedAgentTypes.has(agentType)) {
    warnedAgentTypes.add(agentType);
    console.warn(`[hooks] unknown agentType "${agentType}" — falling back to default system prompt`);
  }
  return undefined;
}

const nowIso = (): string => new Date().toISOString();

// Collapse whitespace + truncate so an executor's failure reason (a turn.failed message or
// a multi-line stderr tail, surfaced into ExecResult.text) embeds cleanly into the thrown
// Error and the agent_end event the progress tree renders — a real reason, not just a subtype.
function oneLine(s: string, max = 300): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Best-effort temp git worktree for isolation:"worktree". Returns the worktree dir, or
// null on any git failure (caller then falls back to ctx.cwd with a warning).
function createWorktree(repoCwd: string, runDir: string, agentId: number): string | null {
  const wtDir = path.join(runDir, "worktrees", `agent-${agentId}`);
  const branch = `wf-agent-${agentId}`;
  try {
    execFileSync("git", ["worktree", "add", "--detach", "-b", branch, wtDir], {
      cwd: repoCwd,
      stdio: "ignore",
    });
    return wtDir;
  } catch (err) {
    console.warn(`[hooks] isolation:"worktree" failed for agent ${agentId}: ${String(err)} — using cwd`);
    return null;
  }
}

// Remove the worktree iff it has no uncommitted changes (`git status --porcelain` empty).
function cleanupWorktree(repoCwd: string, wtDir: string): void {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: wtDir,
      encoding: "utf8",
    });
    if (status.trim() !== "") return; // dirty → keep for inspection
    execFileSync("git", ["worktree", "remove", "--force", wtDir], {
      cwd: repoCwd,
      stdio: "ignore",
    });
  } catch (err) {
    console.warn(`[hooks] worktree cleanup failed for ${wtDir}: ${String(err)}`);
  }
}

export function createHooks(ctx: RunContext, deps: HookDeps): ScriptHooks {
  const agent = async (prompt: string, opts?: AgentOptions): Promise<unknown> => {
    // `executor` is required in the public AgentOptions type, but the runtime must still
    // tolerate `agent(prompt)` with no opts at all so it can fail fast with a helpful
    // message (INVARIANT #10 — no default executor). Model the fallback as Partial so the
    // "missing executor" path stays reachable and type-checks (o.executor is then string | undefined).
    const o: Partial<AgentOptions> = opts ?? {};
    const key = keyFor(prompt, o);
    const id = ctx.nextAgentId();
    const label = o.label ?? prompt.slice(0, 60);
    const phase = o.phase ?? ctx.currentPhase.value;

    // RESUME: a cached record for this content key → return instantly, no spend.
    const cached = ctx.takeCached(key);
    if (cached !== undefined) {
      ctx.emit({ type: "agent_start", agentId: id, label, phase, cached: true, ts: nowIso() });
      ctx.emit({
        type: "agent_end",
        agentId: id,
        label,
        phase,
        ok: true,
        cached: true,
        costUsd: 0,
        outputTokens: 0,
        durationMs: 0,
        ts: nowIso(),
      });
      const rec: AgentRecord = { ...cached, index: id, cached: true };
      ctx.record(rec);
      return cached.result;
    }

    if (o.schema !== undefined) assertObjectRootSchema(o.schema);

    await deps.semaphore.acquire();
    ctx.emit({ type: "agent_start", agentId: id, label, phase, cached: false, ts: nowIso() });

    let worktreeDir: string | null = null;
    try {
      let cwd = ctx.cwd;
      if (o.isolation === "worktree") {
        worktreeDir = createWorktree(ctx.cwd, ctx.runDir, id);
        if (worktreeDir !== null) cwd = worktreeDir;
      }

      const resolvedModel = o.model ?? ctx.defaultModel;
      const appendSystemPrompt = presetFor(o.agentType);
      const execOpts: ExecOptions = {
        prompt,
        cwd,
        signal: ctx.abort,
        tracePath: path.join(ctx.runDir, "agents", `agent-${id}.jsonl`),
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(o.schema !== undefined ? { schema: o.schema } : {}),
        ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
        ...(o.agentType !== undefined ? { agentType: o.agentType } : {}),
        ...(ctx.agentTimeoutMs !== undefined ? { timeoutMs: ctx.agentTimeoutMs } : {}),
      };

      // Resolve the executor by name from the run's registry. No default: a missing
      // or unknown name fails fast (INVARIANT — never silently fall back). This throw
      // sits inside the try after semaphore.acquire(), so it unwinds through catch:
      // agent_end{ok:false} is emitted and the semaphore is released in finally.
      if (!o.executor) {
        throw new Error(
          `agent() requires an 'executor' (one of: ${Object.keys(ctx.executors).join(", ")})`,
        );
      }
      const executor = ctx.executors[o.executor];
      if (executor === undefined) {
        throw new Error(
          `unknown executor "${o.executor}" (registered: ${Object.keys(ctx.executors).join(", ")})`,
        );
      }

      const res = await executor(execOpts);
      ctx.addTokens(res.usage.outputTokens);

      let value: unknown;
      if (o.schema !== undefined) {
        if (
          res.structuredOutput !== undefined &&
          validateAgainstSchema(o.schema, res.structuredOutput).ok
        ) {
          value = res.structuredOutput;
        } else {
          throw new Error(
            `structured output failed (subtype=${res.resultSubtype})` +
              (res.text ? `: ${oneLine(res.text)}` : ""),
          );
        }
      } else {
        value = res.text;
      }

      if (res.isError && res.resultSubtype !== "success") {
        throw new Error(
          `agent failed (subtype=${res.resultSubtype})` +
            (res.text ? `: ${oneLine(res.text)}` : ""),
        );
      }

      ctx.emit({
        type: "agent_end",
        agentId: id,
        label,
        phase,
        ok: true,
        cached: false,
        costUsd: res.costUsd,
        outputTokens: res.usage.outputTokens,
        durationMs: res.durationMs,
        ts: nowIso(),
      });

      ctx.record({
        index: id,
        key,
        label,
        phase,
        result: value,
        cached: false,
        outputTokens: res.usage.outputTokens,
        ts: nowIso(),
      });
      return value;
    } catch (e) {
      const aborted = ctx.abort.aborted;
      ctx.emit({
        type: "agent_end",
        agentId: id,
        label,
        phase,
        ok: false,
        cached: false,
        ...(aborted ? { skipped: true } : {}),
        costUsd: 0,
        outputTokens: 0,
        durationMs: 0,
        error: String(e),
        ts: nowIso(),
      });
      throw e;
    } finally {
      deps.semaphore.release();
      if (worktreeDir !== null) cleanupWorktree(ctx.cwd, worktreeDir);
    }
  };

  // parallel — BARRIER, failure→null, order preserved (SPEC §4). On abort it RE-THROWS
  // instead of swallowing: each thunk settles to null (no unhandled rejection), then the
  // post-barrier abort check throws so a cancelled run unwinds rather than filling nulls.
  const parallel = async (thunks: ReadonlyArray<Thunk>): Promise<Array<unknown>> => {
    const results = await Promise.all(
      thunks.map((t) => Promise.resolve().then(t).catch(() => null)),
    );
    if (ctx.abort.aborted) throw new Error("workflow aborted");
    return results;
  };

  // pipeline — independent per-item chains, NO inter-stage barrier (SPEC §4 / §12).
  // A throwing stage rejects its chain → subsequent .then skip → chain resolves null.
  // Like parallel, it re-throws on abort after the final collect.
  const pipeline: ScriptHooks["pipeline"] = async (items, ...stages) => {
    const chains = items.map((item, idx) => {
      const chain = stages.reduce<Promise<unknown>>(
        (p, st) => p.then((prev) => st(prev, item, idx)),
        Promise.resolve(item),
      );
      return chain.catch(() => null);
    });
    const results = await Promise.all(chains);
    if (ctx.abort.aborted) throw new Error("workflow aborted");
    return results;
  };

  const phase = (title: string): void => {
    ctx.currentPhase.value = title;
    ctx.emit({ type: "phase_start", phase: title, ts: nowIso() });
  };

  const log = (message: string): void => {
    ctx.emit({ type: "log", message, phase: ctx.currentPhase.value, ts: nowIso() });
  };

  const workflow = (ref: WorkflowRef, args?: unknown): Promise<unknown> =>
    deps.runNested(ref, args);

  return {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    args: deps.args,
    workflow,
  };
}
