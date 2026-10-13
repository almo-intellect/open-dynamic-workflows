// subprocess.ts — CLI-agnostic streaming subprocess driver.
//
// Owns every CLI-neutral mechanism shared by stream-based executors: spawn into a
// fresh process group, process-tree kill (POSIX + Windows, see platform.ts), wall + idle + abort watchdogs, newline
// line buffering of stdout, stderr accumulation, stdin feed, and best-effort trace
// write. The command name, argv, line parsing, and reduction are all injected by the
// caller via a SubprocessSpec, so a new CLI is just a new spec (SPEC §5).

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ExecOptions,
  ExecResult,
  Executor,
  ResultSubtype,
  TokenUsage,
} from "../types.js";
import { killProcessTree, quoteForCmd, resolveCommand, treeSpawnOptions } from "./platform.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// Opt-in troubleshooting log: ODW_DEBUG=1 streams spawn argv, exit status, and (on an
// error result) a stderr tail to this process's stderr. Off by default — the happy path
// stays quiet; the always-on record lives in the per-agent trace file instead.
const DEBUG = process.env.ODW_DEBUG === "1" || process.env.ODW_DEBUG === "true";

/** The CLI-neutral core of an ExecResult; the driver adds durationMs. */
export interface ExecResultCore {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  costUsd: number;
  resultSubtype: ResultSubtype;
  isError: boolean;
  usage: TokenUsage;
}

/**
 * Everything CLI-specific about a streaming executor: how to build argv (+ optional
 * stdin / cleanup), how to parse a single stdout line, and how to fold the collected
 * events into an ExecResultCore.
 */
export interface SubprocessSpec {
  /** The executable name to spawn (e.g. "claude", "codex"). */
  command: string;
  /**
   * Build argv + optional stdin + optional cleanup. Async: lets the caller write a
   * temp file (e.g. an --output-schema path) before the subprocess starts.
   */
  prepare: (opts: ExecOptions) => Promise<{
    args: string[];
    stdin?: string;
    /** Extra environment for this spawn (over process.env, under opts.env). */
    env?: Record<string, string>;
    cleanup?: () => void | Promise<void>;
  }>;
  /** Parse one stdout line into an event object, or null to skip it. */
  parseLine: (line: string) => unknown | null;
  /**
   * Pure reduction: collected events + exit context (including the original opts, so a
   * spec can branch on e.g. whether a schema was requested) → an ExecResultCore. The
   * driver appends durationMs.
   */
  reduce: (
    events: unknown[],
    ctx: { stderr: string; exitCode: number | null; opts: ExecOptions },
  ) => ExecResultCore;
}

/**
 * A self-contained debug record of one subprocess execution. Beyond the parsed stdout
 * events it captures argv, exit code, duration, and — crucially — stderr, which is where
 * CLI-level failures (auth, usage/quota limits, config errors) actually land. Persisting
 * this means a failed run is diagnosable from its trace alone, with no reproduction.
 */
export interface ExecTrace {
  command: string;
  args: string[];
  /** What was really spawned, when it differs from `command` (e.g. a Windows npm shim → node + entry). */
  spawned?: string[];
  cwd: string;
  prompt: string;
  durationMs: number;
  exitCode: number | null;
  isError: boolean;
  resultSubtype: string;
  stderr: string;
  events: unknown[];
}

/** Best-effort trace write. Never rejects — a debug artifact must not fail the run. */
async function writeTrace(tracePath: string, trace: ExecTrace): Promise<void> {
  try {
    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(tracePath, JSON.stringify(trace, null, 2));
  } catch (err) {
    console.warn(`[${trace.command}] trace write failed (${tracePath}):`, err);
  }
}

/**
 * Turn a SubprocessSpec into an Executor. All timeout / idle / abort / spawn-error
 * paths reject with "<command> timeout|idle timeout|aborted|spawn error: ..."; the
 * happy path resolves to { ...core, durationMs }.
 */
