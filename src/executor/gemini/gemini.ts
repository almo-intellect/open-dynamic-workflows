// executor/gemini/gemini.ts — the only module that touches `gemini` (Google Gemini CLI).
//
// Spawns `gemini --output-format stream-json`, feeds the prompt on stdin, and folds the
// event stream into an ExecResult. On top of the shared subprocess driver it adds what
// headless Gemini needs to be dependable inside a workflow:
//
//   - Permissions from agentType: Explore/Plan agents run read-only (`--approval-mode
//     default`, which headless Gemini turns into "deny edits and shell"); every other
//     agent gets `auto_edit`, the counterpart of claude's acceptEdits and codex's
//     workspace-write. Extensions (and the MCP servers they start) are off by default.
//   - Structured output: Gemini CLI has no --json-schema flag, so the schema travels in
//     the prompt and the answer is checked with ajv here.
//   - Recovery: a truncated, empty, or invalid final answer is repaired by resuming the
//     same session (`--resume <id>`), which keeps the work already done. Transient
//     failures (quota blips, network, crashes during startup) are retried with backoff,
//     resuming rather than restarting once the agent may have changed files.
//   - Staggered starts: many CLIs booting in the same millisecond race on ~/.gemini state.
//
// INVARIANT: never `--yolo` / `--approval-mode yolo`.

import path from "node:path";

import type { ExecOptions, ExecResult, Executor, JsonSchema } from "../../types.js";
import { validateAgainstSchema } from "../../schema/validate.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";
import {
  type GeminiOutcome,
  parseGeminiStreamLine,
  reduceGeminiStreamEvents,
} from "./gemini-stream.js";

/** agentTypes that run read-only unless configured otherwise. */
export const DEFAULT_READ_ONLY_AGENT_TYPES: readonly string[] = ["Explore", "Plan"];

export interface GeminiExecutorOptions {
  /** CLI to spawn. Default "gemini" (resolved through PATH and npm shims). */
  command?: string;
  /** Args placed before ours, e.g. a test double's script path. */
  commandArgs?: string[];
  /** Gemini policy files (TOML) passed as `--policy`. Applied to every agent; scope rules with `modes`. */
  policyPaths?: string[];
  /** `--extensions` values. Default ["none"]; [] keeps Gemini CLI's own default (all installed). */
  extensions?: string[];
  /** Short name → model id, applied before the allowlist (e.g. { flash: "gemini-3.8-flash" }). */
  modelAliases?: Record<string, string>;
  /** When non-empty, any other model fails the agent before anything is spawned. */
  allowedModels?: string[];
  /** Model for agents that name none (and no run-level --model). Default: Gemini CLI's choice. */
  defaultModel?: string;
  /** agentTypes that run read-only. Default ["Explore", "Plan"]. */
  readOnlyAgentTypes?: string[];
  /** Attempts per agent, counting the first run and every retry or repair turn. Default 3. */
  maxAttempts?: number;
  /** Backoff before retrying a transient failure, in ms; doubles each time. Default 3000. */
  retryDelayMs?: number;
  /** Minimum gap between two Gemini process starts in this process, in ms. Default 400. */
  spawnGapMs?: number;
  /** Extra environment for every spawn. */
  env?: Record<string, string>;
}

const READ_ONLY_NOTE =
  "[odw] You are a headless sub-agent running READ-ONLY: edits and shell commands are " +
  "blocked by policy, so do not attempt them — investigate with read_file, grep_search, " +
  "glob and list_directory. Nobody can answer questions during the run.";

const EDIT_NOTE =
  "[odw] You are a headless sub-agent: you may change files with replace / write_file; " +
  "shell commands run only where the project's policy allows them. Nobody can answer " +
  "questions during the run — make reasonable assumptions and finish the task.";

const LOOP_HINT =
  "Keep it concise and avoid long runs of a repeated character (e.g. '=====' banners): " +
  "Gemini CLI's loop detector cuts such output short.";

