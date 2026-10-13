// executor/codex/codex.ts — the only module that touches `codex`.
//
// Spawns `codex exec --json`, feeds the prompt on stdin, parses the JSONL events
// line-by-line, and reduces them to an ExecResult. The CLI-neutral machinery (spawn /
// process-group kill / wall+idle+abort watchdogs / line buffering / trace) lives in
// subprocess.ts; this module only injects what is specific to `codex`.

import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, Executor } from "../../types.js";
import { parseCodexJsonLine, reduceCodexEvents } from "./codex-jsonl.js";
import { type ExecResultCore, makeSubprocessExecutor } from "../subprocess.js";

/**
 * Build the argv for `codex exec` from ExecOptions. The fixed base is
 * `exec --json --skip-git-repo-check --color never --sandbox workspace-write`:
 * `--json` emits JSONL events; the cwd may be a non-git dir / worktree, so
 * `--skip-git-repo-check` is mandatory; `--sandbox workspace-write` is the
 * acceptEdits counterpart. INVARIANT: never emits
 * `--dangerously-bypass-approvals-and-sandbox` (the codex twin of claude's
 * "no --dangerously-skip-permissions" rule). The prompt is fed on stdin, so the
 * final argv token is `-` ("read from stdin"), which also dodges the argv length
 * limit on long prompts — the same approach claude takes.
 */
export function buildCodexArgs(opts: ExecOptions, schemaPath?: string): string[] {
  const args: string[] = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
  ];
  if (opts.model) args.push("-m", opts.model);
  if (schemaPath) args.push("--output-schema", schemaPath);
  if (opts.appendSystemPrompt) {
    // append semantics (a developer-role message), not a base-prompt override.
    args.push("-c", `developer_instructions=${opts.appendSystemPrompt}`);
  }
  // resumeSessionId is intentionally not wired: runtime resume is journal replay
  // (it re-emits the stored neutral result and spawns no CLI), so no CLI-level
  // `exec resume` is needed here.

  // The prompt is read from stdin; `-` is the trailing positional that tells codex so.
  args.push("-");
  return args;
}

/**
 * Fold the parsed codex JSONL events into an ExecResultCore. codex reports no USD,
 * so costUsd is always 0; usage comes from the reducer's input/output token counts.
 * The reducer needs to know whether structured output was requested (it then
 * JSON.parse's the agent text), which is derived from opts.schema; the exit code
 * also feeds the reducer's failure detection.
 */
function reduceCodex(
  events: unknown[],
  ctx: { stderr: string; exitCode: number | null; opts: ExecOptions },
): ExecResultCore {
  const outcome = reduceCodexEvents(events as any[], {
    schema: ctx.opts.schema !== undefined,
    exitCode: ctx.exitCode,
  });

  const core: ExecResultCore = {
    text: outcome.text,
    sessionId: outcome.sessionId,
    costUsd: 0,
    resultSubtype: outcome.resultSubtype,
    isError: outcome.isError,
    usage: {
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
    },
  };
  if (outcome.structuredOutput !== undefined) {
    core.structuredOutput = outcome.structuredOutput;
  }

  // Surface stderr as a last resort when the turn errored with no usable text — e.g. a
  // usage-limit / auth failure that kills codex before it emits any JSON event, leaving
  // the reason only on stderr. codex's stderr is noisy, but a real reason beats an opaque
  // error_during_execution. Mirrors the claude executor's stderr fallback.
  if (core.isError && ctx.stderr.trim().length > 0 && core.text.length === 0) {
    core.text = ctx.stderr.trim();
  }

  return core;
}

export const codexExecutor: Executor = makeSubprocessExecutor({
  command: "codex",
  prepare: async (opts) => {
    // No schema → plain argv + stdin, nothing to clean up.
    if (opts.schema === undefined) {
      return { args: buildCodexArgs(opts), stdin: opts.prompt };
    }

    // codex takes --output-schema as a file path, so write the schema to a uniquely
    // named temp file. The executor is host code (not sandboxed), so crypto is fine.
    // cleanup deletes the temp file and swallows any error (a debug artifact must
    // never mask the real settlement reason).
    const schemaPath = join(
      tmpdir(),
      `codex-schema-${randomBytes(8).toString("hex")}.json`,
    );
    await writeFile(schemaPath, JSON.stringify(opts.schema));
    return {
      args: buildCodexArgs(opts, schemaPath),
      stdin: opts.prompt,
      cleanup: () => unlink(schemaPath).catch(() => {}),
    };
  },
  parseLine: parseCodexJsonLine,
  reduce: (events, { stderr, exitCode, opts }) =>
    reduceCodex(events, { stderr, exitCode, opts }),
});
