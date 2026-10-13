// stream-json.test.ts — unit tests for the pure stream-json reducer. No I/O, no
// subprocess: we feed hand-built event arrays / lines and assert the fold result.
// These guard reduceStreamJsonEvents/parseStreamJsonLine against executor refactors.
//
// Run: npx tsx --test src/executor/claude/stream-json.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceStreamJsonEvents, parseStreamJsonLine } from "./stream-json.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers: tiny builders for the two event shapes we care about.
// ────────────────────────────────────────────────────────────────────────────

/** An `assistant` event whose message.content is a single text block. */
function assistantText(text: string): any {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

// ────────────────────────────────────────────────────────────────────────────
// (1) Multiple assistant events: their text blocks concatenate in order.
// ────────────────────────────────────────────────────────────────────────────

test("(1) concatenates text from multiple assistant events (in order)", () => {
  const events = [
    assistantText("Hello, "),
    assistantText("brave "),
    // One assistant event may itself carry several content blocks, including
    // non-text blocks (e.g. tool_use) which must be ignored for text.
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "noop", input: {} },
          { type: "text", text: "new " },
          { type: "text", text: "world" },
        ],
      },
    },
    // `user` (tool result) events contribute nothing to the assistant text.
    { type: "user", message: { content: [{ type: "text", text: "IGNORE ME" }] } },
    { type: "result", subtype: "success", is_error: false },
  ];

  const out = reduceStreamJsonEvents(events);
  assert.equal(out.text, "Hello, brave new world");
});

// ────────────────────────────────────────────────────────────────────────────
// (2) Terminal `result` event drives subtype/is_error/cost/session/usage/output.
// ────────────────────────────────────────────────────────────────────────────

test("(2) reads subtype/is_error/cost/session/usage/structured_output from result", () => {
  const events = [
    assistantText("answer"),
    {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.0123,
      session_id: "sess-abc",
      usage: { input_tokens: 42, output_tokens: 7 },
      structured_output: { ok: true, items: [1, 2, 3] },
    },
  ];

  const out = reduceStreamJsonEvents(events);
  assert.equal(out.text, "answer");
  assert.equal(out.resultSubtype, "success");
  assert.equal(out.isError, false);
  assert.equal(out.costUsd, 0.0123);
  assert.equal(out.sessionId, "sess-abc");
  assert.equal(out.usage.inputTokens, 42);
  assert.equal(out.usage.outputTokens, 7);
  assert.deepEqual(out.structuredOutput, { ok: true, items: [1, 2, 3] });
});

// ────────────────────────────────────────────────────────────────────────────
// (2b) A non-"success" result subtype implies isError when is_error is absent.
// ────────────────────────────────────────────────────────────────────────────

