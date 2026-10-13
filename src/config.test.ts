// config.test.ts — <cwd>/.odw/config.json loading/validation, the executor registry it
// builds, the static preflight, and the pre-run snapshot. Pure file-system tests in temp dirs.
//
// Run: npx tsx --test src/config.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildExecutors,
  changedSinceSnapshot,
  loadConfig,
  preflightScript,
  takeSnapshot,
  validateConfig,
} from "./config.js";

function project(config?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "odw-config-"));
  if (config !== undefined) {
    mkdirSync(path.join(dir, ".odw"), { recursive: true });
    writeFileSync(path.join(dir, ".odw", "config.json"), JSON.stringify(config));
  }
  return dir;
}

const META = "export const meta = { name: 'x', description: 'y' }\n";

test("no config file → empty config and every built-in executor", () => {
  const dir = project();
  const { config, path: file } = loadConfig(dir);
  assert.deepEqual(config, {});
  assert.equal(file, null);
  assert.deepEqual(Object.keys(buildExecutors(config, dir)).sort(), ["claude", "codex", "gemini"]);
});

test("executors restricts the registry (e.g. a gemini-only project)", () => {
  const dir = project({ executors: ["gemini"] });
  const { config } = loadConfig(dir);
  assert.deepEqual(Object.keys(buildExecutors(config, dir)), ["gemini"]);
});

test("validation: unknown keys, bad types, unknown executors, escaping snapshot paths", () => {
  assert.throws(() => validateConfig({ concurency: 2 }, "c.json"), /unknown key "concurency"/);
  assert.throws(() => validateConfig({ concurrency: 0 }, "c.json"), /positive integer/);
  assert.throws(() => validateConfig({ executors: ["claude-code"] }, "c.json"), /unknown executor/);
  assert.throws(() => validateConfig({ gemini: { maxAttempts: "3" } }, "c.json"), /maxAttempts/);
  assert.throws(() => validateConfig({ gemini: { allowed: [] } }, "c.json"), /unknown key "gemini.allowed"/);
  assert.throws(() => validateConfig({ snapshot: ["../secrets.txt"] }, "c.json"), /inside the project/);
  assert.deepEqual(validateConfig({ _comment: "fine", $schema: "x" }, "c.json"), {});
});

test("invalid JSON names the file", () => {
  const dir = project();
  mkdirSync(path.join(dir, ".odw"), { recursive: true });
  writeFileSync(path.join(dir, ".odw", "config.json"), "{ nope");
  assert.throws(() => loadConfig(dir), /config\.json: invalid JSON/);
});

test("a configured gemini policy file must exist", () => {
  const dir = project({ gemini: { policy: [".odw/missing.toml"] } });
  const { config } = loadConfig(dir);
  assert.throws(() => buildExecutors(config, dir), /policy file not found/);
});

test("preflight: unregistered executors, disallowed models, determinism — before any token is spent", () => {
  const gemini = { allowedModels: ["gemini-3.8-flash"], modelAliases: { flash: "gemini-3.8-flash" } };
  const ok = `${META}await agent('a', { executor: 'gemini', model: 'flash' })`;
  assert.deepEqual(preflightScript(ok, { executors: ["gemini"], gemini }), []);

  const bad = `${META}await agent('a', { executor: 'claude' })\nawait agent('b', { executor: 'gemini', model: 'gemini-2.5-pro' })`;
  const problems = preflightScript(bad, { executors: ["gemini"], gemini });
  assert.equal(problems.length, 2, "a gemini-only registry checks every model literal");
  assert.match(problems[0]!, /executor "claude" is not registered/);
  assert.match(problems[1]!, /"gemini-2.5-pro" is not in gemini.allowedModels/);

  const mixed = preflightScript(bad, { executors: ["claude", "gemini"], gemini });
  assert.equal(mixed.length, 0, "with several CLIs in play a model literal may belong to claude");

  const badModel = `${META}await agent('b', { executor: 'gemini', model: 'gemini-2.5-pro' })`;
  assert.match(preflightScript(badModel, { executors: ["gemini"], gemini })[0]!, /not in gemini.allowedModels/);

  const templated = `${META}const m = 'x'; await agent('b', { executor: 'gemini', model: \`\${m}\` })`;
  assert.deepEqual(preflightScript(templated, { executors: ["gemini"], gemini }), []);

  const clock = `${META}const t = Date.now()`;
  assert.match(preflightScript(clock, { executors: ["gemini"] })[0]!, /deterministic/);
});

test("snapshot copies files and reports exactly what changed", () => {
  const dir = project();
  writeFileSync(path.join(dir, "a.txt"), "one");
  writeFileSync(path.join(dir, "b.txt"), "two");
  const snap = takeSnapshot(dir, ["a.txt", "b.txt", "new.txt"], path.join(dir, "run", "snapshot"));
  assert.deepEqual(changedSinceSnapshot(dir, snap), []);
  writeFileSync(path.join(dir, "a.txt"), "ONE");
  writeFileSync(path.join(dir, "new.txt"), "created");
  assert.deepEqual(changedSinceSnapshot(dir, snap), ["a.txt", "new.txt"]);
});
