# Jai Work Google Chat overlay

Base: upstream OpenClaw `977d7287c01` (main, 2026-10-26). Keep these layers separate when rebasing onto later upstream main.

| Layer                    | Files                                                 | Purpose                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upstream, no local patch | `extensions/googlechat/src/format.ts`, reply delivery | CommonMark bold and links use Google Chat formatting. Our former backport from upstream PR #141752 is in upstream main (`d593d284e5`), so it must not be cherry-picked again.                                                                                                                                                              |
| Local status             | `monitor-status-message.ts`, `monitor.ts`             | With `typingIndicator: "message"` and `messages.statusReactions.enabled: true`, edit the typing placeholder to show queued, thinking, tool, and compaction activity. Stop activity before replacing the placeholder with the answer; remove unused placeholders after settlement.                                                          |
| Local DM thread          | `monitor.ts`, `actions.ts`                            | For an inbound DM thread, place automatic typing and replies in that thread. An explicit `message(action=send)` without a thread target inherits the same trusted DM thread when it sends to that same space. Explicit thread or top-level targets win. Other spaces, accounts, providers, groups, and reply mode `off` do not inherit it. |

DM thread routing does not split agent sessions by thread. The status layer and DM layer change no configuration or session schema.

The fork also carries `openclaw prompts reconcile` from its prior main branch. Its CLI registration is adapted to upstream's current descriptor catalog. The fork's August installer workflow edits are superseded by upstream's reusable workflow design; the refreshed tree uses the upstream workflows.

## Refresh and validation

1. Fetch upstream main, start a full sibling clone from its exact commit, then adapt the two local layers. Do not replay the old formatting backport or old monitor file wholesale; upstream delivery changed after those commits.
2. Install the pinned Node and pnpm versions, run `pnpm install --frozen-lockfile`, and run the focused Google Chat action, reply-target, reply-delivery, and typing-cleanup tests plus `pnpm tsgo:extensions` and the normal build.
3. Before a runtime switch, run the Codex extension's pinned binary with `--version` from the candidate checkout. After switching, require an isolated `gateway call agent --expect-final` turn with external delivery disabled, then verify a natural Google Chat DM reply in the intended thread. Gateway connectivity alone does not prove model readiness.

The live gateway and its session store are separate from this source branch. Keep the previous checkout until runtime validation succeeds.
