# Open Dynamic Workflows

> A faithful, **model- and harness-agnostic** standalone reimplementation of the official
> Claude Code **dynamic-workflow** runtime — with a first-class **Gemini CLI** executor and full
> **Windows** support.
>
> This is the [almo-intellect](https://github.com/almo-intellect) fork of
> [imsai-sh/open-dynamic-workflows](https://github.com/imsai-sh/open-dynamic-workflows) (MIT).

## Why this exists

Anthropic's dynamic workflows are powerful — but they only run inside Anthropic's own harness.
This is an open-source reimplementation of the same model (fan a deterministic script out across
many subagents), without that limit:

- **Any model.** Every `agent()` chooses its `Executor` by name. Bundled adapters drive
  `gemini` (Gemini CLI), `claude --print` and `codex exec` — different nodes can run on different
  CLIs — and you can plug in any other model, API, or backend.
- **Shipped as a skill + a CLI.** The skill teaches an agent to *write* workflows; the CLI *runs*
  them. Plain, portable open source.
- **Drops into any coding agent.** Wire it into Gemini CLI, Claude Code, Codex, Cursor or your own
  harness, automate it from the terminal, or call it programmatically.

## What this fork adds

- **`gemini` executor** (`src/executor/gemini/`) — drives `gemini --output-format stream-json`
  headless and makes it dependable inside a workflow:
  - **Permissions follow `agentType`.** `Explore` / `Plan` agents run read-only — Gemini's policy
    engine blocks edits and shell for them. Every other agent runs `auto_edit`. Never `--yolo`.
  - **Structured output** through schema-in-prompt plus ajv validation. A truncated answer (Gemini
    CLI's loop detector), an empty answer, or invalid JSON is repaired by **resuming the same
    session** (`--resume <id>`) — the work already done is kept, not redone.
  - **Retries with backoff** for quota blips, network errors and start-up races. An agent that has
    already changed files is resumed, never restarted, so edits are never applied twice.
  - Extensions (and their MCP servers) off by default, staggered process starts, an optional model
    allowlist with silent-fallback detection, and one trace file per attempt.
- **Windows support for every executor.** npm `.cmd` shims are unwrapped into `node <entry.js>`
  (no shell, no quoting hazards), no console window pops up per agent, and cancel / timeout kill
  the whole process tree (`taskkill /T`). `npm run smoke` now runs the tests on Windows too.
- **Per-project config** (`.odw/config.json`): restrict the executors a project may use (e.g.
  Gemini only), configure Gemini models / policies / retries, default concurrency and timeouts, and
  list files to snapshot before runs that edit them.
- **CLI**: `--dry-run` preflight (determinism, `meta`, unregistered executors, disallowed models —
  checked before any token is spent), `--strict`, `--concurrency`, `--timeout`, `--config`, and an
  end-of-run summary of failed agents and changed files (`<runDir>/summary.json`).

## Install

```bash
npm install -g github:almo-intellect/open-dynamic-workflows   # provides `odw`
```

Requires Node ≥ 20 and the agent CLIs your scripts use (`gemini`, `claude`, `codex`) on `PATH`.

Install the authoring skill (`skills/open-dynamic-workflows/SKILL.md`) into your coding agent so it
can write workflow scripts, for example:

```bash
npx skills add almo-intellect/open-dynamic-workflows
```

## Run

```bash
odw run --name audit --args '{"dir":"src"}'   # runs .odw/audit/script.js
odw run --name audit --args-file args.json    # same, shell-safe (PowerShell mangles inline JSON)
odw run --name audit --dry-run                # validate script + config; runs no agents
odw run --name audit --resume <runId>         # finished agents replay from the journal for free
odw run path/to/script.js --strict            # exit code 2 if any agent failed
```

Each run lands in `.odw/<name>/runs/<runId>/`: the script snapshot, `journal.jsonl`,
`events.jsonl`, one trace per agent (`agents/agent-N.jsonl`) and `summary.json`.

## Gemini quick start

`.odw/config.json` (every key is optional):

```json
{
  "executors": ["gemini"],
  "gemini": {
    "modelAliases": { "flash": "gemini-3.8-flash", "pro": "gemini-3.1-pro-preview" },
    "allowedModels": ["gemini-3.8-flash", "gemini-3.1-pro-preview"],
    "defaultModel": "flash",
    "policy": [".odw/policies/gemini.toml"],
    "maxAttempts": 3
  },
  "concurrency": 4,
  "agentTimeoutMinutes": 20,
  "snapshot": ["src/app.ts"]
}
```

In a script:

```js
const report = await agent('Audit @src/app.ts for memory leaks. Report findings.', {
  executor: 'gemini', model: 'flash', agentType: 'Explore', schema: FINDINGS_SCHEMA,
})
await agent(`Fix these leaks in src/app.ts only:\n${JSON.stringify(report.findings)}`, {
  executor: 'gemini', model: 'pro',
})
```

A Gemini policy file can open up exactly the shell commands edit agents need:

```toml
[[rule]]
toolName = "run_shell_command"
commandPrefix = ["npm test"]
decision = "allow"
priority = 900
modes = ["autoEdit"]
```

Notes:

- `--policy` files replace your user-level `~/.gemini/policies` for agent runs; built-in and
  workspace policies still apply. In headless mode anything a policy would *ask* about is denied.
- `@path/to/file` inside a Gemini prompt inlines that file before the model starts — much cheaper
  than letting the agent page through it with `read_file`.
- Keep schema answers compact. Never ask for long code listings inside JSON strings: repetitive
  output (e.g. `=====` banners) trips Gemini CLI's loop detector. Let edit agents change files
  directly and report a short summary instead.
- Gemini records sessions under `~/.gemini/tmp/<project>/chats/`; every trace includes the
  session id.

## Module map

```
src/
├── types.ts              ← frozen shared contract — every module codes against it
├── index.ts              ← public API: runWorkflow + executors + builtinExecutors + config + types
├── cli.ts                ← CLI entry: config → preflight → runWorkflow → live tree → summary
├── config.ts             ← .odw/config.json: executor registry, gemini options, snapshot, preflight
├── executor/             ← one subfolder per CLI; subprocess.ts + platform.ts are shared
│   ├── subprocess.ts     ← spawn · tree kill · wall/idle/abort watchdogs · line buffering · ExecTrace
│   ├── platform.ts       ← cross-platform spawn/kill (Windows npm shims, taskkill /T)
│   ├── claude/           ← `claude --print` adapter + stream-json reducer
│   ├── codex/            ← `codex exec --json` adapter + JSONL reducer
│   └── gemini/           ← `gemini --output-format stream-json` adapter + reducer
├── schema/validate.ts    ← ajv + `--json-schema` building + root-`object` guard
├── runtime/
│   ├── semaphore.ts      ← concurrency cap (min(16, cpus-2)) + 1000-agent backstop + abort
│   ├── hooks.ts          ← agent / parallel / pipeline / phase / log / workflow, bound to a run context
│   ├── sandbox.ts        ← extract meta · run the script in node:vm · determinism guard
│   └── run.ts            ← runWorkflow() — wires sandbox + hooks + executors + journal + progress
├── journal/journal.ts    ← runId · persisted script · journal.jsonl · events.jsonl · resume cache
└── progress/tree.ts      ← ProgressEvent → terminal live tree
```

## Develop & test

```bash
npm install          # also builds dist/
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit (strict)
npm run smoke        # all tests — zero tokens, no real model CLI (fake executors + a fake gemini)
```

## Credits & license

MIT — see [LICENSE](./LICENSE). The runtime, the claude/codex adapters, the skill and the archived
official docs come from [imsai-sh/open-dynamic-workflows](https://github.com/imsai-sh/open-dynamic-workflows);
this fork adds the Gemini executor, Windows support, project config and the CLI extensions.
