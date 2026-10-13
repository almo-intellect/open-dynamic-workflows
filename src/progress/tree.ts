// progress/tree.ts — render ProgressEvents as a terminal live tree (TTY) or
// append-only plain lines (piped). The one non-literal piece per SPEC §10: a
// standalone process can't reach Claude Code's /workflows UI, so we reproduce the
// semantics — phases as group headers, agents as child rows (running/done/failed +
// cost + duration), log() as narrator lines above the tree.

import type { ProgressEvent, EventSink } from "../types.js";

// ── ANSI (only emitted when isTTY) ──────────────────────────────────────────
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const CYAN = `${ESC}36m`;
const YELLOW = `${ESC}33m`;

const GLYPH_RUNNING = "⟳";
const GLYPH_DONE = "✓";
const GLYPH_FAILED = "✗";
const GLYPH_SKIPPED = "⊘";

type AgentStatus = "running" | "done" | "failed" | "skipped";

interface AgentRow {
  agentId: number;
  label: string;
  status: AgentStatus;
  cached: boolean;
  costUsd: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

interface PhaseGroup {
  title: string; // display title; UNGROUPED_KEY uses a friendly header
  agents: AgentRow[];
}

const UNGROUPED_KEY = " ungrouped";
const UNGROUPED_TITLE = "ungrouped";

// ── exported public API ─────────────────────────────────────────────────────

export interface TreeRenderer {
  sink: EventSink;
  stop(): void;
}

/** One plain-text line for logging / non-TTY output. */
export function formatEvent(e: ProgressEvent): string {
  switch (e.type) {
    case "run_start":
      return `[run] start ${e.runId} — ${e.meta.name}`;
    case "phase_start":
      return `[phase] ${e.phase}`;
    case "agent_start":
      return `[agent ${e.agentId}] start: ${e.label}${phaseSuffix(e.phase)}${e.cached ? " (cached)" : ""}`;
    case "agent_end": {
      const status = e.skipped ? "skipped" : e.ok ? "done" : "failed";
      const parts = [`[agent ${e.agentId}] ${status}: ${e.label}${phaseSuffix(e.phase)}`];
      if (e.cached) parts.push("(cached)");
      else {
        parts.push(`$${e.costUsd.toFixed(4)}`);
        parts.push(`${e.outputTokens} tok`);
        parts.push(fmtDuration(e.durationMs));
      }
      if (!e.ok && e.error) parts.push(`— ${e.error}`);
      return parts.join(" ");
    }
    case "log":
      return `[log]${e.phase ? ` (${e.phase})` : ""} ${e.message}`;
    case "workflow_start":
      return `[workflow] ▸ ${e.name}`;
    case "workflow_end":
      return `[workflow] ${e.ok ? "done" : "failed"} ▸ ${e.name}`;
    case "run_end":
      return `[run] end ${e.runId} — ${e.ok ? "ok" : "failed"} · ${e.tokensSpent} tok · ${fmtDuration(e.durationMs)}`;
    default: {
      // exhaustiveness guard: unknown event ⇒ best-effort JSON
      const unknown: never = e;
      return `[?] ${JSON.stringify(unknown)}`;
    }
  }
}

export function createTreeRenderer(opts?: {
  stream?: NodeJS.WritableStream;
  enabled?: boolean;
}): TreeRenderer {
  const stream = opts?.stream ?? process.stderr;
  const isTTY = Boolean((stream as { isTTY?: boolean }).isTTY);
  const live = isTTY && opts?.enabled !== false;

  // shared model
  let runHeader: string | null = null;
  const logs: string[] = [];
  const phaseOrder: string[] = [];
  const phases = new Map<string, PhaseGroup>();
  const agentIndex = new Map<number, AgentRow>(); // agentId → row (for end updates)
  let stopped = false;
  let lastRenderedLines = 0;

  function groupFor(phase: string | null): PhaseGroup {
    const key = phase ?? UNGROUPED_KEY;
    let g = phases.get(key);
    if (!g) {
      g = { title: phase ?? UNGROUPED_TITLE, agents: [] };
      phases.set(key, g);
      phaseOrder.push(key);
    }
    return g;
  }

  function write(s: string): void {
    stream.write(s);
  }

  function appendPlain(e: ProgressEvent): void {
    write(`${formatEvent(e)}\n`);
  }

  function clearLive(): void {
    if (lastRenderedLines === 0) return;
    // move cursor up N lines and clear from cursor to end of screen
    write(`${ESC}${lastRenderedLines}A${ESC}0J`);
    lastRenderedLines = 0;
  }

  function renderLive(): void {
    clearLive();
    const lines = buildTree();
    if (lines.length > 0) write(`${lines.join("\n")}\n`);
    lastRenderedLines = lines.length;
  }

  function buildTree(): string[] {
    const out: string[] = [];
    if (runHeader) out.push(`${BOLD}${runHeader}${RESET}`);
    // narrator log lines above the tree
    for (const line of logs) out.push(`${DIM}• ${line}${RESET}`);
    for (const key of phaseOrder) {
      const g = phases.get(key);
      if (!g) continue;
      out.push(`${CYAN}▸ ${g.title}${RESET}`);
      for (const a of g.agents) out.push(`  ${renderRow(a)}`);
    }
    return out;
  }

  function renderRow(a: AgentRow): string {
    let glyph: string;
    let color: string;
    if (a.status === "running") {
      glyph = GLYPH_RUNNING;
      color = YELLOW;
    } else if (a.status === "done") {
      glyph = GLYPH_DONE;
      color = GREEN;
    } else if (a.status === "skipped") {
      glyph = GLYPH_SKIPPED;
      color = DIM;
    } else {
      glyph = GLYPH_FAILED;
      color = RED;
    }
    const head = `${color}${glyph}${RESET} ${a.label}`;
    if (a.status === "running") return head;
    if (a.status === "skipped") return `${head} ${DIM}(skipped)${RESET}`;
    if (a.cached) return `${head} ${DIM}(cached)${RESET}`;
    const meta = `${DIM}$${a.costUsd.toFixed(4)} · ${a.outputTokens} tok · ${fmtDuration(a.durationMs)}${RESET}`;
    const err = a.status === "failed" && a.error ? ` ${RED}— ${a.error}${RESET}` : "";
    return `${head} ${meta}${err}`;
  }

  const sink: EventSink = (e) => {
    if (stopped) return;

    // update model
    switch (e.type) {
      case "run_start":
        runHeader = `${e.meta.name} — ${e.meta.description}`;
        break;
      case "phase_start":
        groupFor(e.phase);
        break;
      case "agent_start": {
        const row: AgentRow = {
          agentId: e.agentId,
          label: e.label,
          status: "running",
          cached: e.cached,
          costUsd: 0,
          outputTokens: 0,
          durationMs: 0,
        };
        groupFor(e.phase).agents.push(row);
        agentIndex.set(e.agentId, row);
        break;
      }
      case "agent_end": {
        const row = agentIndex.get(e.agentId);
        if (row) {
          row.status = e.skipped ? "skipped" : e.ok ? "done" : "failed";
          row.cached = e.cached;
          row.costUsd = e.costUsd;
          row.outputTokens = e.outputTokens;
          row.durationMs = e.durationMs;
          if (e.error !== undefined) row.error = e.error;
        } else {
          // never saw the start (e.g. cached fast-path) — synthesize a row
          const synth: AgentRow = {
            agentId: e.agentId,
            label: e.label,
            status: e.skipped ? "skipped" : e.ok ? "done" : "failed",
            cached: e.cached,
            costUsd: e.costUsd,
            outputTokens: e.outputTokens,
            durationMs: e.durationMs,
          };
          if (e.error !== undefined) synth.error = e.error;
          groupFor(e.phase).agents.push(synth);
          agentIndex.set(e.agentId, synth);
        }
        break;
      }
      case "log":
        logs.push(e.message);
        break;
      // workflow_start / workflow_end / run_end carry no extra tree model state
      default:
        break;
    }

    // render
    if (live) renderLive();
    else appendPlain(e);
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (live) {
      renderLive();
      write("\n");
    }
  }

  return { sink, stop };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function phaseSuffix(phase: string | null): string {
  return phase ? ` [${phase}]` : "";
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem}s`;
}
