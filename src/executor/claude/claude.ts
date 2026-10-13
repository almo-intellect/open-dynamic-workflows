// executor/claude/claude.ts — the only module that touches `claude`.
//
// Spawns `claude --print --output-format=stream-json`, feeds the prompt on stdin,
// parses the stream-json line-by-line, and reduces it to an ExecResult. The CLI-neutral
// machinery (spawn / process-group kill / wall+idle+abort watchdogs / line buffering /
// trace) lives in subprocess.ts; this module only injects what is specific to `claude`.

import type { ExecOptions, Executor } from "../../types.js";
import { parseStreamJsonLine, reduceStreamJsonEvents } from "./stream-json.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

/** Build the argv for `claude` from ExecOptions. Never emits --dangerously-skip-permissions. */
export function buildClaudeArgs(opts: ExecOptions): string[] {
  const args: string[] = [
    "--print",
    "--output-format=stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.schema) args.push("--json-schema", JSON.stringify(opts.schema));
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  return args;
}

/**
 * Fold the parsed stream-json events into an ExecResultCore. claude trusts its terminal
 * `result` event, so exitCode is ignored. Keeps the stderr fallback: on an error result
 * with empty text, surface trimmed stderr so the failure is debuggable.
 */
function reduceClaude(events: unknown[], ctx: { stderr: string }): ExecResultCore {
  const outcome = reduceStreamJsonEvents(events as any[]);

  const core: ExecResultCore = {
    text: outcome.text,
    sessionId: outcome.sessionId,
    costUsd: outcome.costUsd,
    resultSubtype: outcome.resultSubtype,
    isError: outcome.isError,
    usage: outcome.usage,
  };
  if (outcome.structuredOutput !== undefined) {
    core.structuredOutput = outcome.structuredOutput;
  }

  // Surface stderr context on error results for debuggability (never throws).
  if (core.isError && ctx.stderr.trim().length > 0 && core.text.length === 0) {
    core.text = ctx.stderr.trim();
  }

  return core;
}

export const claudeExecutor: Executor = makeSubprocessExecutor({
  command: "claude",
  prepare: async (opts) => ({ args: buildClaudeArgs(opts), stdin: opts.prompt }),
  parseLine: parseStreamJsonLine,
  reduce: (events, { stderr }) => reduceClaude(events, { stderr }),
});