export function makeSubprocessExecutor(spec: SubprocessSpec): Executor {
  const dbg = (msg: string): void => {
    if (DEBUG) console.error(`[odw:${spec.command}] ${msg}`);
  };
  return (opts: ExecOptions): Promise<ExecResult> => {
    return new Promise<ExecResult>((resolve, reject) => {
      const startedAt = Date.now();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      let settled = false;
      let cleanupFn: (() => void | Promise<void>) | undefined;
      let wallTimer: NodeJS.Timeout | undefined;
      let idleTimer: NodeJS.Timeout | undefined;

      const clearTimers = (): void => {
        if (wallTimer) clearTimeout(wallTimer);
        if (idleTimer) clearTimeout(idleTimer);
      };

      // Run the prepare()-supplied cleanup exactly once, best-effort. Never throws —
      // a leftover temp file must not mask the real settlement reason.
      const runCleanup = (): void => {
        const fn = cleanupFn;
        if (fn === undefined) return;
        cleanupFn = undefined;
        try {
          void Promise.resolve(fn()).catch((err) => {
            console.warn(`[${spec.command}] cleanup failed:`, err);
          });
        } catch (err) {
          console.warn(`[${spec.command}] cleanup failed:`, err);
        }
      };

      // prepare() is async (may write a temp file); only then do we spawn.
      void spec
        .prepare(opts)
        .then(({ args, stdin, env, cleanup }) => {
          cleanupFn = cleanup;

          // If the signal already aborted while prepare() was in flight, bail before spawning.
          if (opts.signal?.aborted) {
            settled = true;
            runCleanup();
            reject(new Error(`${spec.command} aborted`));
            return;
          }

          // Windows: unwrap npm .cmd shims into `node <entry.js>` (see platform.ts).
          const resolved = resolveCommand(spec.command);
          const spawnArgs = [...resolved.prefixArgs, ...args];
          const spawned =
            resolved.file !== spec.command || resolved.prefixArgs.length > 0
              ? [resolved.file, ...resolved.prefixArgs]
              : undefined;

          dbg(`spawn: ${[resolved.file, ...spawnArgs].join(" ")} (cwd=${opts.cwd})`);
          const child = spawn(
            resolved.shell ? quoteForCmd(resolved.file) : resolved.file,
            resolved.shell ? spawnArgs.map(quoteForCmd) : spawnArgs,
            {
              cwd: opts.cwd,
              env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env, ...opts.env },
              stdio: ["pipe", "pipe", "pipe"],
              // The CLI may spawn its own children (MCP servers, tool subprocesses, bash).
              // A cancel must kill the whole tree, not just the top process, or those
              // grandchildren are orphaned. We keep the pipes (no unref).
              ...treeSpawnOptions(),
              shell: resolved.shell,
            },
          );

          // Kill the child's whole tree: process group on POSIX, taskkill /T on Windows.
          const killTree = (sig: NodeJS.Signals): void => killProcessTree(child, sig);

          const events: unknown[] = [];
          let stdoutBuf = "";
          let stderrBuf = "";

          const onAbort = (): void => {
            if (settled) return;
            settled = true;
            clearTimers();
            killTree("SIGKILL");
            runCleanup();
            dbg("aborted by signal");
            reject(new Error(`${spec.command} aborted`));
          };

          const fail = (message: string): void => {
            if (settled) return;
            settled = true;
            clearTimers();
            opts.signal?.removeEventListener("abort", onAbort);
            killTree("SIGKILL");
            runCleanup();
            dbg(`fail: ${message}`);
            reject(new Error(message));
          };

          // Abort signal: kill + reject.
          if (opts.signal) {
            opts.signal.addEventListener("abort", onAbort, { once: true });
          }

          // Wall-clock timeout.
          wallTimer = setTimeout(() => fail(`${spec.command} timeout`), timeoutMs);

          // Idle (stdout-arrival) watchdog.
          const armIdle = (): void => {
            if (opts.idleTimeoutMs === undefined) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () => fail(`${spec.command} idle timeout`),
              opts.idleTimeoutMs,
            );
          };
          armIdle();

          // Consume a chunk of stdout: split complete lines, parse, push non-null events.
          const consume = (chunk: string): void => {
            stdoutBuf += chunk;
            let nl: number;
            while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
              const line = stdoutBuf.slice(0, nl);
              stdoutBuf = stdoutBuf.slice(nl + 1);
              const ev = spec.parseLine(line);
              if (ev !== null) events.push(ev);
            }
          };

          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            armIdle();
            consume(chunk);
          });

          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => {
            stderrBuf += chunk;
          });

          child.on("error", (err) => {
            const detail = err instanceof Error ? err.message : String(err);
            fail(`${spec.command} spawn error: ${detail}`);
          });

          child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimers();
            opts.signal?.removeEventListener("abort", onAbort);

            // Flush any trailing partial line.
            const tail = stdoutBuf.trim();
            if (tail.length > 0) {
              const ev = spec.parseLine(tail);
              if (ev !== null) events.push(ev);
            }
            stdoutBuf = "";

            // Wall-clock duration, computed the same way as before the refactor.
            const durationMs = Date.now() - startedAt;
            const core = spec.reduce(events, {
              stderr: stderrBuf,
              exitCode: code,
              opts,
            });

            dbg(
              `exit=${code} ${durationMs}ms events=${events.length} isError=${core.isError} subtype=${core.resultSubtype}`,
            );
            if (core.isError && stderrBuf.trim().length > 0) {
              dbg(`stderr tail: ${stderrBuf.trim().slice(-800)}`);
            }

            const finish = (): void => {
              const result: ExecResult = {
                text: core.text,
                sessionId: core.sessionId,
                costUsd: core.costUsd,
                durationMs,
                resultSubtype: core.resultSubtype,
                isError: core.isError,
                usage: core.usage,
              };
              if (core.structuredOutput !== undefined) {
                result.structuredOutput = core.structuredOutput;
              }
              runCleanup();
              resolve(result);
            };

            if (opts.tracePath) {
              void writeTrace(opts.tracePath, {
                command: spec.command,
                args,
                ...(spawned !== undefined ? { spawned } : {}),
                cwd: opts.cwd,
                prompt: opts.prompt,
                durationMs,
                exitCode: code,
                isError: core.isError,
                resultSubtype: core.resultSubtype,
                stderr: stderrBuf,
                events,
              }).then(finish);
            } else {
              finish();
            }
          });

          // Feed the prompt on stdin and close it.
          child.stdin.on("error", () => {
            // EPIPE if the child died early; close handler / error handler covers settlement.
          });
          if (stdin !== undefined) child.stdin.write(stdin);
          child.stdin.end();
        })
        .catch((err) => {
          // prepare() itself failed (e.g. temp-file write) — surface as a spawn error.
          // The abort listener is only attached after spawn, so there is none to remove here.
          if (settled) return;
          settled = true;
          clearTimers();
          runCleanup();
          const detail = err instanceof Error ? err.message : String(err);
          reject(new Error(`${spec.command} spawn error: ${detail}`));
        });
    });
  };
}
