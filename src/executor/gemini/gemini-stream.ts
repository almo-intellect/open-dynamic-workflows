// gemini-stream.ts — pure reducer over `gemini --output-format stream-json` stdout
// (one JSON object per line). No I/O, no subprocess; just parse + fold.
//
// Event shapes (Gemini CLI ≥ 0.60): init{session_id,model} · message{role,content,delta}
// · tool_use{tool_name,tool_id,parameters} · tool_result{tool_id,status,output,error?}
// · tool_use{tool_name,tool_id,parameters} · tool_result{tool_id,status,output,error?}
// · error{severity,message} (non-terminal: loop detection, quota, blocked tools) ·
// result{status,error?,stats{input_tokens,output_tokens,cached,models{…}}} last.

/** How a failed run should be handled by the retry layer in gemini.ts. */
export type GeminiFailureKind =
  | "none" // success
  | "transient" // retry with a fresh process (quota blip, network, startup crash)
  | "repairable" // the work happened but the final answer is unusable → resume the session and ask again
  | "fatal"; // retrying cannot help (auth, config, bad model, turn limit)

/** Folded outcome of a gemini stream-json event sequence. */
export interface GeminiOutcome {
  /** Final answer: assistant text after the last tool call. */
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  resultSubtype: string;
  isError: boolean;
  failureKind: GeminiFailureKind;
  /** One-line reason when isError ("" on success). */
  errorMessage: string;
  /** Non-terminal `error` events (warnings), verbatim. */
  warnings: string[];
  loopDetected: boolean;
  /** Models that served requests (result.stats.models keys) — reveals silent fallbacks. */
  modelsUsed: string[];
  toolCalls: number;
  /** Successful tool calls that may have changed the workspace (edits, shell, unknown tools). */
  mutatingCalls: number;
  /** Tool calls the policy engine refused, as "tool: message". */
  deniedTools: string[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

/** JSON.parse one line; returns null on blank/whitespace or parse failure. */
export function parseGeminiStreamLine(line: string): any | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toFiniteNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function oneLine(s: string, max = 300): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Pull one JSON object out of a model reply. Accepts the bare object, a ```json fenced
 * block, or the outermost {…} span inside surrounding prose. Never throws.
 */
export function extractJsonObject(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text.replace(/^﻿/, "").trim();
  if (t.length === 0) return { ok: false, error: "empty response" };
  const candidates: string[] = [t];
  const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/i.exec(t)?.[1];
  if (fenced !== undefined) candidates.push(fenced.trim());
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(t.slice(first, last + 1));
  let lastError = "no JSON object found";
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (isObject(value) && !Array.isArray(value)) return { ok: true, value };
      lastError = "top-level JSON value is not an object";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Best one-line failure reason from stderr. Failures before the stream starts (argv,
 * settings, auth bootstrap) land only here — as a `[ERROR] {json}` payload or plain text.
 */
export function stderrReason(stderr: string): string {
  const at = stderr.lastIndexOf("[ERROR]");
  if (at !== -1) {
    const rest = stderr.slice(at + "[ERROR]".length);
    const open = rest.indexOf("{");
    const close = rest.lastIndexOf("}");
    if (open !== -1 && close > open) {
      try {
        const payload: unknown = JSON.parse(rest.slice(open, close + 1));
        if (isObject(payload)) {
          const message = str(isObject(payload["error"]) ? payload["error"]["message"] : undefined);
          if (message.length > 0) return oneLine(message);
        }
      } catch {
        /* not JSON — fall through to the line scan */
      }
    }
  }
  // Startup chatter ("Warning: True color…", "Ripgrep is not available…") is never the reason.
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/^(\[(WARN|INFO|DEBUG)\]|Warning:)/i.test(l) &&
        !/^Ripgrep is not available/i.test(l),
    );
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (/error|exception|fatal|denied|invalid|failed|not found/i.test(line)) return oneLine(line);
  }
  return oneLine(lines[lines.length - 1] ?? "");
}

// Gemini CLI exit codes that retrying cannot fix: auth (41), input (42), sandbox (44),
// config (52), session turn limit (53), tool execution e.g. disk full (54), cancelled (130).
const FATAL_EXIT_CODES = new Set([41, 42, 44, 52, 53, 54, 130]);
const FATAL_RE =
  /API key|PERMISSION_DENIED|UNAUTHENTICATED|\b40[134]\b|not found for API version|model .{0,80}not found|is not supported|Invalid approval mode|Error resuming session/i;

/**
 * Classify a run-level failure for the retry layer. Everything not provably fatal is
 * transient: quota blips, network errors, file-lock races while many CLIs boot at once,
 * and unexplained mid-run deaths are all worth one more try.
 */
export function classifyGeminiFailure(
  exitCode: number | null | undefined,
  message: string,
): GeminiFailureKind {
  if (exitCode != null && FATAL_EXIT_CODES.has(exitCode)) return "fatal";
  return FATAL_RE.test(message) ? "fatal" : "transient";
}

// Tools that only read. Any other tool that succeeded may have changed the workspace,
// which matters for retries: re-running an edit agent from scratch could apply its edits twice.
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "read_many_files",
  "glob",
  "grep_search",
  "list_directory",
  "google_web_search",
  "web_fetch",
  "codebase_investigator",
  "cli_help",
  "get_internal_docs",
  "update_topic",
  "complete_task",
  "read_mcp_resource",
  "list_mcp_resources",
]);

function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name) || name.startsWith("tracker_");
}

/**
 * Fold the event stream into a single outcome. Defensive: tolerates missing fields, skips
 * malformed events, ignores unknown types (never throws).
 *
 * - `text` is the assistant text AFTER the last tool call (what Gemini's own `-o json`
 *   reports); narration before tool calls is dropped, with the last non-empty segment as
 *   a fallback when the model ended on a tool call.
 * - A run whose `result` is missing or errored, or whose exit code is non-zero, fails with
 *   the best available reason (result.error → error event → stderr → exit code).
 * - The loop detector stops the response mid-way and only says so in an `error` event:
 *   that is a repairable failure, as is an empty answer or (with `schema`) unparseable JSON.
 *
 */
export function reduceGeminiStreamEvents(
  events: any[],
  opts?: { schema?: boolean; exitCode?: number | null; stderr?: string },
): GeminiOutcome {
  let sessionId: string | null = null;
  let segment = ""; // assistant text since the last tool call
  let lastNonEmptySegment = "";
  let toolCalls = 0;
  let mutatingCalls = 0;
  const toolNames = new Map<string, string>();
  const deniedTools: string[] = [];
  const warnings: string[] = [];
  let loopDetected = false;
  let streamError = "";
  let result: Record<string, any> | null = null;

  for (const event of events) {
    if (!isObject(event)) continue;
    switch (event["type"]) {
      case "init": {
        const sid = str(event["session_id"]);
        if (sid.length > 0) sessionId = sid;
        break;
      }
      case "message": {
        if (event["role"] === "assistant") segment += str(event["content"]);
        break;
      }
      case "tool_use": {
        toolCalls += 1;
        const id = str(event["tool_id"]);
        if (id.length > 0) toolNames.set(id, str(event["tool_name"]));
        if (segment.trim().length > 0) lastNonEmptySegment = segment;
        segment = "";
        break;
      }
      case "tool_result": {
        const tool = toolNames.get(str(event["tool_id"])) || "tool";
        if (event["status"] !== "error") {
          if (!isReadOnlyTool(tool)) mutatingCalls += 1;
          break;
        }
        const message = str(isObject(event["error"]) ? event["error"]["message"] : undefined);
        if (/denied by policy|not allowed|requires explicit user confirmation/i.test(message)) {
          deniedTools.push(`${tool}: ${oneLine(message, 160)}`);
        }
        break;
      }
      case "error": {
        const message = str(event["message"]);
        if (message.length === 0) break;
        warnings.push(message);
        if (/loop detected/i.test(message)) loopDetected = true;
        if (event["severity"] === "error") streamError = message;
        break;
      }
      case "result": {
        result = event;
        break;
      }
      default:
        // user `message` echoes and any future event types: ignore, never crash.
        break;
    }
  }

  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const modelsUsed: string[] = [];
  const stats = result !== null && isObject(result["stats"]) ? result["stats"] : null;
  if (stats !== null) {
    usage.inputTokens = toFiniteNumber(stats["input_tokens"]);
    usage.outputTokens = toFiniteNumber(stats["output_tokens"]);
    usage.cachedTokens = toFiniteNumber(stats["cached"]);
    if (isObject(stats["models"])) modelsUsed.push(...Object.keys(stats["models"]));
  }

  const text = (segment.trim().length > 0 ? segment : lastNonEmptySegment).trim();
  const outcome: GeminiOutcome = {
    text,
    sessionId,
    resultSubtype: "success",
    isError: false,
    failureKind: "none",
    errorMessage: "",
    warnings,
    loopDetected,
    modelsUsed,
    toolCalls,
    mutatingCalls,
    deniedTools,
    usage,
  };

  const exitCode = opts?.exitCode;
  const exitFailed = exitCode != null && exitCode !== 0;
  const resultFailed = result === null || result["status"] === "error";

  const fail = (kind: GeminiFailureKind, subtype: string, message: string): GeminiOutcome => {
    outcome.isError = true;
    outcome.failureKind = kind;
    outcome.resultSubtype = subtype;
    outcome.errorMessage = oneLine(message);
    return outcome;
  };

  if (resultFailed || exitFailed) {
    const resultError =
      result !== null && isObject(result["error"]) ? str(result["error"]["message"]) : "";
    const reason =
      resultError ||
      streamError ||
      stderrReason(opts?.stderr ?? "") ||
      (exitFailed ? `gemini exited with code ${exitCode}` : "gemini ended without a result event");
    const kind = classifyGeminiFailure(exitCode, reason);
    return fail(kind, kind === "fatal" ? "error_fatal" : "error_transient", reason);
  }
  if (loopDetected) {
    return fail(
      "repairable",
      "error_loop_detected",
      "Gemini CLI's loop detector cut the response short (repetitive output)",
    );
  }
  if (text.length === 0) {
    return fail("repairable", "error_empty_response", "the final response was empty");
  }
  if (opts?.schema) {
    const parsed = extractJsonObject(text);
    if (!parsed.ok) {
      return fail("repairable", "error_invalid_json", `final response is not a JSON object (${parsed.error})`);
    }
    outcome.structuredOutput = parsed.value;
  }
  return outcome;
}
