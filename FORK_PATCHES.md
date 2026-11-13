# Maintained Google Chat patches

This stack preserves the deployed Google Chat behavior while following upstream
`main`. The current base is `14c01f382fe811b069df319840de069463d906e4`.
Branch: `maintain/googlechat-patch-stack-2026-11-20`.

## Four reviewable changes

1. **Session routing.** Opt-in `sessionThread` isolates room conversations by
   thread without changing the physical delivery address. Human-to-human DMs
   containing the app use group routing and member labels; only the app's 1:1
   DM uses direct routing. Thread hashes match the older deployed stack.
2. **Message encoding and delivery receipts.** Text creates and edits explicitly
   select Google Chat markup. Message-tool sends render CommonMark, preserve one
   thread across chunks, report accepted chunks after a partial failure, and
   return the actual delivered-thread receipt.
3. **Activity messages.** Status and progress update one activity message. Final
   answers appear after it, and confirmed delivery removes it. Reply placement
   follows the configured reply mode independently of session identity, including
   direct messages and queued answers. A yielded turn retains useful progress.
4. **Progress folding.** A host-owned marker lets message-tool progress edit the
   current activity message. Account, space, thread and session matching prevent
   edits to another turn. Media and multi-message progress are delivered
   separately, in full; confirmed queued answers clear transient activity.
   Existing delivery observers carry a generic message-tool/channel source fact
   so a folded message that becomes the completed reply remains visible.

Each commit includes its own behavior tests. The old thirteen-layer shared stack,
progress-preservation fix and progress-above-status fix are represented here.
The later media/long-progress fixes are part of the fourth commit.

## What is intentionally absent

- The extra queued-delivery observer callback: upstream already forwards the
  confirmed-delivery notification. The existing observers now carry the delivery
  source rather than adding another notification path.
- Diagnostic progress logs that enumerate live session and thread identifiers.
- Obsolete final-placeholder custody branches: the activity message is never the
  final answer. Upstream owns native subagent release, all inbound attachments,
  and remote outbound-media link handling.

## Refresh and verify

Refresh onto an exact upstream `main` commit. Compare each behavior with upstream
first and drop a patch when upstream supplies the same contract. Keep the four
commits separate rather than accumulating follow-up fix commits.

After replaying a config change, run `pnpm config:channels:gen` and
`pnpm config:docs:gen`. Run the Google Chat behavior tests, session-key tests,
message-tool execution tests, targeted lint and type checks, then build the image.
The infrastructure repository owns image source pins, build commands, stopped
volume backups, deployment and rollback. A rollout must verify the image's
`dist/build-info.json`, Gateway readiness, a real model turn and channel health.
