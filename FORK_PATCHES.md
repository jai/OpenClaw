# Linus Google Chat overlay

This branch keeps the deployed OpenClaw 2026.10.3 base at [`9f1d6c72`](https://github.com/jai/OpenClaw/commit/9f1d6c726584700943f4342cc931dac21ef8ecdb). It changes Google Chat delivery without upgrading dependencies or database schemas.

The base already includes Markdown conversion for normal replies and explicit message sends, activity labels, and delivery receipts for partially accepted messages. This overlay adds the following behavior:

1. **Activity and answer ordering.** One activity message receives tool status and commentary updates. Final answers use new messages, so the answer appears after the work that produced it. Activity cleanup follows confirmed source delivery. Partial or uncertain sends retain feedback.
2. **DM and queued reply placement.** The current inbound thread travels with delivery independently of session identity. Automatic replies, explicit sends, and queued answers can retain their source thread. Explicit destinations and reply modes remain authoritative.
3. **Deferred lifecycle.** A queued turn retains its activity message until its own delivery or settlement. Confirmed queued source delivery uses the existing observed-delivery callback. A send to another channel does not settle the source activity.
4. **Optional room sessions.** `channels.googlechat.sessionThread: true` isolates room threads using the existing thread-session suffix. The default remains disabled. DMs keep their existing session identity. Restoring this existing fork option adds two generated config entries, at channel root and account scope, so the channel config budget increases from 4031 to 4033.

Final delivery no longer edits the activity message into an answer. Append-only final delivery supersedes the earlier final-edit cleanup patch. Activity failures are logged and do not block final delivery. Final sends retain the existing durable delivery and partial-receipt handling.

Review the complete overlay against its base in the [branch comparison](https://github.com/jai/OpenClaw/compare/fix/googlechat-maintained-main-2026-10-15...patch/linus-googlechat-2026-11-08). Deployment settings, image pins, and rollback instructions belong to the owning [FINN infrastructure repository](https://github.com/EWA-Services/openclaw-infrastructure).
