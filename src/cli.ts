#!/usr/bin/env node
// cli.ts — argv → (config + preflight) → runWorkflow → terminal live tree → run summary.
// Hand-rolled flag parser (no deps). Usage:
//   odw run <scriptPath> [--name <name>] [--args <json> | --args-file <file>] [--resume <runId>]
//                        [--cwd <dir>] [--model <id>] [--run-dir <dir>]
//                        [--config <file>] [--concurrency <n>] [--timeout <minutes>]
//                        [--dry-run] [--strict] [--no-tree]

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readRegistryScript, runWorkflow } from "./runtime/run.js";
import { extractMeta } from "./runtime/sandbox.js";
import { createTreeRenderer } from "./progress/tree.js";
import {
  buildExecutors,
  changedSinceSnapshot,
  loadConfig,
  preflightScript,
  takeSnapshot,
  type SnapshotEntry,
} from "./config.js";
import type { ProgressEvent, RunOptions } from "./types.js";

const USAGE =
  "usage: odw run <scriptPath> [--name <name>] [--args <json> | --args-file <file>] [--resume <runId>]\n" +
  "               [--cwd <dir>] [--model <id>] [--run-dir <dir>] [--config <file>]\n" +
  "               [--concurrency <n>] [--timeout <minutes>] [--dry-run] [--strict] [--no-tree]\n" +
  "\nEvery agent() names its CLI: {executor:'gemini'|'claude'|'codex'}.\n" +
  "Project settings are read from <cwd>/.odw/config.json when present.\n" +
  "--args-file read the args JSON from a file (shell-safe; PowerShell mangles inline JSON quotes)\n" +
  "--dry-run   validate the script and config without running any agent\n" +
  "--strict    exit with code 2 when any agent failed\n";

