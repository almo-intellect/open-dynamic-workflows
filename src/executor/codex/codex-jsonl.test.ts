// codex-jsonl.test.ts — unit tests for the codex `exec --json` reducer (pure, no I/O).
// Fixtures use the REAL event shapes emitted by `codex exec --json` (one JSON object
// per line): thread.started{thread_id} → turn.started → item.completed{item:{type,text}}
// → turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}.
//
// Run: npx tsx --test src/executor/codex/codex-jsonl.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceCodexEvents, parseCodexJsonLine } from "./codex-jsonl.js";

// A real codex thread id is a UUID; pin one so we can assert sessionId round-trips.
const THREAD_ID = "67e55044-10b1-426f-9247-bb680e5fe0c8";

// ────────────────────────────────────────────────────────────────────────────
// Fixture builders — emit the exact line shapes codex writes, then JSON round-trip
// each one so the reducer is fed exactly what `parseCodexJsonLine` would yield from
// real stdout (no hand-built object shortcuts).
// ────────────────────────────────────────────────────────────────────────────

/** Parse a list of raw JSONL lines into events, dropping blank/bad lines (null). */
function eventsFromLines(lines: string[]): any[] {
  const out: any[] = [];
  for (const line of lines) {
    const ev = parseCodexJsonLine(line);
    if (ev !== null) out.push(ev);
  }
  return out;
}

function threadStarted(threadId: string): string {
  return JSON.stringify({ type: "thread.started", thread_id: threadId });
}

function turnStarted(): string {
  return JSON.stringify({ type: "turn.started" });
}

/** A completed agent_message item — `item.text` is the final answer (or a JSON string). */
function agentMessage(text: string, id = "item_0"): string {
  return JSON.stringify({
    type: "item.completed",
    item: { id, type: "agent_message", text },
  });
}

/** A completed item of some other type (web_search / command_execution / …) — must not crash. */
function otherItem(itemType: string, extra: Record<string, unknown> = {}, id = "item_x"): string {
  return JSON.stringify({
    type: "item.completed",
    item: { id, type: itemType, ...extra },
  });
}

/** turn.completed carries the cumulative usage breakdown (codex never reports USD). */
function turnCompleted(usage: {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}): string {
  return JSON.stringify({ type: "turn.completed", usage });
}

function turnFailed(message: string): string {
  return JSON.stringify({ type: "turn.failed", error: { message } });
}

/** A non-terminal stream error (precedes turn.failed on backend errors). */
function errorEvent(message: string): string {
  return JSON.stringify({ type: "error", message });
}

// ────────────────────────────────────────────────────────────────────────────
// (1) happy path: thread.started → turn.started → agent_message → turn.completed
// ────────────────────────────────────────────────────────────────────────────

test("(1) happy path: text/sessionId/usage extracted, isError=false, subtype=success", () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    agentMessage("hello"),
    turnCompleted({
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 42,
      reasoning_output_tokens: 7,
    }),
  ]);

  const outcome = reduceCodexEvents(events);

  assert.equal(outcome.text, "hello");
  assert.equal(outcome.sessionId, THREAD_ID);
  // usage maps input_tokens/output_tokens (cached/reasoning are ignored by this reducer).
  assert.equal(outcome.usage.inputTokens, 100);
  assert.equal(outcome.usage.outputTokens, 42);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
  // No structured output requested → structuredOutput stays undefined.
  assert.equal(outcome.structuredOutput, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// (2) schema: agent_message.text is a JSON string → structuredOutput is parsed
// ────────────────────────────────────────────────────────────────────────────

test('(2) schema: agent_message.text=\'{"ok":true}\' parses to structuredOutput {ok:true}', () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    agentMessage('{"ok":true}'),
    turnCompleted({
      input_tokens: 5,
      cached_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 0,
    }),
  ]);

  const outcome = reduceCodexEvents(events, { schema: true });

  assert.deepEqual(outcome.structuredOutput, { ok: true });
  // The raw JSON text is preserved on `text`; the run still succeeded.
  assert.equal(outcome.text, '{"ok":true}');
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
});

