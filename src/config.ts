// config.ts — optional per-project settings for the `odw` CLI: <cwd>/.odw/config.json.
//
// A project can pin which executors exist (e.g. only "gemini" — scripts naming any other
// then fail fast), configure the gemini executor (models, policy files, retries), set run
// defaults, and list files to snapshot before a run that may edit them. preflightScript()
// catches executor/model mistakes in a script before a single token is spent.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Executor } from "./types.js";
import { claudeExecutor } from "./executor/claude/claude.js";
import { codexExecutor } from "./executor/codex/codex.js";
import { createGeminiExecutor, type GeminiExecutorOptions } from "./executor/gemini/gemini.js";
import { assertDeterministicSource, extractMeta } from "./runtime/sandbox.js";

export interface GeminiConfig {
  /** Gemini policy files (TOML), relative to the project root. */
  policy?: string[];
  extensions?: string[];
  modelAliases?: Record<string, string>;
  allowedModels?: string[];
  defaultModel?: string;
  readOnlyAgentTypes?: string[];
  maxAttempts?: number;
  retryDelayMs?: number;
  spawnGapMs?: number;
}

export interface OdwConfig {
  /** Executors to register. Default: every built-in. */
  executors?: string[];
  gemini?: GeminiConfig;
  /** Default concurrency cap (the --concurrency flag wins). */
  concurrency?: number;
  /** Default per-agent wall-clock timeout in minutes (the --timeout flag wins). */
  agentTimeoutMinutes?: number;
  /** Project files copied to <runDir>/snapshot before the run; the summary lists what changed. */
  snapshot?: string[];
}

export const BUILTIN_EXECUTOR_NAMES: readonly string[] = ["claude", "codex", "gemini"];
export const CONFIG_RELATIVE_PATH = path.join(".odw", "config.json");

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

// Keys starting with "_" or "$" are free for comments / "$schema".
function isCommentKey(key: string): boolean {
  return key.startsWith("_") || key.startsWith("$");
}

function checkKeys(file: string, where: string, obj: Record<string, unknown>, known: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key) && !isCommentKey(key)) {
      fail(file, `unknown key "${where}${key}" (known: ${known.join(", ")})`);
    }
  }
}

function validateGemini(file: string, raw: unknown): GeminiConfig {
  if (!isRecord(raw)) fail(file, `"gemini" must be an object`);
  checkKeys(file, "gemini.", raw, [
    "policy",
    "extensions",
    "modelAliases",
    "allowedModels",
    "defaultModel",
    "readOnlyAgentTypes",
    "maxAttempts",
    "retryDelayMs",
    "spawnGapMs",
  ]);
  const out: GeminiConfig = {};
  for (const key of ["policy", "extensions", "allowedModels", "readOnlyAgentTypes"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!isStringArray(v)) fail(file, `"gemini.${key}" must be an array of strings`);
    out[key] = v;
  }
  if (raw["modelAliases"] !== undefined) {
    const v = raw["modelAliases"];
    if (!isRecord(v) || !Object.values(v).every((x) => typeof x === "string")) {
      fail(file, `"gemini.modelAliases" must map names to model ids (strings)`);
    }
    out.modelAliases = v as Record<string, string>;
  }
  if (raw["defaultModel"] !== undefined) {
    if (typeof raw["defaultModel"] !== "string") fail(file, `"gemini.defaultModel" must be a string`);
    out.defaultModel = raw["defaultModel"];
  }
  if (raw["maxAttempts"] !== undefined) {
    if (!isPositiveInt(raw["maxAttempts"])) fail(file, `"gemini.maxAttempts" must be a positive integer`);
    out.maxAttempts = raw["maxAttempts"];
  }
  for (const key of ["retryDelayMs", "spawnGapMs"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!isNonNegativeInt(v)) fail(file, `"gemini.${key}" must be a non-negative integer`);
    out[key] = v;
  }
  return out;
}

/** Validate a parsed config object; throws with the file name and the offending key. */
export function validateConfig(raw: unknown, file: string): OdwConfig {
  if (!isRecord(raw)) fail(file, "the config must be a JSON object");
  checkKeys(file, "", raw, ["executors", "gemini", "concurrency", "agentTimeoutMinutes", "snapshot"]);
  const out: OdwConfig = {};
  if (raw["executors"] !== undefined) {
    const v = raw["executors"];
    if (!isStringArray(v) || v.length === 0) fail(file, `"executors" must be a non-empty array of names`);
    for (const name of v) {
      if (!BUILTIN_EXECUTOR_NAMES.includes(name)) {
        fail(file, `unknown executor "${name}" (built-in: ${BUILTIN_EXECUTOR_NAMES.join(", ")})`);
      }
    }
    out.executors = v;
  }
  if (raw["gemini"] !== undefined) out.gemini = validateGemini(file, raw["gemini"]);
  if (raw["concurrency"] !== undefined) {
    if (!isPositiveInt(raw["concurrency"])) fail(file, `"concurrency" must be a positive integer`);
    out.concurrency = raw["concurrency"];
  }
  if (raw["agentTimeoutMinutes"] !== undefined) {
    const v = raw["agentTimeoutMinutes"];
    if (typeof v !== "number" || !(v > 0)) fail(file, `"agentTimeoutMinutes" must be a positive number`);
    out.agentTimeoutMinutes = v;
  }
  if (raw["snapshot"] !== undefined) {
    const v = raw["snapshot"];
    if (!isStringArray(v)) fail(file, `"snapshot" must be an array of project-relative paths`);
    for (const p of v) {
      if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
        fail(file, `"snapshot" entries must stay inside the project (got "${p}")`);
      }
    }
    out.snapshot = v;
  }
  return out;
}