test("(2b) non-success subtype without is_error is treated as an error", () => {
  const out = reduceStreamJsonEvents([
    assistantText("partial"),
    // No explicit is_error → derived from subtype !== "success".
    { type: "result", subtype: "error_max_turns", total_cost_usd: 0.5 },
  ]);

  assert.equal(out.resultSubtype, "error_max_turns");
  assert.equal(out.isError, true);
  // The result WAS seen, so cost survives (not zeroed like the no-result case).
  assert.equal(out.costUsd, 0.5);
  // structuredOutput stays undefined when the key is absent from the event.
  assert.equal(out.structuredOutput, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// (3) No `result` event → isError, subtype "error_during_execution", all zeroed.
// ────────────────────────────────────────────────────────────────────────────

test("(3) missing result event yields an error outcome with zeroed cost/usage", () => {
  // Assistant text still accumulates; only the result-derived fields are reset.
  const out = reduceStreamJsonEvents([
    assistantText("streamed "),
    assistantText("but never finished"),
  ]);

  assert.equal(out.text, "streamed but never finished");
  assert.equal(out.isError, true);
  assert.equal(out.resultSubtype, "error_during_execution");
  assert.equal(out.costUsd, 0);
  assert.equal(out.usage.inputTokens, 0);
  assert.equal(out.usage.outputTokens, 0);
  // No session_id was ever observed.
  assert.equal(out.sessionId, null);
});

// ────────────────────────────────────────────────────────────────────────────
// (3b) An empty event stream is the degenerate no-result case.
// ────────────────────────────────────────────────────────────────────────────

test("(3b) empty event array is an error with empty text and zeroed fields", () => {
  const out = reduceStreamJsonEvents([]);
  assert.equal(out.text, "");
  assert.equal(out.isError, true);
  assert.equal(out.resultSubtype, "error_during_execution");
  assert.equal(out.costUsd, 0);
  assert.equal(out.sessionId, null);
  assert.equal(out.usage.inputTokens, 0);
  assert.equal(out.usage.outputTokens, 0);
  assert.equal(out.structuredOutput, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// (3c) Defensive: malformed / non-object events are skipped, not fatal.
// ────────────────────────────────────────────────────────────────────────────

test("(3c) malformed entries are skipped; a later valid result still wins", () => {
  const out = reduceStreamJsonEvents([
    null,
    "not an object",
    42,
    assistantText("kept"),
    // An assistant event missing message/content contributes empty text.
    { type: "assistant" },
    { type: "result", subtype: "success", is_error: false, session_id: "s9" },
  ] as any[]);

  assert.equal(out.text, "kept");
  assert.equal(out.isError, false);
  assert.equal(out.resultSubtype, "success");
  assert.equal(out.sessionId, "s9");
});

// ────────────────────────────────────────────────────────────────────────────
// (4) parseStreamJsonLine: blank/whitespace/garbage → null; valid line → object.
// ────────────────────────────────────────────────────────────────────────────

test("(4) parseStreamJsonLine returns null for blank, whitespace and bad lines", () => {
  assert.equal(parseStreamJsonLine(""), null);
  assert.equal(parseStreamJsonLine("   "), null);
  assert.equal(parseStreamJsonLine("\t \n"), null);
  // Not valid JSON.
  assert.equal(parseStreamJsonLine("{ not json"), null);
  assert.equal(parseStreamJsonLine("undefined"), null);
});

test("(4) parseStreamJsonLine parses a valid line into the expected object", () => {
  const parsed = parseStreamJsonLine(
    '  {"type":"result","subtype":"success","is_error":false}  ',
  );
  assert.deepEqual(parsed, {
    type: "result",
    subtype: "success",
    is_error: false,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (4b) End-to-end: parse a multi-line stream-json transcript, then reduce it.
// ────────────────────────────────────────────────────────────────────────────

test("(4b) parse-then-reduce a realistic line-delimited transcript", () => {
  const transcript = [
    "", // leading blank line is dropped by the parser
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-init" }),
    JSON.stringify(assistantText("The answer ")),
    JSON.stringify(assistantText("is 42.")),
    "   ", // stray whitespace line
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.001,
      session_id: "s-final",
      usage: { input_tokens: 10, output_tokens: 3 },
    }),
    "", // trailing newline artifact
  ].join("\n");

  const events = transcript
    .split("\n")
    .map(parseStreamJsonLine)
    .filter((e): e is any => e !== null);

  // Blank/whitespace lines were dropped; four real events remain
  // (system/init + two assistant + result).
  assert.equal(events.length, 4);

  const out = reduceStreamJsonEvents(events);
  assert.equal(out.text, "The answer is 42.");
  assert.equal(out.resultSubtype, "success");
  assert.equal(out.isError, false);
  assert.equal(out.costUsd, 0.001);
  // The final result's session_id wins over the earlier system event's.
  assert.equal(out.sessionId, "s-final");
  assert.equal(out.usage.inputTokens, 10);
  assert.equal(out.usage.outputTokens, 3);
});

// ────────────────────────────────────────────────────────────────────────────
// (5) Defensive numeric coercion: non-finite / wrong-typed numbers fold to 0.
// ────────────────────────────────────────────────────────────────────────────

test("(5) non-numeric cost/usage fields coerce to zero", () => {
  const out = reduceStreamJsonEvents([
    {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: "free", // wrong type
      usage: { input_tokens: null, output_tokens: "lots" },
    },
  ]);

  assert.equal(out.costUsd, 0);
  assert.equal(out.usage.inputTokens, 0);
  assert.equal(out.usage.outputTokens, 0);
});
