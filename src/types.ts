// types.ts — the FROZEN contract for the whole runtime.
//
// Every module codes against these types. Do not change a shape without updating
// every consumer. Public API types and internal cross-module shapes both live here so
// there is one source of truth.

// ────────────────────────────────────────────────────────────────────────────
// JSON Schema (loose — we pass it through to the CLI and to ajv)
// ────────────────────────────────────────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;

// ────────────────────────────────────────────────────────────────────────────
// meta block
// ────────────────────────────────────────────────────────────────────────────

export interface PhaseMeta {
  readonly title: string;
  readonly detail?: string;
  readonly model?: string;
}

export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly phases?: ReadonlyArray<PhaseMeta>;
  readonly model?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// agent() options
// ────────────────────────────────────────────────────────────────────────────

export interface AgentOptions {
  /** Required: names one key of RunOptions.executors. Enforced at runtime — missing or unknown throws. */
  executor: string;
  /** Display label; defaults to a truncated prompt or `agent-N`. */
  label?: string;
  /** Explicit progress group. Use inside parallel()/pipeline() stages. */
  phase?: string;
  /** JSON Schema forcing structured output; agent() then resolves to the object. */
  schema?: JsonSchema;
  /** Model override for this call. */
  model?: string;
  /** Run this agent in a fresh git worktree (parallel file mutation). EXPENSIVE. */
  isolation?: "worktree";
  /** Named subagent system-prompt preset. */
  agentType?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// hooks injected into the script scope
// ────────────────────────────────────────────────────────────────────────────

export type AgentFn = (prompt: string, opts?: AgentOptions) => Promise<unknown>;

export type Thunk<T = unknown> = () => Promise<T>;
export type ParallelFn = (thunks: ReadonlyArray<Thunk>) => Promise<Array<unknown>>;

/** A pipeline stage: receives the previous stage's result, the original item, and index. */
export type PipelineStage = (
  prev: unknown,
  original: unknown,
  index: number,
) => Promise<unknown> | unknown;
export type PipelineFn = (
  items: ReadonlyArray<unknown>,
  ...stages: PipelineStage[]
) => Promise<Array<unknown>>;

export type PhaseFn = (title: string) => void;
export type LogFn = (message: string) => void;

export type WorkflowRef = string | { scriptPath: string };
export type WorkflowFn = (ref: WorkflowRef, args?: unknown) => Promise<unknown>;

/** The full set of globals bound into the workflow script's vm context. */
export interface ScriptHooks {
  agent: AgentFn;
  parallel: ParallelFn;
  pipeline: PipelineFn;
  phase: PhaseFn;
  log: LogFn;
  args: unknown;
  workflow: WorkflowFn;
}

// ────────────────────────────────────────────────────────────────────────────
// executor (claude --print subprocess)
// ────────────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ExecOptions {
  prompt: string;
  cwd: string;
  model?: string;
  schema?: JsonSchema;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  env?: Record<string, string>;
  /** Path to write the raw stream-json trace for debugging. */
  tracePath?: string;
  signal?: AbortSignal;
  /**
   * The agentType the script asked for, verbatim. Executors may map it to CLI-level
   * permissions — the gemini executor runs Explore/Plan agents read-only.
   */
  agentType?: string;
}

export type ResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_max_structured_output_retries"
  | "error_during_execution"
  | "timeout"
  | "idle_timeout"
  | (string & {});

export interface ExecResult {
  text: string;
  structuredOutput?: unknown;
  sessionId: string | null;
  costUsd: number;
  durationMs: number;
  resultSubtype: ResultSubtype;
  isError: boolean;
  usage: TokenUsage;
}

/** The executor function signature; the only thing that touches `claude`. */
export type Executor = (opts: ExecOptions) => Promise<ExecResult>;

// ────────────────────────────────────────────────────────────────────────────
// progress events
// ────────────────────────────────────────────────────────────────────────────

