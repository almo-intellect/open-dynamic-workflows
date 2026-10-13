// gemini-stream.test.ts — unit tests for the `gemini --output-format stream-json` reducer
// (pure, no I/O). Fixtures follow the event shapes Gemini CLI 0.63 really emits:
// init{session_id,model} → message{role:"user"} → tool_use / tool_result →
// message{role:"assistant",delta:true}… → result{status,stats{…,models{…}}}.
//
// Run: npx tsx --test src/executor/gemini/gemini-stream.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyGeminiFailure,
  extractJsonObject,
  parseGeminiStreamLine,
  reduceGeminiStreamEvents,
  stderrReason,
} from "./gemini-stream.js";

const SESSION = "1b766541-d89a-4db8-9f76-885cbe220829";
const MODEL = "gemini-3.8-flash";

/** Parse raw JSONL lines exactly as the subprocess driver would, dropping blanks/garbage. */
function eventsFromLines(lines: string[]): any[] {
  const out: any[] = [];
  for (const line of lines) {
    const ev = parseGeminiStreamLine(line);
    if (ev !== null) out.push(ev);
  }
  return out;
}

const init = (session = SESSION): string =>
  JSON.stringify({ type: "init", timestamp: "2026-10-13T17:28:09.969Z", session_id: session, model: MODEL });
const userEcho = (content: string): string => JSON.stringify({ type: "message", role: "user", content });
const say = (content: string): string =>
  JSON.stringify({ type: "message", role: "assistant", content, delta: true });
const toolUse = (id: string, name: string): string =>
  JSON.stringify({ type: "tool_use", tool_name: name, tool_id: id, parameters: { file_path: "README.md" } });
const toolOk = (id: string): string =>
  JSON.stringify({ type: "tool_result", tool_id: id, status: "success", output: "Read lines 1-3 of 128" });
const toolError = (id: string, message: string): string =>
  JSON.stringify({
    type: "tool_result",
    tool_id: id,
    status: "error",
    output: "",
    error: { type: "TOOL_EXECUTION_ERROR", message },
  });
const warning = (message: string, severity = "warning"): string =>
  JSON.stringify({ type: "error", severity, message });
const stats = (models: string[] = [MODEL]) => ({
  total_tokens: 22459,
  input_tokens: 22196,
  output_tokens: 51,
  cached: 1200,
  input: 22196,
  duration_ms: 5748,
  tool_calls: 1,
  models: Object.fromEntries(
    models.map((m) => [m, { total_tokens: 1, input_tokens: 1, output_tokens: 1, cached: 0, input: 1 }]),
  ),
});
const resultOk = (models?: string[]): string =>
  JSON.stringify({ type: "result", status: "success", stats: stats(models) });
const resultError = (message: string): string =>
  JSON.stringify({
    type: "result",
    status: "error",
    error: { type: "Error", message },
    stats: stats(),
  });

test("happy path: final text is the assistant text after the last tool call; usage + models come from result", () => {
  const out = reduceGeminiStreamEvents(
    eventsFromLines([
      init(),
      userEcho("read the first line"),
      say("I'll read the file first."),
      toolUse("t1", "read_file"),
      toolOk("t1"),
      say("# Project title"),
      say(" (web app)"),
      resultOk(),
    ]),
    { exitCode: 0 },
  );
  assert.equal(out.isError, false);
  assert.equal(out.failureKind, "none");
  assert.equal(out.text, "# Project title (web app)");
  assert.equal(out.sessionId, SESSION);
  assert.deepEqual(out.usage, { inputTokens: 22196, outputTokens: 51, cachedTokens: 1200 });
  assert.deepEqual(out.modelsUsed, [MODEL]);
  assert.equal(out.toolCalls, 1);
  assert.equal(out.mutatingCalls, 0, "read_file does not change the workspace");
});

test("a run that ends on a tool call falls back to the last non-empty text segment", () => {
  const out = reduceGeminiStreamEvents(
    eventsFromLines([init(), say("final answer"), toolUse("t1", "update_topic"), toolOk("t1"), resultOk()]),
    { exitCode: 0 },
  );
  assert.equal(out.isError, false);
  assert.equal(out.text, "final answer");
});

test("schema: bare, fenced, and prose-wrapped JSON objects all parse", () => {
  for (const reply of [
    '{"ok":true}',
    '```json\n{"ok":true}\n```',
    'Here is the result:\n{"ok":true}\nThanks.',
  ]) {
    const out = reduceGeminiStreamEvents(eventsFromLines([init(), say(reply), resultOk()]), {
      schema: true,
      exitCode: 0,
    });
    assert.equal(out.isError, false, reply);
    assert.deepEqual(out.structuredOutput, { ok: true });
  }
});

test("schema: truncated JSON is a repairable error, not a crash", () => {
  const out = reduceGeminiStreamEvents(eventsFromLines([init(), say('{"file": "a.html", "ok": tr'), resultOk()]), {
    schema: true,
    exitCode: 0,
  });
  assert.equal(out.isError, true);
  assert.equal(out.failureKind, "repairable");
  assert.equal(out.resultSubtype, "error_invalid_json");
  assert.equal(out.sessionId, SESSION, "the session id survives so the answer can be repaired by resuming");
});

