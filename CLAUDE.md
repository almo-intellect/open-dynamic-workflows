# CLAUDE.md

Guidance for coding agents (Claude Code, Gemini CLI, …) working in this repository.
**Read `src/types.ts` and `docs/official/` before changing any code.**

## What this is

**A faithful, model- and harness-agnostic standalone reimplementation of the official Claude Code
`Workflow` runtime** — the almo-intellect fork of
[imsai-sh/open-dynamic-workflows](https://github.com/imsai-sh/open-dynamic-workflows), adding a
first-class Gemini CLI executor, Windows support, and per-project configuration.

A **JS workflow script** (`export const meta` + a body written with
`agent()/parallel()/pipeline()/phase()/log()/args/workflow()`) is **authored by a model** (following
`skills/open-dynamic-workflows/SKILL.md`); this project's **runtime executes it** — it fans out
subagents, returns the script's return value plus run metadata, and keeps a resumable journal. We
do not write scripts for users.

- **Model / harness agnostic**: `Executor` is the integration seam; **one adapter per CLI**
  (`claude`, `codex`, `gemini`), replaceable with any model or harness.
- **Executors are pluggable per node**: the host supplies implementations through
  `RunOptions.executors` (a `name → Executor` registry), and each `agent()` in a script picks a
  CLI by name with `{executor}` — **there is no default; it must be explicit**.
- **Authoring guidance is a skill** (`skills/open-dynamic-workflows/SKILL.md`), not tied to any
  harness.
- **The word "hook"** (`agent`/`parallel`/… — the primitives injected into the script scope) comes
  from the "Script body hooks" section of the **official tool spec**; it is unrelated to Claude
  Code lifecycle hooks (`PreToolUse`, …).

## Sources of truth

- **Behavior: the code in `src/` plus its tests (`src/**/*.test.ts`).**
- **`docs/official/`** — the official contract archived verbatim (`workflows.md`, the launch blog,
  the tool definition). "What does the official tool actually specify" is answered here.
- **`src/types.ts`** — the frozen contract (the shape layer); every module codes against it.

## Module map

```
src/
├── types.ts              ← frozen contract: Executor seam / RunOptions.executors / WorkflowResult
├── index.ts              ← public exports: runWorkflow + adapters + reducers + builtinExecutors + config + types
├── cli.ts                ← CLI entry (bin: odw / open-dynamic-workflows): config → preflight → run → summary
├── config.ts             ← <cwd>/.odw/config.json: executor registry, gemini options, snapshot, static preflight
├── executor/             ← one subfolder per CLI; subprocess.ts + platform.ts are shared
│   ├── subprocess.ts     ← CLI-neutral streaming driver (spawn / tree kill / wall+idle+abort watchdogs /
│   │                       line buffering / stdin / ExecTrace / ODW_DEBUG); a new CLI = one spec
│   ├── platform.ts       ← cross-platform spawn + kill (Windows npm shims → node <entry>; taskkill /T)
│   ├── claude/
│   │   ├── claude.ts     ← spawn claude --print — the only place that touches claude
│   │   └── stream-json.ts ← pure reducer over claude stream-json events
│   ├── codex/
│   │   ├── codex.ts      ← spawn codex exec --json — the only place that touches codex
│   │   └── codex-jsonl.ts ← pure reducer over codex JSONL events
│   └── gemini/
│       ├── gemini.ts     ← spawn gemini --output-format stream-json — the only place that touches gemini;
│       │                   agentType permissions, schema-in-prompt, repair turns, retries
│       └── gemini-stream.ts ← pure reducer over gemini stream-json events + failure classification
├── schema/validate.ts    ← ajv + --json-schema building + root-object guard
├── runtime/
│   ├── semaphore.ts      ← concurrency semaphore + global agent counter + abort
│   ├── hooks.ts          ← agent/parallel/pipeline/phase/log/workflow bound to a run context
│   ├── sandbox.ts        ← extract meta + run the script in node:vm + determinism guard
│   └── run.ts            ← runWorkflow() — wires everything together
├── journal/journal.ts    ← runId / persisted script / journal.jsonl / events.jsonl / resume cache
│                           (self-contained per workflow: script at <cwd>/.odw/<name>/script.js,
│                           runs at <cwd>/.odw/<name>/runs/<runId>/)
└── progress/tree.ts      ← ProgressEvent → terminal live tree
```

**Data flow of one run**: `runWorkflow()` → `sandbox` extracts `meta` and runs the script body in
`node:vm` → the script calls the injected hooks (`hooks.ts`) → each `agent()` passes the
`semaphore`, then resolves its `{executor}` name against the `ctx.executors` registry (a missing or
unknown name throws), and that `Executor` spawns its CLI (`claude --print`, `codex exec --json`, or
`gemini --output-format stream-json`) → results are written to the `journal` and streamed as
`ProgressEvent`s to `progress/tree.ts`. **How to write scripts is not in `src/`** — see the skill.

## Invariants (breaking one is a bug)

1. **Each `Executor` is the only seam that touches its CLI** — `executor/claude/` only touches
   `claude`, `executor/codex/` only `codex`, `executor/gemini/` only `gemini`; every other module is
   pure orchestration over `Promise<ExecResult>`.
2. **No barrier between `pipeline()` stages** — never `await` all of stage N before starting N+1.
3. **`parallel()` never rejects** — failed slots become `null`.
4. **Concurrency ≤ `min(16, cpus-2)`, total agents ≤ 1000**; the semaphore is released on error
   paths too.
5. **`Date.now` / `Math.random` / argless `new Date` must throw inside scripts** (resume
   determinism).
6. **The structured-output schema root must be `type:"object"`** (schemas are not rewritten; a root
   `oneOf` surfaces as the CLI's own error).
7. **Journal write failures only warn, never throw.**
8. **Spawn claude with `--permission-mode acceptEdits`, never `--dangerously-skip-permissions`.**
9. **The journal is CLI-neutral** — it stores only the reduced `result` (string | object | null),
   never raw claude stream-json / codex JSONL / gemini stream-json; resume replays stored values and
   **spawns no CLI** (adding an executor never changes the journal format).
10. **No default executor** — `agent()` must carry `{executor}`; a missing or unknown name (not in
    the `executors` registry) throws — **never a silent fallback**.
11. **Spawn codex with `--sandbox workspace-write`, never
    `--dangerously-bypass-approvals-and-sandbox`** (the codex counterpart of #8).
12. **Spawn gemini with `--approval-mode auto_edit` (or `default` for read-only agentTypes), never
    `--yolo` / `--approval-mode yolo`** (the gemini counterpart of #8). Explore/Plan agents are
    *enforced* read-only by Gemini's policy engine, not merely asked to be.
13. **A gemini retry never restarts an agent that may have changed files** — once a mutating tool
    call has succeeded, recovery resumes the same session (`--resume`), so edits are never applied
    twice.
14. **Process plumbing is cross-platform** — spawn and kill go through `executor/platform.ts`
    (npm `.cmd` shims become `node <entry>` on Windows; trees die via `taskkill /T` there and via
    process-group signals on POSIX).

## Common commands

```bash
npm install          # installs deps and builds dist/ (prepare)
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit (no ESLint/Prettier in this repo, so no lint step)
npm run smoke        # every test: fake executors + a fake gemini CLI — zero tokens, no real model CLI
npm run dev -- run <script.js> [--args <json>] [--resume <runId>]   # run a script with this runtime
```

Run a single test: `npx tsx --test --test-name-pattern="resume" src/smoke.test.ts`.

## Troubleshooting (failure observability)

- Each agent's **full execution record** lands in `<runDir>/agents/agent-N.jsonl` — the
  `ExecTrace` from `subprocess.ts`: `command / args / spawned / cwd / prompt / durationMs /
  exitCode / isError / resultSubtype / stderr / events`. CLI-level failures (auth, usage/quota
  limits, config) appear only on **stderr**, so it is archived and a failure can be diagnosed from
  the trace alone, without reproducing it. Gemini retries and repair turns write
  `agent-N.attempt-K.jsonl` alongside.
- The failure reason is **inlined** into the thrown error and `agent_end.error` (which the progress
  tree renders): `agent failed (subtype=…): <reason>` (`oneLine(res.text)` in `hooks.ts`).
  Executors move stderr into `res.text` when an error leaves no text.
- `ODW_DEBUG=1` streams each spawn's argv, exit status, and (on errors) the stderr tail to stderr.
- The CLI writes `<runDir>/summary.json`: agent tally, failed agents with reasons, and files changed
  since the pre-run snapshot (when `.odw/config.json` lists files to snapshot).
