// Public API.
// The core: types + the runtime entry.
export * from "./types.js";
export { runWorkflow } from "./runtime/run.js";

// Bundled executor adapters — ONE adapter per CLI, swap or extend for your model/harness.
export { claudeExecutor, buildClaudeArgs } from "./executor/claude/claude.js";
export { codexExecutor, buildCodexArgs } from "./executor/codex/codex.js";
export {
  geminiExecutor,
  createGeminiExecutor,
  buildGeminiArgs,
  buildGeminiPrompt,
  resolveGeminiModel,
  DEFAULT_READ_ONLY_AGENT_TYPES,
  type GeminiExecutorOptions,
} from "./executor/gemini/gemini.js";

// Pure reducers + the shared subprocess driver — exposed so hosts can build their own adapters.
export { reduceStreamJsonEvents, parseStreamJsonLine } from "./executor/claude/stream-json.js";
export { reduceCodexEvents, parseCodexJsonLine } from "./executor/codex/codex-jsonl.js";
export {
  reduceGeminiStreamEvents,
  parseGeminiStreamLine,
  extractJsonObject,
  type GeminiOutcome,
  type GeminiFailureKind,
} from "./executor/gemini/gemini-stream.js";
export { makeSubprocessExecutor } from "./executor/subprocess.js";
export { resolveCommand, killProcessTree } from "./executor/platform.js";

// Per-project CLI configuration (<cwd>/.odw/config.json) and the static preflight.
export {
  loadConfig,
  validateConfig,
  buildExecutors,
  preflightScript,
  type OdwConfig,
  type GeminiConfig,
} from "./config.js";

import { claudeExecutor } from "./executor/claude/claude.js";
import { codexExecutor } from "./executor/codex/codex.js";
import { geminiExecutor } from "./executor/gemini/gemini.js";

// Out-of-the-box registry, ready to pass as RunOptions.executors (or extend). This is
// NOT a "default executor": every agent() must still name one explicitly via {executor}.
export const builtinExecutors = { claude: claudeExecutor, codex: codexExecutor, gemini: geminiExecutor };