test("loop detection: a warning event marks the (cut-short) answer repairable", () => {
  const out = reduceGeminiStreamEvents(
    eventsFromLines([
      init(),
      say('{"codeSnippet": "/* ==========================='),
      warning("Loop detected, stopping execution"),
      resultOk(),
    ]),
    { schema: true, exitCode: 0 },
  );
  assert.equal(out.loopDetected, true);
  assert.equal(out.failureKind, "repairable");
  assert.equal(out.resultSubtype, "error_loop_detected");
  assert.ok(out.warnings.includes("Loop detected, stopping execution"));
});

test("empty final answer is repairable", () => {
  const out = reduceGeminiStreamEvents(eventsFromLines([init(), resultOk()]), { exitCode: 0 });
  assert.equal(out.failureKind, "repairable");
  assert.equal(out.resultSubtype, "error_empty_response");
});

test("result{status:error} surfaces its message and classifies quota errors as transient", () => {
  const out = reduceGeminiStreamEvents(
    eventsFromLines([init(), resultError("[API Error: 429 RESOURCE_EXHAUSTED: quota exceeded]")]),
    { exitCode: 1 },
  );
  assert.equal(out.isError, true);
  assert.equal(out.failureKind, "transient");
  assert.match(out.errorMessage, /RESOURCE_EXHAUSTED/);
});

test("startup crash (no events, stderr only) is transient and the reason comes from stderr", () => {
  const stderr =
    "Warning: True color (24-bit) support not detected.\n" +
    "Ripgrep is not available. Falling back to GrepTool.\n" +
    "Error: EBUSY: resource busy or locked, open 'C:\\Users\\me\\.gemini\\settings.json'\n";
  const out = reduceGeminiStreamEvents([], { exitCode: 1, stderr });
  assert.equal(out.failureKind, "transient");
  assert.equal(out.sessionId, null);
  assert.match(out.errorMessage, /EBUSY/);
});

test("auth failure exit code (41) with a [ERROR] JSON payload on stderr is fatal", () => {
  const stderr =
    '[ERROR] {\n  "error": {\n    "type": "FatalAuthenticationError",\n' +
    '    "message": "API key not valid. Please pass a valid API key."\n  }\n}\n';
  const out = reduceGeminiStreamEvents([], { exitCode: 41, stderr });
  assert.equal(out.failureKind, "fatal");
  assert.equal(out.resultSubtype, "error_fatal");
  assert.equal(out.errorMessage, "API key not valid. Please pass a valid API key.");
});

test("a missing result event is a failure even with exit code 0", () => {
  const out = reduceGeminiStreamEvents(eventsFromLines([init(), say("partial")]), { exitCode: 0 });
  assert.equal(out.isError, true);
  assert.equal(out.failureKind, "transient");
  assert.match(out.errorMessage, /without a result event/);
});

test("mutating tool calls are counted; policy denials are reported", () => {
  const out = reduceGeminiStreamEvents(
    eventsFromLines([
      init(),
      toolUse("w1", "write_file"),
      toolOk("w1"),
      toolUse("r1", "read_file"),
      toolOk("r1"),
      toolUse("s1", "run_shell_command"),
      toolError("s1", 'Tool execution for "Shell" denied by policy.'),
      say("done"),
      resultOk(),
    ]),
    { exitCode: 0 },
  );
  assert.equal(out.isError, false);
  assert.equal(out.mutatingCalls, 1);
  assert.deepEqual(out.deniedTools, ['run_shell_command: Tool execution for "Shell" denied by policy.']);
});

test("garbage lines and unknown event types are ignored", () => {
  const out = reduceGeminiStreamEvents(
    eventsFromLines(["", "not json", init(), JSON.stringify({ type: "future_event" }), say("ok"), resultOk()]),
    { exitCode: 0 },
  );
  assert.equal(out.isError, false);
  assert.equal(out.text, "ok");
});

test("classifyGeminiFailure: fatal exit codes and messages beat everything else", () => {
  assert.equal(classifyGeminiFailure(52, "anything"), "fatal");
  assert.equal(classifyGeminiFailure(1, "models/gemini-9 model was not found"), "fatal");
  assert.equal(classifyGeminiFailure(1, "Error resuming session: not found"), "fatal");
  assert.equal(classifyGeminiFailure(1, "socket hang up"), "transient");
  assert.equal(classifyGeminiFailure(null, "something odd"), "transient");
});

test("extractJsonObject rejects arrays and reports parse errors", () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.equal(extractJsonObject("[1,2]").ok, false);
  assert.equal(extractJsonObject("").ok, false);
  assert.equal(extractJsonObject("no json here").ok, false);
});

test("stderrReason ignores startup chatter", () => {
  assert.equal(stderrReason("Warning: True color (24-bit) support not detected.\n"), "");
  assert.equal(stderrReason("Ripgrep is not available.\nFatal: config broken\n"), "Fatal: config broken");
});