/** Load <cwd>/.odw/config.json (or an explicit path). A missing default file means "no config". */
export function loadConfig(cwd: string, explicitPath?: string): { config: OdwConfig; path: string | null } {
  const file =
    explicitPath !== undefined ? path.resolve(cwd, explicitPath) : path.join(cwd, CONFIG_RELATIVE_PATH);
  if (!existsSync(file)) {
    if (explicitPath !== undefined) throw new Error(`config file not found: ${file}`);
    return { config: {}, path: null };
  }
  let raw: unknown;
  try {
    // Windows editors and PowerShell 5.1 often save UTF-8 with a BOM, which JSON.parse rejects.
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(`${file}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  return { config: validateConfig(raw, file), path: file };
}

/** Translate the JSON config into executor options, resolving policy paths against cwd. */
export function geminiOptionsFromConfig(g: GeminiConfig | undefined, cwd: string): GeminiExecutorOptions {
  if (g === undefined) return {};
  const policyPaths = (g.policy ?? []).map((p) => path.resolve(cwd, p));
  for (const p of policyPaths) {
    if (!existsSync(p)) throw new Error(`gemini policy file not found: ${p}`);
  }
  return {
    ...(policyPaths.length > 0 ? { policyPaths } : {}),
    ...(g.extensions !== undefined ? { extensions: g.extensions } : {}),
    ...(g.modelAliases !== undefined ? { modelAliases: g.modelAliases } : {}),
    ...(g.allowedModels !== undefined ? { allowedModels: g.allowedModels } : {}),
    ...(g.defaultModel !== undefined ? { defaultModel: g.defaultModel } : {}),
    ...(g.readOnlyAgentTypes !== undefined ? { readOnlyAgentTypes: g.readOnlyAgentTypes } : {}),
    ...(g.maxAttempts !== undefined ? { maxAttempts: g.maxAttempts } : {}),
    ...(g.retryDelayMs !== undefined ? { retryDelayMs: g.retryDelayMs } : {}),
    ...(g.spawnGapMs !== undefined ? { spawnGapMs: g.spawnGapMs } : {}),
  };
}

/** The executor registry for a run: the configured subset of the built-ins (default: all). */
export function buildExecutors(config: OdwConfig, cwd: string): Record<string, Executor> {
  const names = config.executors ?? [...BUILTIN_EXECUTOR_NAMES];
  const registry: Record<string, Executor> = {};
  for (const name of names) {
    if (name === "claude") registry[name] = claudeExecutor;
    else if (name === "codex") registry[name] = codexExecutor;
    else if (name === "gemini") {
      registry[name] = createGeminiExecutor(geminiOptionsFromConfig(config.gemini, cwd));
    } else throw new Error(`unknown executor "${name}"`);
  }
  return registry;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Static checks the runtime would otherwise only hit mid-run, after spending tokens:
 * determinism, the meta block, executor names that are not registered, and (when the script
 * only uses gemini and an allowlist is configured) literal model names outside it.
 * Returns human-readable problems; empty means OK.
 */
export function preflightScript(
  source: string,
  opts: { executors: readonly string[]; gemini?: GeminiConfig | undefined },
): string[] {
  const problems: string[] = [];
  try {
    assertDeterministicSource(source);
  } catch (e) {
    problems.push(errorMessage(e));
  }
  try {
    extractMeta(source);
  } catch (e) {
    problems.push(errorMessage(e));
  }

  const literal = (key: string): string[] => {
    const re = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`, "g");
    const found: string[] = [];
    for (const m of source.matchAll(re)) {
      const value = m[2];
      if (value !== undefined && !value.includes("${")) found.push(value);
    }
    return found;
  };

  const usedExecutors = new Set(literal("executor"));
  for (const name of usedExecutors) {
    if (!opts.executors.includes(name)) {
      problems.push(
        `executor "${name}" is not registered for this project (available: ${opts.executors.join(", ")})`,
      );
    }
  }

  // Model literals can only be attributed to gemini when gemini is the only CLI in play:
  // either the project registers nothing else, or every executor the script names is gemini.
  const allowed = opts.gemini?.allowedModels ?? [];
  const geminiOnlyRegistry = opts.executors.length === 1 && opts.executors[0] === "gemini";
  const onlyGemini =
    geminiOnlyRegistry || (usedExecutors.size > 0 && [...usedExecutors].every((n) => n === "gemini"));
  if (allowed.length > 0 && onlyGemini) {
    const aliases = opts.gemini?.modelAliases ?? {};
    for (const raw of new Set(literal("model"))) {
      const model = aliases[raw] ?? raw;
      if (!allowed.includes(model)) {
        problems.push(`model "${raw}" is not in gemini.allowedModels (${allowed.join(", ")})`);
      }
    }
  }
  return problems;
}

export interface SnapshotEntry {
  file: string;
  /** null = the file did not exist when the snapshot was taken. */
  sha256: string | null;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Copy the listed project files into destDir (preserving relative paths) and hash them. */
export function takeSnapshot(cwd: string, files: readonly string[], destDir: string): SnapshotEntry[] {
  mkdirSync(destDir, { recursive: true });
  return files.map((rel) => {
    const src = path.resolve(cwd, rel);
    if (!existsSync(src)) return { file: rel, sha256: null };
    const dest = path.join(destDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return { file: rel, sha256: sha256File(src) };
  });
}

/** Snapshot entries whose file was created, deleted, or modified since the snapshot. */
export function changedSinceSnapshot(cwd: string, snapshot: readonly SnapshotEntry[]): string[] {
  return snapshot
    .filter((entry) => {
      const file = path.resolve(cwd, entry.file);
      const now = existsSync(file) ? sha256File(file) : null;
      return now !== entry.sha256;
    })
    .map((entry) => entry.file);
}
