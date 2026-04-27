---
name: prose
description: OpenProse VM skill pack. Activate on any `prose` command, `.prose` files, or OpenProse mentions; orchestrates multi-agent workflows.
metadata: {"moltbot":{"emoji":"🪶","homepage":"https://www.prose.md"}}
---

# OpenProse Skill

OpenProse is a programming language for AI sessions. Treat `prose.md` as the VM contract and execute programs by following that contract exactly.

## Moltbot Runtime Mapping

- Upstream Task tool == Moltbot `sessions_spawn`
- File I/O == Moltbot `read` / `write`
- Remote fetch == Moltbot `web_fetch` (or `exec` with curl for POST)

## Activation

Use this skill when the user:
- runs any `prose <command>`
- asks to run/compile/create a `.prose` program
- mentions OpenProse VM workflows
- requests multi-agent orchestration from script syntax (`session "..."`, `agent name:`)

## Single-Skill Rule

There is only one skill here: `prose`. Do not invent sibling skills like `prose-run` or `prose-compile`.

## Command Routing

Route by command intent:

- `prose help`: load `help.md` and answer from it
- `prose run <file>`: load VM docs and execute
- `prose run <handle/slug>`: resolve remote reference, fetch, then execute
- `prose compile <file>`: load `compiler.md` and validate
- `prose update`: run migration flow in this document
- `prose examples`: list examples and run selected one
- unknown command: infer best route and explain

## File Resolution Rules

All OpenProse skill docs are co-located with this `SKILL.md`.

Load from this directory only:
- `prose.md` (VM semantics)
- `help.md` (user-facing help/FAQ)
- `compiler.md` (validator)
- `state/filesystem.md` (default state backend)
- `state/in-context.md` (optional backend)
- `state/sqlite.md` (optional backend)
- `state/postgres.md` (optional backend)
- `guidance/patterns.md` and `guidance/antipatterns.md` (authoring only)
- `examples/` programs

Do not search the user workspace for these docs.

## User Workspace Paths

Project-local:
- `.prose/.env`
- `.prose/runs/`
- `.prose/agents/`
- user `*.prose` files

User-global:
- `~/.prose/agents/`

## Example Resolution

When users refer to examples by nickname (for example “gastown”), inspect `examples/` and map by keyword/partial match.

Then execute as:

```bash
prose run examples/<matched-file>.prose
```

## Remote Program Resolution

Accepted `prose run` targets:
- direct URL (`http://` or `https://`): fetch directly
- registry shorthand (`handle/slug`): resolve to `https://p.prose.md/<handle/slug>`
- otherwise: local file path

Apply the same rules for `use "..."` imports inside `.prose` files.

## Core Loading Policy

- Running programs: load `prose.md` + chosen state backend.
- Compiling/validating only: load `compiler.md`.
- Writing new `.prose` programs: load `guidance/patterns.md` + `guidance/antipatterns.md`.
- Do not load authoring guidance during run/compile paths.

## State Backends

Default backend:
- `filesystem`: load `state/filesystem.md`

Optional backends:
- `in-context`: load when user asks for in-context mode (`--in-context`)
- `sqlite`: load on `--state=sqlite`; requires `sqlite3` CLI
- `postgres`: load on `--state=postgres`; requires `psql` + reachable PostgreSQL

### PostgreSQL Safety

Credentials in `OPENPROSE_POSTGRES_URL` may be visible to subagents/logs. Recommend dedicated DB credentials with least privilege.

Before loading `state/postgres.md`:
1. Check `.prose/.env` and process env for `OPENPROSE_POSTGRES_URL`.
2. Verify connectivity with `psql "$OPENPROSE_POSTGRES_URL" -c "SELECT 1"`.
3. If missing/failing, tell user how to configure and offer filesystem fallback.

## Execution Behavior

On first VM invocation in a session, print:

```text
┌─────────────────────────────────────┐
│         ◇ OpenProse VM ◇            │
│       A new kind of computer        │
└─────────────────────────────────────┘
```

Then:
1. Read `prose.md`.
2. Execute statements as VM operations.
3. Spawn sessions for `session` statements.
4. Narrate state transitions per VM protocol.
5. Evaluate `**...**` blocks using reasoned judgment.

## Compile/Run Context Warning

`compiler.md` is large. Only load it for explicit compile/validate requests. After compile-heavy work, suggest `/compact` or a fresh session before run-heavy workflows.

## Migration (`prose update`)

When user runs `prose update`, migrate legacy layouts if present.

Legacy mapping:
- `.prose/state.json` -> `.prose/.env` (JSON to `KEY=value` lines)
- `.prose/execution/` -> `.prose/runs/`
- ensure `.prose/agents/` exists

If changes were made, report each applied step. If nothing to migrate, explicitly say the workspace is up to date.

## Practical Guardrails

- Prefer explicit path reporting in responses.
- Keep run output concise and structured.
- If state backend requirements are missing, fail clearly and provide next-step commands.
- Never silently switch backend modes without telling the user.