/** Resolve aliases + defaults and enforce the allowlist. Throws on a disallowed model. */
export function resolveGeminiModel(
  requested: string | undefined,
  cfg: {
    modelAliases?: Record<string, string> | undefined;
    allowedModels?: readonly string[] | undefined;
    defaultModel?: string | undefined;
  },
): string | undefined {
  const raw = requested ?? cfg.defaultModel;
  if (raw === undefined || raw === "") return undefined;
  const model = cfg.modelAliases?.[raw] ?? raw;
  const allowed = cfg.allowedModels ?? [];
  if (allowed.length > 0 && !allowed.includes(model)) {
    throw new Error(`gemini: model "${raw}" is not allowed (allowed: ${allowed.join(", ")})`);
  }
  return model;
}

/**
 * Build the argv for `gemini` from ExecOptions. The prompt goes on stdin. Read-only agents
 * get `--approval-mode default`: headless Gemini denies every tool that would need a
 * confirmation (edits, shell, web fetch). Others get `auto_edit`. Never emits --yolo.
 */
export function buildGeminiArgs(
  opts: ExecOptions,
  cfg: { readOnly: boolean; policyPaths: readonly string[]; extensions: readonly string[] },
): string[] {
  const args = [
    "--output-format",
    "stream-json",
    "--approval-mode",
    cfg.readOnly ? "default" : "auto_edit",
  ];
  if (opts.model) args.push("--model", opts.model);
  for (const ext of cfg.extensions) args.push("--extensions", ext);
  for (const policy of cfg.policyPaths) args.push("--policy", policy);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  return args;
}