// Flags that take a following value; everything else is boolean or positional.
const VALUE_FLAGS = new Set([
  "name",
  "args",
  "args-file",
  "resume",
  "cwd",
  "model",
  "run-dir",
  "config",
  "concurrency",
  "timeout",
]);

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next === undefined) throw new Error(`missing value for --${body}`);
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function flagStr(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function positiveNumber(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${flag} expects a positive number, got "${raw}"`);
  return n;
}

interface AgentTally {
  total: number;
  ok: number;
  cached: number;
  skipped: number;
  failed: Array<{ agentId: number; label: string; phase: string | null; error: string }>;
}

function tallyAgents(events: readonly ProgressEvent[]): AgentTally {
  const tally: AgentTally = { total: 0, ok: 0, cached: 0, skipped: 0, failed: [] };
  for (const e of events) {
    if (e.type !== "agent_end") continue;
    tally.total += 1;
    if (e.ok) {
      tally.ok += 1;
      if (e.cached) tally.cached += 1;
    } else if (e.skipped) {
      tally.skipped += 1;
    } else {
      tally.failed.push({ agentId: e.agentId, label: e.label, phase: e.phase, error: e.error ?? "" });
    }
  }
  return tally;
}

function oneLine(s: string, max = 220): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "run") {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const { positionals, flags } = parseArgs(argv.slice(1));
  const name = flagStr(flags, "name");
  const scriptPath = positionals[0];
  if (scriptPath === undefined && name === undefined) {
    process.stderr.write("[error] need a <scriptPath> positional or --name\n");
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const cwd = path.resolve(flagStr(flags, "cwd") ?? process.cwd());
  const { config, path: configPath } = loadConfig(cwd, flagStr(flags, "config"));
  const executors = buildExecutors(config, cwd);

  // Preflight on the exact source the runtime will run — before a single token is spent.
  const source =
    scriptPath !== undefined
      ? await readFile(scriptPath, "utf8")
      : (await readRegistryScript(path.join(cwd, ".odw"), name as string)).source;
  const problems = preflightScript(source, { executors: Object.keys(executors), gemini: config.gemini });
  if (problems.length > 0) {
    process.stderr.write(`[preflight] ${problems.length} problem(s) — nothing was run:\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }

  if (flags["dry-run"] === true) {
    const meta = extractMeta(source);
    const phases = (meta.phases ?? []).map((p) => p.title).join(" → ") || "(none declared)";
    process.stderr.write(
      `[dry-run] ${meta.name}: ${meta.description}\n` +
        `  phases:    ${phases}\n` +
        `  executors: ${Object.keys(executors).join(", ")}\n` +
        `  config:    ${configPath ?? "(none)"}\n` +
        "  preflight ok — no agents were run\n",
    );
    process.exit(0);
  }

  const opts: RunOptions = { executors, cwd };
  if (scriptPath !== undefined) opts.scriptPath = scriptPath;
  if (name !== undefined) opts.name = name;

  const argsInline = flagStr(flags, "args");
  const argsFile = flagStr(flags, "args-file");
  if (argsInline !== undefined && argsFile !== undefined) {
    throw new Error("use either --args or --args-file, not both");
  }
  const argsRaw =
    argsFile !== undefined ? await readFile(path.resolve(cwd, argsFile), "utf8") : argsInline;
  if (argsRaw !== undefined) {
    try {
      opts.args = JSON.parse(argsRaw);
    } catch (e) {
      const source = argsFile !== undefined ? `--args-file ${argsFile}` : "--args";
      throw new Error(`${source} is not valid JSON: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  const resume = flagStr(flags, "resume");
  if (resume !== undefined) opts.resumeFromRunId = resume;

  const model = flagStr(flags, "model");
  if (model !== undefined) opts.model = model;

  const runDirFlag = flagStr(flags, "run-dir");
  if (runDirFlag !== undefined) opts.runDir = runDirFlag;

  const concurrencyRaw = flagStr(flags, "concurrency");
  const concurrency =
    concurrencyRaw !== undefined ? Math.floor(positiveNumber("concurrency", concurrencyRaw)) : config.concurrency;
  if (concurrency !== undefined) opts.concurrency = concurrency;

  const timeoutRaw = flagStr(flags, "timeout");
  const timeoutMinutes =
    timeoutRaw !== undefined ? positiveNumber("timeout", timeoutRaw) : config.agentTimeoutMinutes;
  if (timeoutMinutes !== undefined) opts.agentTimeoutMs = Math.round(timeoutMinutes * 60_000);

  const tree = createTreeRenderer({
    stream: process.stderr,
    enabled: flags["no-tree"] !== true,
  });

  // Track the run as it starts: its id/dir for the summary, and the pre-run snapshot,
  // which must be taken before any agent can touch the files.
  const seen: ProgressEvent[] = [];
  const run: { id: string | null; dir: string | null; snapshot: SnapshotEntry[] | null } = {
    id: null,
    dir: null,
    snapshot: null,
  };
  opts.onEvent = (e) => {
    seen.push(e);
    if (e.type === "run_start") {
      run.id = e.runId;
      run.dir = e.runDir ?? null;
      if (run.dir !== null && (config.snapshot ?? []).length > 0) {
        try {
          run.snapshot = takeSnapshot(cwd, config.snapshot ?? [], path.join(run.dir, "snapshot"));
        } catch (err) {
          process.stderr.write(`[warn] snapshot failed: ${String(err)}\n`);
        }
      }
    }
    tree.sink(e);
  };

  // Ctrl-C cancels the run: abort the signal → in-flight subprocesses are killed and the
  // run unwinds. A second Ctrl-C force-exits. Completed agents stay journaled, so
  // `--resume <runId>` replays them with zero spend.
  const controller = new AbortController();
  opts.signal = controller.signal;
  let interrupting = false;
  process.on("SIGINT", () => {
    if (interrupting) {
      process.stderr.write("\n[force-exit]\n");
      process.exit(130);
    }
    interrupting = true;
    process.stderr.write("\n[interrupt] aborting workflow (Ctrl-C again to force-exit)…\n");
    controller.abort();
  });

  const report = async (status: string): Promise<AgentTally> => {
    const tally = tallyAgents(seen);
    const changed = run.snapshot !== null ? changedSinceSnapshot(cwd, run.snapshot) : null;
    if (tally.failed.length > 0) {
      process.stderr.write(
        `\n[warn] ${tally.failed.length} agent(s) failed — the workflow received null for them:\n`,
      );
      for (const f of tally.failed) {
        process.stderr.write(`  - #${f.agentId} ${f.label}${f.phase ? ` (${f.phase})` : ""}: ${oneLine(f.error)}\n`);
      }
    }
    if (run.dir === null) return tally;
    if (changed !== null) {
      process.stderr.write(
        changed.length > 0
          ? `[files] changed during the run: ${changed.join(", ")} (pre-run copies: ${path.join(run.dir, "snapshot")})\n`
          : "[files] no snapshotted file changed\n",
      );
    }
    const summary = {
      runId: run.id,
      status,
      agents: {
        total: tally.total,
        ok: tally.ok,
        cached: tally.cached,
        skipped: tally.skipped,
        failed: tally.failed.length,
      },
      failedAgents: tally.failed,
      changedFiles: changed,
      config: configPath,
    };
    try {
      await writeFile(path.join(run.dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    } catch {
      /* a summary is a convenience; never fail the run over it */
    }
    process.stderr.write(`[run-dir] ${run.dir}\n`);
    return tally;
  };

  try {
    const res = await runWorkflow(opts);
    tree.stop();
    process.stdout.write(`${JSON.stringify(res.value ?? null, null, 2)}\n`);
    const tally = await report("completed");
    process.stderr.write(
      `\n[done] run=${res.runId} agents=${res.agentCount} (ok ${tally.ok}, failed ${tally.failed.length}, cached ${tally.cached}) ` +
        `tokens=${res.tokensSpent} ${res.durationMs}ms\n`,
    );
    process.exit(flags["strict"] === true && tally.failed.length > 0 ? 2 : 0);
  } catch (e) {
    tree.stop();
    if (controller.signal.aborted) {
      await report("aborted");
      process.stderr.write(`\n[aborted] run cancelled — resume with: --resume ${run.id ?? "<runId>"}\n`);
      process.exit(130);
    }
    await report("failed");
    process.stderr.write(`[error] ${String((e && (e as Error).stack) || e)}\n`);
    if (run.id !== null) process.stderr.write(`[hint] fix the cause, then resume with: --resume ${run.id}\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`[error] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
