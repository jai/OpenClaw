# Linus Google Chat overlay

> **Retired 2026-11-10.** No target runs this branch. Linus, SysOps and the shared gateway all run [`maintain/googlechat-patch-stack-2026-10-17`](https://github.com/jai/OpenClaw/blob/maintain/googlechat-patch-stack-2026-10-17/FORK_PATCHES.md) (OpenClaw 2026.10.4, `1bb039d6f6`), which carries the equivalent of every layer here. Make new Google Chat fixes there.

This branch carries Google Chat patches on upstream OpenClaw 2026.10.3 at `614f559915`. It changes Google Chat delivery without upgrading dependencies or database schemas.

## Patch layers

| Order | Commit                                                        | Behavior                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `81a99d440e`                                                  | Render Markdown before message-tool sends.                                                                                                                                                               |
| 2     | `7e7a8e4979`                                                  | Keep automatic replies in their thread and format fallback text.                                                                                                                                         |
| 3     | `c971493ab8`                                                  | Show queued and tool status in one activity message.                                                                                                                                                     |
| 4     | `13433d1dfb`                                                  | Keep batched reply routing and clean up after a rejected edit.                                                                                                                                           |
| 5     | `9f1d6c7265`                                                  | Do not delete a placeholder after an ambiguous edit timeout. Previously deployed tip.                                                                                                                    |
| 6     | [#16](https://github.com/jai/OpenClaw/pull/16) (`1c0088cc29`) | Append final answers after activity, keep DM and queued replies in their source thread, and restore optional room sessions. Details follow the table.                                                    |
| 7     | [#20](https://github.com/jai/OpenClaw/pull/20) (`be351a45bc`) | Send `markupSyntax: MARKUP_SYNTAX_CHAT` with message creates and edits. Chat apps created after 2026-10-16 default to Markdown, which shows `<url\|label>` links literally and joins single line breaks. |
| 8     | [#22](https://github.com/jai/OpenClaw/pull/22)                | Return a delivery receipt with the thread from message-tool sends. Without it, an answer sent with `final: true` was not recognized as the source reply, so settled-turn finalization posted it again.   |

Layers 6 and 7 list their deployed PR commits; their squash merges keep the same code.

## Deployed targets

None. The last deployments (layers 1–8 at `8063a28213` on Linus and SysOps) were replaced on 2026-11-10; `8063a28213` stays on VOC as SysOps's rollback runtime.

## Layer 6 details

1. **Activity and answer ordering.** One activity message receives tool status and commentary updates. Final answers use new messages, so the answer appears after the work that produced it. Activity cleanup follows confirmed source delivery. Partial or uncertain sends retain feedback.
2. **DM and queued reply placement.** The current inbound thread travels with delivery independently of session identity. Automatic replies, explicit sends, and queued answers can retain their source thread. Explicit destinations and reply modes remain authoritative.
3. **Deferred lifecycle.** A queued turn retains its activity message until its own delivery or settlement. Confirmed queued source delivery uses the existing observed-delivery callback. A send to another channel does not settle the source activity.
4. **Optional room sessions.** `channels.googlechat.sessionThread: true` isolates room threads using the existing thread-session suffix. The default remains disabled. DMs keep their existing session identity. Restoring this existing fork option adds two generated config entries, at channel root and account scope, so the channel config budget increases from 4031 to 4033.

Final delivery no longer edits the activity message into an answer. Append-only final delivery supersedes the earlier final-edit cleanup patch. Activity failures are logged and do not block final delivery. Final sends retain the existing durable delivery and partial-receipt handling.

Deployment settings, image pins, and rollback instructions belong to the owning [FINN infrastructure repository](https://github.com/EWA-Services/openclaw-infrastructure).