// ────────────────────────────────────────────────────────────────────────────
// (3) failure: error + turn.failed → isError=true, errorMessage surfaced as text
// ────────────────────────────────────────────────────────────────────────────

test("(3) failure: error + turn.failed → isError=true, error message surfaced as text", () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    errorEvent("backend failed"),
    turnFailed("turn failed: backend failed"),
  ]);

  const outcome = reduceCodexEvents(events);

  assert.equal(outcome.isError, true);
  assert.equal(outcome.resultSubtype, "error_during_execution");
  // No agent_message arrived, so the captured failure message is surfaced as text.
  assert.equal(outcome.text, "turn failed: backend failed");
  // sessionId is still recovered from thread.started even on failure.
  assert.equal(outcome.sessionId, THREAD_ID);
});

// ────────────────────────────────────────────────────────────────────────────
// (4) no turn.completed → isError=true (the turn never terminated cleanly)
// ────────────────────────────────────────────────────────────────────────────

test("(4) missing turn.completed → isError=true even with an agent message present", () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    agentMessage("partial answer"),
    // No turn.completed line.
  ]);

  const outcome = reduceCodexEvents(events);

  assert.equal(outcome.isError, true);
  assert.equal(outcome.resultSubtype, "error_during_execution");
  // The agent text we did see is still preserved.
  assert.equal(outcome.text, "partial answer");
});

// ────────────────────────────────────────────────────────────────────────────
// (5) non-zero exitCode → isError=true, even when turn.completed is present
// ────────────────────────────────────────────────────────────────────────────

test("(5) non-zero exitCode forces isError=true despite a clean turn.completed", () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    agentMessage("hello"),
    turnCompleted({
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    }),
  ]);

  const outcome = reduceCodexEvents(events, { exitCode: 1 });

  assert.equal(outcome.isError, true);
  assert.equal(outcome.resultSubtype, "error_during_execution");
  // exitCode 0 with the same stream is success — confirm the exit code is the deciding factor.
  const ok = reduceCodexEvents(events, { exitCode: 0 });
  assert.equal(ok.isError, false);
  assert.equal(ok.resultSubtype, "success");
});

// ────────────────────────────────────────────────────────────────────────────
// (6) unknown item.type (web_search / command_execution) does not crash the reducer
// ────────────────────────────────────────────────────────────────────────────

test("(6) unknown item types (web_search / command_execution) are tolerated, not fatal", () => {
  const events = eventsFromLines([
    threadStarted(THREAD_ID),
    turnStarted(),
    otherItem("web_search", { query: "rust async await" }, "item_0"),
    otherItem(
      "command_execution",
      { command: "ls", aggregated_output: "a.txt\n", exit_code: 0, status: "completed" },
      "item_1",
    ),
    agentMessage("hello", "item_2"),
    turnCompleted({
      input_tokens: 8,
      cached_input_tokens: 0,
      output_tokens: 4,
      reasoning_output_tokens: 0,
    }),
  ]);

  // Must not throw; unknown items are pass-through, the agent_message still wins.
  const outcome = reduceCodexEvents(events);

  assert.equal(outcome.text, "hello");
  assert.equal(outcome.isError, false);
  assert.equal(outcome.resultSubtype, "success");
});

// ────────────────────────────────────────────────────────────────────────────
// (7) parseCodexJsonLine: blank / malformed lines → null (so the driver skips them)
// ────────────────────────────────────────────────────────────────────────────

test("(7) parseCodexJsonLine returns null for blank / whitespace / malformed lines", () => {
  // Blank and whitespace-only lines → null.
  assert.equal(parseCodexJsonLine(""), null);
  assert.equal(parseCodexJsonLine("   "), null);
  assert.equal(parseCodexJsonLine("\t  \n"), null);

  // Non-JSON / truncated JSON → null (never throws).
  assert.equal(parseCodexJsonLine("not json at all"), null);
  assert.equal(parseCodexJsonLine('{"type":"thread.started"'), null);

  // A well-formed line still parses to the expected object.
  const ev = parseCodexJsonLine(threadStarted(THREAD_ID));
  assert.equal(ev.type, "thread.started");
  assert.equal(ev.thread_id, THREAD_ID);
});