export type ProgressEvent =
  | {
      type: "run_start";
      runId: string;
      /** Where this run's journal/events/traces live (absolute). */
      runDir?: string;
      meta: WorkflowMeta;
      ts: string;
    }
  | { type: "phase_start"; phase: string; ts: string }
  | {
      type: "agent_start";
      agentId: number;
      label: string;
      phase: string | null;
      cached: boolean;
      ts: string;
    }
  | {
      type: "agent_end";
      agentId: number;
      label: string;
      phase: string | null;
      ok: boolean;
      cached: boolean;
      /** true when the agent was cancelled (run aborted) rather than failing on its own. */
      skipped?: boolean;
      costUsd: number;
      outputTokens: number;
      durationMs: number;
      error?: string;
      ts: string;
    }
  | { type: "log"; message: string; phase: string | null; ts: string }
  | { type: "workflow_start"; name: string; ts: string }
  | { type: "workflow_end"; name: string; ok: boolean; ts: string }
  | { type: "run_end"; runId: string; ok: boolean; tokensSpent: number; durationMs: number; ts: string };

export type EventSink = (event: ProgressEvent) => void;

// ────────────────────────────────────────────────────────────────────────────
// journal (resume / caching)
// ────────────────────────────────────────────────────────────────────────────

export interface AgentRecord {
  index: number;
  /** sha256(prompt + stableStringify(opts)). */
  key: string;
  label: string;
  phase: string | null;
  /** The resolved agent() return value (string | object | null). */
  result: unknown;
  cached: boolean;
  outputTokens: number;
  ts: string;
}

// ────────────────────────────────────────────────────────────────────────────
// public entry API
// ────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  resumeFromRunId?: string;
  cwd?: string;
  model?: string;
  runDir?: string;
  concurrency?: number;
  onEvent?: EventSink;
  registryDir?: string;
  /** Required named registry of executors. Each agent() picks one by key via AgentOptions.executor; missing/unknown throws. */
  executors: Record<string, Executor>;
  /** Per-agent default timeout. */
  agentTimeoutMs?: number;
  /**
   * External cancellation. When it aborts, in-flight agent subprocesses are killed
   * (process-group SIGKILL) and the run unwinds: parallel()/pipeline() re-throw instead
   * of swallowing to null, so runWorkflow() rejects. Already-completed agents stay
   * recorded in the journal, so a later resumeFromRunId replays them with zero spend.
   */
  signal?: AbortSignal;
}

export interface WorkflowResult {
  runId: string;
  scriptPath: string;
  meta: WorkflowMeta;
  /** Whatever the script returned (or undefined). */
  value: unknown;
  events: ProgressEvent[];
  tokensSpent: number;
  agentCount: number;
  durationMs: number;
}

// ────────────────────────────────────────────────────────────────────────────
// internal shared run context (passed to hooks by run.ts)
// ────────────────────────────────────────────────────────────────────────────

export interface RunContext {
  runId: string;
  runDir: string;
  cwd: string;
  defaultModel?: string;
  registryDir?: string;
  /** Named executor registry; agent() resolves AgentOptions.executor against this map. */
  executors: Record<string, Executor>;
  agentTimeoutMs?: number;
  /** Concurrency cap. */
  concurrency: number;
  /** Nesting depth (0 = top-level; >0 forbids further workflow()). */
  depth: number;
  emit: EventSink;
  abort: AbortSignal;
  /** Current phase() cursor (mutable). */
  currentPhase: { value: string | null };
  /** Monotonic agent id allocator + 1000 cap enforcement. */
  nextAgentId(): number;
  /** Resume cache lookup by content key; returns the cached record or undefined. */
  takeCached(key: string): AgentRecord | undefined;
  /** Append a freshly-produced (or cache-confirmed) record to the journal. */
  record(rec: AgentRecord): void;
  /** Accumulate output tokens for the run's tokensSpent metric (observability only; no ceiling). */
  addTokens(n: number): void;
}

export const TOTAL_AGENT_CAP = 1000;
