# Google Chat fork patch stack

Base: upstream OpenClaw `main` at `ef916d1c27` (2026-11-13). Branch: `maintain/googlechat-patch-stack-2026-11-13`.

## Policy

- Always rebase this stack onto the latest upstream `main`. Never pin it to an old base or a release tag.
- Keep each layer a separate commit. On every refresh, compare each layer with upstream and drop it as soon as upstream does the same.
- Keep fork patches minimal. Prefer upstreaming a layer to carrying it.

## Kept layers

| Order | Commit        | Behavior                                                                                                                                                                                                                                                                                                                          | Why it is still needed                                                                                                                                         | Activation                                                                                              |
| ----- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1     | `d93069f8977` | Per-thread sessions in group spaces (`:subsession:<hash>` dispatch key; space routing and reply targets unchanged). Core strips the suffix when it parses a delivery route.                                                                                                                                                       | Upstream has one session per space.                                                                                                                            | `channels.googlechat[.accounts.<id>].sessionThread: true`; off by default.                              |
| 2     | `55533221f56` | Send `markupSyntax: MARKUP_SYNTAX_CHAT` with every text create and edit.                                                                                                                                                                                                                                                          | Upstream sends no markup syntax. Chat apps created after 2026-10-16 default to Markdown, so `<url\|label>` links and single line breaks break.                 | All Google Chat text sends.                                                                             |
| 3     | `eb80ac00e5a` | Route a human-to-human DM that has the app added as a group (only the 1:1 app DM is direct). Label unnamed DMs and group chats with their members.                                                                                                                                                                                | Upstream classifies every `DIRECT_MESSAGE` space as direct, so such DMs share the owner's main session.                                                        | All accounts. Such DMs move to per-space group sessions and apply the `groups` policy and mention gate. |
| 4     | `e74c18f28a8` | Message-tool sends: render CommonMark into Chat markup, chunk into one thread, report accepted chunks on a partial failure, and return a receipt with the delivered thread.                                                                                                                                                       | Upstream sends message-tool text raw in one request with no receipt, so a `final: true` answer is not recognized as the source reply and is answered again.    | All `message(action=send)` calls.                                                                       |
| 5     | `828b32a9139` | One activity message per turn: status labels and progress edit it, final answers post after it, and confirmed delivery removes it. Reply threads follow `replyToMode` (`first`, `all`, `batched`) independently of the session, including DMs. Core reports a confirmed queued answer to the channel (`onObservedReplyDelivery`). | Upstream edits the typing placeholder into the first answer, has no activity status, and does not report queued source delivery to the channel.                | `typingIndicator: "message"` (default); status labels need `messages.statusReactions.enabled: true`.    |
| 6     | `c81c70de22d` | Fold `message(action=send, final=false)` into the live activity message for the same space and thread. The message tool stamps a host-set `openclawSourceReplyProgress` param and strips any model-supplied copy.                                                                                                                 | Upstream posts progress sends as standalone messages that are never cleaned up. Codex-harness sends reach the channel action without the trusted turn context. | Message-tool progress sends while an activity message is open.                                          |

Layer 5 also keeps progress shown in the activity message when a turn ends without a separate answer (old [#33](https://github.com/jai/OpenClaw/pull/33)) and shows progress text above the status line (old [#36](https://github.com/jai/OpenClaw/pull/36)).

Core changes outside `extensions/googlechat`: `src/sessions/session-key-utils.ts` (layer 1), `src/auto-reply/reply/followup-delivery.ts` (layer 5), `src/agents/tools/message-tool-execution.ts` and `src/channels/plugins/source-reply-progress.ts` (layer 6).

## Dropped or changed against the 2026-10-17 stack

- **Codex native subagent release:** upstream has `releaseParentThreadIfChildrenSettled` ([#179099](https://github.com/openclaw/openclaw/pull/179099)).
- **Message-tool receipt classification in core** (old layer 11 core test): upstream core already accepts a Google Chat receipt with the delivered thread.
- **Placeholder custody on rejected or ambiguous edits** (old layers 5, 6 and 8): the activity message never becomes the answer, so there is nothing to protect.
- **First-attachment-only inbound media:** upstream now downloads every attachment and handles missing files.
- **Rejecting outbound media:** upstream delivers remote media as links; the fork keeps that in both automatic replies and message-tool sends.
- **Placeholder left after a failed or silent queued turn:** adopted upstream's rule ([#118202](https://github.com/openclaw/openclaw/pull/118202)); the activity message is removed when a model turn fails or a queued turn settles without a failed send.
- **`sourceReplyFinal` on the channel action context** (old layer 12 core change): dropped. The host marker in the action params carries the same fact on the local and gateway paths.

## Runtime notes

- OpenClaw moves from 2026.10.4 to 2026.11.3. Engines are unchanged: Node `>=24.16.0 <25 || >=26.1.0`. `packageManager` moves from `pnpm@12.11.1` to `pnpm@12.15.0`.
- Run `openclaw doctor --fix` after the upgrade, with a state backup first. Upstream migrations in this range include state schema 35 and 39 ([#184581](https://github.com/openclaw/openclaw/pull/184581), [#188397](https://github.com/openclaw/openclaw/pull/188397)), heartbeat jobs to Automations ([#179387](https://github.com/openclaw/openclaw/pull/179387)) and a renamed plugin prompt permission config key ([#192634](https://github.com/openclaw/openclaw/pull/192634)).
- The fork adds no config keys beyond `sessionThread`.

## Refresh procedure

Fetch upstream `main`, branch `maintain/googlechat-patch-stack-<date>` from its exact commit, and replay the kept layers in order. Compare each layer with upstream first. Regenerate the config baseline (`pnpm config:channels:gen`, `pnpm config:docs:gen`). Validate with the Google Chat and Codex extension tests, the message-tool and follow-up delivery tests, both `tsgo` lanes and `pnpm build`. Deploy only a verified commit after saving runtime, config and state backups, and confirm visible behavior with a real inbound Chat turn.
