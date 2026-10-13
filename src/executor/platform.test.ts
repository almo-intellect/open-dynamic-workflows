// platform.test.ts — Windows command resolution (npm .cmd shims → node + entry) and
// cmd.exe quoting. Shim-resolution tests touch the file system and only run on Windows.
//
// Run: npx tsx --test src/executor/platform.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseNpmCmdShim, quoteForCmd, resolveCommand } from "./platform.js";

// What npm writes for `npm install -g @google/gemini-cli` (cmd-shim, current format).
const MODERN_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" %*',
].join("\r\n");

const LEGACY_SHIM = '@"%~dp0\\node.exe"  "%~dp0\\node_modules\\some-cli\\bin\\cli.js" %*';

test("parseNpmCmdShim extracts the JS entry from current and legacy npm shims", () => {
  assert.equal(parseNpmCmdShim(MODERN_SHIM), "node_modules\\@google\\gemini-cli\\bundle\\gemini.js");
  assert.equal(parseNpmCmdShim(LEGACY_SHIM), "node_modules\\some-cli\\bin\\cli.js");
  assert.equal(parseNpmCmdShim("@echo off\r\ncall something.exe %*"), null);
});

test("resolveCommand is the identity off Windows", () => {
  assert.deepEqual(resolveCommand("gemini", {}, "linux"), { file: "gemini", prefixArgs: [], shell: false });
});

test(
  "resolveCommand unwraps an npm shim found on PATH into node + entry (Windows)",
  { skip: process.platform !== "win32" },
  () => {
    const bin = mkdtempSync(path.join(tmpdir(), "odw-shim-"));
    const entry = path.join(bin, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "// fake entry");
    writeFileSync(path.join(bin, "fakegemini.cmd"), MODERN_SHIM);
    const resolved = resolveCommand("fakegemini", { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32");
    assert.deepEqual(resolved, { file: process.execPath, prefixArgs: [entry], shell: false });
  },
);

test(
  "resolveCommand falls back to cmd.exe for a non-npm .cmd, and passes .exe through (Windows)",
  { skip: process.platform !== "win32" },
  () => {
    const bin = mkdtempSync(path.join(tmpdir(), "odw-shim-"));
    writeFileSync(path.join(bin, "custom.cmd"), "@echo off\r\necho hi\r\n");
    const env = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    assert.deepEqual(resolveCommand("custom", env, "win32"), {
      file: path.join(bin, "custom.cmd"),
      prefixArgs: [],
      shell: true,
    });
    assert.deepEqual(resolveCommand(process.execPath, env, "win32"), {
      file: process.execPath,
      prefixArgs: [],
      shell: false,
    });
  },
);

test("quoteForCmd quotes only when needed and doubles embedded quotes", () => {
  assert.equal(quoteForCmd("--model"), "--model");
  assert.equal(quoteForCmd("C:\\Program Files\\x.toml"), '"C:\\Program Files\\x.toml"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
  assert.equal(quoteForCmd(""), '""');
});
