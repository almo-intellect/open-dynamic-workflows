// codex-jsonl.ts — pure reducer over `codex exec --json` stdout
// (one JSON object per line). No I/O, no subprocess; just parse + fold.

/** Folded outcome of a codex JSONL event sequence. */
export interface CodexOutcome {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  resultSubtype: string;
  isError: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

/** JSON.parse one line; returns null on blank/whitespace or parse failure. */
export function parseCodexJsonLine(line: string): any | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toFiniteNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Fold the event stream into a single outcome. Defensive: tolerates missing
 * fields, skips malformed events, and treats unknown `item.type` values as
 * pass-through (never throws). `sessionId` comes from `thread.started`; `text`
 * is the last `agent_message` item's text; usage + terminal success come from
 * `turn.completed`; failures come from `turn.failed` / `error`.
 *
 * When `opts.schema` is set, `text` is JSON.parse'd into `structuredOutput`;
 * a parse failure flags `isError` rather than throwing. `isError` is true when
 * no turn completed, a turn failed, or a non-zero exit code was supplied.
 *
 */
export function reduceCodexEvents(
  events: any[],
  opts?: { schema?: boolean; exitCode?: number | null },
): CodexOutcome {
  let lastAgentText: string | null = null;
  let sessionId: string | null = null;
  let sawCompleted = false;
  let sawTurnFailed = false;
  let errorMessage = "";

  const outcome: CodexOutcome = {
    text: "",
    sessionId: null,
    resultSubtype: "error_during_execution",
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  for (const event of events) {
    if (!isObject(event)) continue;
    const type = event["type"];

    if (type === "thread.started") {
      const tid = event["thread_id"];
      if (typeof tid === "string") sessionId = tid;
      continue;
    }

    if (type === "item.completed") {
      // The agent's final answer (or a JSON string under structured output)
      // arrives as a completed `agent_message` item. Take the last one.
      const item = event["item"];
      if (isObject(item) && item["type"] === "agent_message") {
        const text = item["text"];
        if (typeof text === "string") lastAgentText = text;
      }
      // Any other item.type (command_execution / file_change / reasoning /
      // mcp_tool_call / web_search / todo_list / error …): ignore, never crash.
      continue;
    }

    if (type === "turn.completed") {
      sawCompleted = true;
      const usage = event["usage"];
      if (isObject(usage)) {
        outcome.usage.inputTokens = toFiniteNumber(usage["input_tokens"]);
        outcome.usage.outputTokens = toFiniteNumber(usage["output_tokens"]);
      }
      continue;
    }

    if (type === "turn.failed") {
      sawTurnFailed = true;
      const error = event["error"];
      if (isObject(error) && typeof error["message"] === "string") {
        errorMessage = error["message"];
      }
      continue;
    }

    if (type === "error") {
      // Non-terminal stream error; keep the message for debugging fallback.
      const message = event["message"];
      if (typeof message === "string") errorMessage = message;
      continue;
    }

    // thread.started's siblings (turn.started / item.started / item.updated)
    // and any unknown top-level type: ignore.
  }

  outcome.sessionId = sessionId;
  outcome.text = lastAgentText ?? "";

  const exitCode = opts?.exitCode;
  let isError =
    !sawCompleted ||
    sawTurnFailed ||
    (exitCode != null && exitCode !== 0);

  // When structured output is requested, parse the agent text as JSON. A parse
  // failure is an error (flag it, don't throw).
  if (opts?.schema) {
    try {
      outcome.structuredOutput = JSON.parse(outcome.text);
    } catch {
      isError = true;
    }
  }

  outcome.isError = isError;
  outcome.resultSubtype = isError ? "error_during_execution" : "success";

  // On failure with no agent text, surface the captured error message as text
  // so callers have something actionable to log.
  if (isError && outcome.text.length === 0 && errorMessage.length > 0) {
    outcome.text = errorMessage;
  }

  return outcome;
}
