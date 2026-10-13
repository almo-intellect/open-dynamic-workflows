# Using Open Dynamic Workflows with Gemini CLI

This guide sets up a project so that **Gemini CLI writes workflow scripts** (through the
`open-dynamic-workflows` skill) and **`odw` runs them** with Gemini CLI agents. It was tested with
Gemini CLI 0.63 on Windows 11 and Node 25; the commands are the same on macOS and Linux.

1. [Install the runtime (`odw`)](#1-install-the-runtime-odw)
2. [Install the skill into Gemini CLI](#2-install-the-skill-into-gemini-cli)
3. [Set up your project](#3-set-up-your-project)
4. [Create a project skill on top of it (optional)](#4-create-a-project-skill-on-top-of-it-optional)
5. [Write and run your first workflow](#5-write-and-run-your-first-workflow)
6. [Troubleshooting](#6-troubleshooting)

## 1. Install the runtime (`odw`)

```bash
npm install -g https://github.com/almo-intellect/open-dynamic-workflows/releases/download/v0.1.0/open-dynamic-workflows-0.1.0.tgz
odw            # prints the usage line when the install worked
```

You also need Gemini CLI itself (`npm install -g @google/gemini-cli`), signed in (API key or
Google login), on `PATH`. `odw` starts one headless `gemini` process per agent.

## 2. Install the skill into Gemini CLI

The skill (`skills/open-dynamic-workflows/SKILL.md`) teaches Gemini how to *write* a workflow
script: the `agent()` / `parallel()` / `pipeline()` contract, which shape fits which task, and how
to run the result with `odw`. Pick **one** of these installs.

**For every project on this machine (user scope):**

```bash
gemini skills install https://github.com/almo-intellect/open-dynamic-workflows --path skills/open-dynamic-workflows
```

**For one project only (workspace scope)** — run it in the project root. The skill lands in
`.gemini/skills/open-dynamic-workflows/`, so you can commit it and everyone who clones the
project gets it:

```bash
gemini skills install https://github.com/almo-intellect/open-dynamic-workflows --path skills/open-dynamic-workflows --scope workspace
```

**From a local clone, always up to date** (handy if you change the skill yourself):

```bash
git clone https://github.com/almo-intellect/open-dynamic-workflows.git
gemini skills link ./open-dynamic-workflows/skills/open-dynamic-workflows
```

**With the cross-agent `skills` tool** — it writes to `.agents/skills/`, which Gemini CLI reads as
well (and so do other coding agents):

```bash
npx skills add almo-intellect/open-dynamic-workflows
```

Then check that Gemini sees it:

```bash
gemini skills list        # look for: open-dynamic-workflows [Enabled]
```

Notes:

- `gemini skills install` shows a security notice and asks for confirmation; add `--consent` only
  in scripts where you have already reviewed the skill.
- Workspace skills (`.gemini/skills/`, `.agents/skills/`) load only in **trusted folders**. If the
  skill is missing from `gemini skills list`, open `gemini` in the project once and trust it.
- In a session, Gemini asks for permission before it activates a skill; approve it (or allow it
  for good).
- To update, run the same install command again. To remove:
  `gemini skills uninstall open-dynamic-workflows` (add `--scope workspace` for a workspace
  install).

## 3. Set up your project

All of this is optional, but it is what makes Gemini runs safe and predictable.

**`.odw/config.json`** — read by `odw run` from the project root:

```json
{
  "_comment": "Open Dynamic Workflows settings (read by `odw run`).",
  "executors": ["gemini"],
  "gemini": {
    "modelAliases": { "flash": "gemini-3.8-flash", "pro": "gemini-3.1-pro-preview" },
    "allowedModels": ["gemini-3.8-flash", "gemini-3.1-pro-preview"],
    "defaultModel": "gemini-3.8-flash",
    "policy": [".odw/policies/gemini.toml"],
    "maxAttempts": 3
  },
  "concurrency": 4,
  "agentTimeoutMinutes": 20,
  "snapshot": ["src/app.ts", "src/styles.css"]
}
```

- `executors: ["gemini"]` registers Gemini only — a script that names `claude` or `codex` fails
  before any agent runs.
- `allowedModels` is enforced: any other model fails before spawning, and a silent fallback to
  another model fails the agent. Use the model ids your account can call.
- `snapshot` lists files to copy into the run folder before agents start; the run summary then
  names the files that changed. Not needed if the project is under git.

**`.odw/policies/gemini.toml`** — a [Gemini CLI policy](https://geminicli.com/docs/core/policy-engine)
applied to every workflow agent. Headless Gemini denies whatever a policy would *ask* about, so
these rules are the complete list of extra permissions:

```toml
# Edit agents may run the test suite — nothing else. Chained commands are checked
# part by part, so "npm test && …" cannot smuggle anything else in.
[[rule]]
toolName = "run_shell_command"
commandPrefix = ["npm test"]
decision = "allow"
priority = 900
modes = ["autoEdit"]

# Workflow agents never edit the orchestration or the agent configuration.
[[rule]]
toolName = ["replace", "write_file"]
argsPattern = '"file_path":"[^"]*(\.odw|\.gemini|\.agents|GEMINI\.md)'
decision = "deny"
priority = 950
denyMessage = "This path is protected for workflow agents."
```

**`GEMINI.md`** — project context every Gemini session loads; tell it how workflows work here:

```markdown
## Open Dynamic Workflows
- Workflows live in `.odw/<name>/script.js`. Write them with the open-dynamic-workflows skill.
- Every `agent()` uses `executor: 'gemini'`; read-only agents set `agentType: 'Explore'` (or `'Plan'`).
- Models: `gemini-3.8-flash` for scans and fan-out, `gemini-3.1-pro-preview` for synthesis and verification.
- Validate with `odw run --name <name> --args-file .odw/<name>/args.json --dry-run`, then run
  without `--dry-run`; resume an interrupted run with `--resume <runId>`.
- Workflows never deploy or push; that stays a separate, explicit step.
```

**`.gemini/commands/odw.toml`** — an `/odw` slash command:

```toml
description = "Write or run an Open Dynamic Workflow for this project."

prompt = """
Request: {{args}}

1. If the request describes a new workflow, use the open-dynamic-workflows skill to write it to
   `.odw/<name>/script.js` (executor 'gemini' on every agent; agentType 'Explore' for agents that
   only read). Otherwise pick the existing workflow under `.odw/` that matches.
2. Write the workflow input as JSON to `.odw/<name>/args.json` (`{}` when there is none).
3. Validate: `odw run --name <name> --args-file .odw/<name>/args.json --dry-run`. Fix every
   reported problem before going on.
4. Run: `odw run --name <name> --args-file .odw/<name>/args.json`. If it stops midway, re-run the
   same command with `--resume <runId>`.
5. Report the result (JSON on stdout) and the run summary (failed agents, changed files, run
   directory). Never claim something was verified unless the output shows it.
"""
```

**`.gitignore`**:

```gitignore
.odw/*/runs/
.odw/*/args.json
```

## 4. Create a project skill on top of it (optional)

The installed skill is generic. Project rules — which models, which files an edit agent may touch,
which commands prove the work, which workflows already exist — fit best in a small skill of your
own that Gemini loads next to it.

The quickest way is to let Gemini write it with its built-in `skill-creator` skill:

```text
Use the skill-creator skill to create a workspace skill named "myproject-workflows" in
.gemini/skills/. It complements the open-dynamic-workflows skill with this project's rules:
executor 'gemini' only, models gemini-3.8-flash / gemini-3.1-pro-preview, read-only agents use
agentType 'Explore', edit agents may only run `npm test`, and the existing workflows under .odw/.
Keep it short.
```

Or create `.gemini/skills/myproject-workflows/SKILL.md` by hand:

```markdown
---
name: myproject-workflows
description: Project rules for writing and running Open Dynamic Workflows in myproject. Use together with open-dynamic-workflows whenever you write, change or run a workflow under .odw/.
---

# Workflows in myproject

- Executor: always `executor: 'gemini'`. Models: `gemini-3.8-flash` (scans, fan-out,
  implementation) and `gemini-3.1-pro-preview` (verification, synthesis, review).
- Agents that only read get `agentType: 'Explore'`; edit agents touch only `src/` and may run only
  `npm test` (see `.odw/policies/gemini.toml`).
- Prove changes with `npm test`; a closing gate agent runs it and reports the summary line verbatim.
- Existing workflows:
  - `.odw/audit/script.js` — read-only audit; input `{"focus": "all"}`.
- Run: `odw run --name <name> --args-file .odw/<name>/args.json` (validate first with `--dry-run`).
```

Run `gemini skills list` again: both skills should show as `[Enabled]`.

## 5. Write and run your first workflow

Start `gemini` in the project and describe the job, naming the skill so it is activated:

```text
Use the open-dynamic-workflows skill to write .odw/find-dead-code/script.js: one read-only
Flash agent per folder under src/ lists exported functions that nothing imports, a read-only Pro
agent verifies each list, and the script returns the confirmed items. Do not run it yet.
```

Then validate and run it — from the terminal or with `/odw`:

```bash
odw run --name find-dead-code --dry-run   # checks the script and config; runs no agents
odw run --name find-dead-code             # the real run
```

When a workflow takes input, put the JSON in a file (for example `.odw/find-dead-code/args.json`,
which `/odw` writes for you) and add `--args-file .odw/find-dead-code/args.json`.

What you get:

- the workflow's return value as JSON on stdout, and a live progress tree on stderr;
- `.odw/find-dead-code/runs/<runId>/` with the journal, the events, one trace per agent
  (`agents/agent-N.jsonl`) and `summary.json`;
- `--resume <runId>` replays every finished agent for free after an interruption or failure.

Habits that keep Gemini workflows reliable:

- Give every agent that only reads `agentType: 'Explore'`; it is enforced, not just suggested.
- Keep schema answers short: never ask for code or file contents inside JSON — repetitive output
  trips Gemini CLI's loop detector. Let edit agents change files and report a summary.
- Attach the files an agent needs with `@path/to/file` in its prompt instead of letting it page
  through them.
- Give each edit agent its own file (or use `isolation: 'worktree'` in a git repo) so parallel
  agents never edit the same file.

## 6. Troubleshooting

| Symptom | Fix |
| :-- | :-- |
| `open-dynamic-workflows` is missing from `gemini skills list` | Trust the project folder (open `gemini` there once), check the skill is at `.gemini/skills/open-dynamic-workflows/SKILL.md` or `.agents/skills/…`, and that it is not disabled (`gemini skills enable open-dynamic-workflows`). |
| `[preflight] … executor "claude" is not registered` | The project registers Gemini only; use `executor: 'gemini'`. |
| `model "…" is not in gemini.allowedModels` | Use one of the allowed ids or an alias from `gemini.modelAliases`. |
| `--args is not valid JSON` on Windows | PowerShell strips quotes from inline JSON; write it to a file and pass `--args-file`. |
| An agent reports "denied by policy" | Read-only agents cannot edit or run shell commands; edit agents can run only what the policy allows. Adjust `agentType` or `.odw/policies/gemini.toml`. |
| `error_loop_detected` / truncated answers | The executor already repairs these by resuming the session; if it keeps happening, shorten the requested JSON (no code in it). |
| Quota or network errors | Retried automatically with backoff; lower `concurrency` in `.odw/config.json` for low-quota keys. |
| Need the full story of one agent | `.odw/<name>/runs/<runId>/agents/agent-N.jsonl` (argv, exit code, stderr, every event); set `ODW_DEBUG=1` to stream spawn details live. |