function schemaInstructions(schema: JsonSchema): string {
  return [
    "Final answer format: reply with ONLY one JSON object that conforms to the JSON Schema " +
      "below — no markdown fences, no text before or after it.",
    "Keep string values concise. Never put long code listings or long runs of a repeated " +
      "character (e.g. '=====' banners) inside JSON strings: Gemini CLI's loop detector cuts " +
      "such output short.",
    "",
    "JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * Assemble what Gemini reads on stdin: preset, permission note, prompt, schema. The note
 * always comes first, so a prompt starting with "/" is never parsed as a slash command.
 */
export function buildGeminiPrompt(opts: ExecOptions, readOnly: boolean): string {
  const parts: string[] = [];
  if (opts.appendSystemPrompt) parts.push(opts.appendSystemPrompt);
  parts.push(readOnly ? READ_ONLY_NOTE : EDIT_NOTE);
  parts.push(opts.prompt);
  if (opts.schema !== undefined) parts.push(schemaInstructions(opts.schema));
  return parts.join("\n\n");
}

/** Follow-up turn for a session whose final answer was unusable. */
export function buildRepairPrompt(reason: string, schema: JsonSchema | undefined): string {
  const lines = [
    `[odw] Your previous final answer could not be used: ${reason}.`,
    schema !== undefined
      ? "Reply again with ONLY the complete final answer as one JSON object matching the JSON " +
        "Schema below — no markdown fences, no text before or after it. Do not redo work that " +
        "is already done."
      : "Reply again with your complete final answer. Do not redo work that is already done.",
    LOOP_HINT,
  ];
  if (schema !== undefined) lines.push("", "JSON Schema:", JSON.stringify(schema));
  return lines.join("\n");
}

/** Follow-up turn for a session that an error interrupted. */
export function buildContinuePrompt(reason: string, schema: JsonSchema | undefined): string {
  const lines = [
    `[odw] The previous turn was interrupted by an error (${reason}).`,
    "Continue the task from where you left off — do not repeat changes that were already " +
      "applied — then give your final answer.",
  ];
  if (schema !== undefined) {
    lines.push(
      "The final answer must be ONLY one JSON object matching the JSON Schema below.",
      LOOP_HINT,
      "",
      "JSON Schema:",
      JSON.stringify(schema),
    );
  }
  return lines.join("\n");
}

/** agent-3.jsonl → agent-3.attempt-2.jsonl, so every attempt keeps its own trace. */
function attemptTracePath(tracePath: string, attempt: number): string {
  if (attempt === 1) return tracePath;
  const ext = path.extname(tracePath);
  return `${tracePath.slice(0, tracePath.length - ext.length)}.attempt-${attempt}${ext}`;
}

/** Did the requested model actually serve the run? (Helper models may appear too.) */
function servedBy(model: string, modelsUsed: readonly string[]): boolean {
  return (
    modelsUsed.length === 0 ||
    modelsUsed.some((m) => m === model || m.startsWith(model) || model.startsWith(m))
  );
}

function abortError(): Error {
  return new Error("gemini aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Process-wide start gate shared by every gemini executor instance.
let nextStartAt = 0;

async function waitForStartSlot(gapMs: number, signal?: AbortSignal): Promise<void> {
  if (gapMs <= 0) return;
  const now = Date.now();
  const at = Math.max(now, nextStartAt);
  nextStartAt = at + gapMs;
  await sleep(at - now, signal);
}

function toCore(outcome: GeminiOutcome): ExecResultCore {
  const core: ExecResultCore = {
    text: outcome.isError ? outcome.errorMessage : outcome.text,
    sessionId: outcome.sessionId,
    costUsd: 0, // Gemini CLI reports no USD
    resultSubtype: outcome.resultSubtype,
    isError: outcome.isError,
    usage: { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens },
  };
  if (outcome.structuredOutput !== undefined) core.structuredOutput = outcome.structuredOutput;
  return core;
}

type NextAttempt = { kind: "fresh" } | { kind: "resume"; sessionId: string; prompt: string };

/** Create a gemini Executor. `geminiExecutor` is the instance with default options. */
export function createGeminiExecutor(options: GeminiExecutorOptions = {}): Executor {
  const cfg = {
    command: options.command ?? "gemini",
    commandArgs: options.commandArgs ?? [],
    policyPaths: (options.policyPaths ?? []).map((p) => path.resolve(p)),
    extensions: options.extensions ?? ["none"],
    modelAliases: options.modelAliases ?? {},
    allowedModels: options.allowedModels ?? [],
    defaultModel: options.defaultModel,
    readOnlyAgentTypes: options.readOnlyAgentTypes ?? [...DEFAULT_READ_ONLY_AGENT_TYPES],
    maxAttempts: Math.max(1, Math.floor(options.maxAttempts ?? 3)),
    retryDelayMs: Math.max(0, options.retryDelayMs ?? 3000),
    spawnGapMs: Math.max(0, options.spawnGapMs ?? 400),
    env: options.env ?? {},
  };
  const isReadOnly = (agentType: string | undefined): boolean =>
    agentType !== undefined && cfg.readOnlyAgentTypes.includes(agentType);

  // reduce() is synchronous and receives the exact opts object of its run, so the full
  // outcome (failure kind, models used, mutating calls) can ride along without widening
  // the shared ExecResult contract.
  const outcomes = new WeakMap<ExecOptions, GeminiOutcome>();

  const runOnce = makeSubprocessExecutor({
    command: cfg.command,
    prepare: async (opts) => ({
      args: [
        ...cfg.commandArgs,
        ...buildGeminiArgs(opts, {
          readOnly: isReadOnly(opts.agentType),
          policyPaths: cfg.policyPaths,
          extensions: cfg.extensions,
        }),
      ],
      stdin: opts.prompt,
      // No self-relaunch: one process per agent, so a cancel kills exactly what we spawned.
      env: { GEMINI_CLI_NO_RELAUNCH: "true", NO_COLOR: "1", ...cfg.env },
    }),
    parseLine: parseGeminiStreamLine,
    reduce: (events, ctx) => {
      const outcome = reduceGeminiStreamEvents(events, {
        schema: ctx.opts.schema !== undefined,
        exitCode: ctx.exitCode,
        stderr: ctx.stderr,
      });
      outcomes.set(ctx.opts, outcome);
      return toCore(outcome);
    },
  });

  return async (opts: ExecOptions): Promise<ExecResult> => {
    // Fail fast — before spawning anything — on a model outside the allowlist.
    const model = resolveGeminiModel(opts.model, cfg);
    const readOnly = isReadOnly(opts.agentType);
    const firstPrompt = buildGeminiPrompt(opts, readOnly);

    const usage = { inputTokens: 0, outputTokens: 0 };
    let durationMs = 0;
    let mutated = false; // has any attempt changed the workspace?
    let next: NextAttempt = { kind: "fresh" };
    const history: string[] = [];
    let last = { sessionId: null as string | null, subtype: "error_during_execution", reason: "" };

    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      const attemptOpts: ExecOptions = {
        ...opts,
        prompt: next.kind === "resume" ? next.prompt : firstPrompt,
        ...(model !== undefined ? { model } : {}),
        ...(opts.tracePath !== undefined
          ? { tracePath: attemptTracePath(opts.tracePath, attempt) }
          : {}),
        ...(next.kind === "resume" ? { resumeSessionId: next.sessionId } : {}),
      };

      await waitForStartSlot(cfg.spawnGapMs, opts.signal);
      // Abort, wall/idle timeout, and spawn errors reject here and are not retried.
      const res = await runOnce(attemptOpts);
      const outcome = outcomes.get(attemptOpts);
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      durationMs += res.durationMs;
      if (outcome !== undefined && outcome.mutatingCalls > 0) mutated = true;

      let kind = outcome?.failureKind ?? (res.isError ? "transient" : "none");
      let subtype = res.resultSubtype;
      let reason = outcome?.errorMessage || res.text;

      // A silent fallback to another model breaks an explicit allowlist.
      if (
        kind === "none" &&
        model !== undefined &&
        cfg.allowedModels.length > 0 &&
        outcome !== undefined &&
        !servedBy(model, outcome.modelsUsed)
      ) {
        kind = "fatal";
        subtype = "error_model_fallback";
        reason = `Gemini CLI answered with ${outcome.modelsUsed.join(", ")} instead of ${model}`;
      }
      // Parseable JSON can still miss the schema; that is worth a repair turn too.
      if (kind === "none" && opts.schema !== undefined) {
        const check = validateAgainstSchema(opts.schema, res.structuredOutput);
        if (!check.ok) {
          kind = "repairable";
          subtype = "error_schema_mismatch";
          reason = `the JSON does not match the schema (${check.errors ?? "invalid"})`;
        }
      }

      if (kind === "none") {
        const result: ExecResult = {
          text: res.text,
          sessionId: res.sessionId,
          costUsd: 0,
          durationMs,
          resultSubtype: "success",
          isError: false,
          usage,
        };
        if (res.structuredOutput !== undefined) result.structuredOutput = res.structuredOutput;
        return result;
      }

      history.push(`#${attempt}${next.kind === "resume" ? " resumed" : ""} ${subtype}`);
      const sessionId: string | null =
        res.sessionId ?? (next.kind === "resume" ? next.sessionId : null);
      last = { sessionId, subtype, reason };
      if (attempt === cfg.maxAttempts) break;

      // Restarting from scratch is only safe if nothing may have been changed yet:
      // re-running an edit agent could apply its edits twice.
      const canRestart = readOnly || !mutated;
      if (kind === "fatal") {
        // A resume whose session could not be loaded falls back to a clean start.
        if (next.kind === "resume" && /Error resuming session/i.test(reason) && canRestart) {
          next = { kind: "fresh" };
          continue;
        }
        break;
      }
      if (kind === "repairable") {
        if (sessionId !== null) {
          next = { kind: "resume", sessionId, prompt: buildRepairPrompt(reason, opts.schema) };
        } else if (canRestart) {
          next = { kind: "fresh" };
        } else {
          break;
        }
        continue;
      }
      // transient
      await sleep(cfg.retryDelayMs * 2 ** (attempt - 1), opts.signal);
      if (sessionId !== null) {
        next = { kind: "resume", sessionId, prompt: buildContinuePrompt(reason, opts.schema) };
      } else if (canRestart) {
        next = { kind: "fresh" };
      } else {
        break;
      }
    }

    const tracesNote = opts.tracePath !== undefined ? `; trace: ${opts.tracePath}` : "";
    return {
      text: `${last.reason} [gemini attempts: ${history.join(" → ")}${tracesNote}]`,
      sessionId: last.sessionId,
      costUsd: 0,
      durationMs,
      resultSubtype: last.subtype,
      isError: true,
      usage,
    };
  };
}

/** The gemini executor with default options (read-only Explore/Plan, no extensions, 3 attempts). */
export const geminiExecutor: Executor = createGeminiExecutor();
