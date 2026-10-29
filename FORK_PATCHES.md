# Fork patch reference

Base: [OpenClaw upstream main at `de6ac4ff02b`](https://github.com/openclaw/openclaw/commit/de6ac4ff02b1839c7af1816ddce12f7490ded83d), fetched 2026-10-27. Apply the five branches in the order shown in the [README](README.md). Each branch includes all earlier patches. Its linked commit shows only that patch's diff.

## A. Google Chat activity status

[`patch/a-googlechat-status`](https://github.com/jai/OpenClaw/tree/patch/a-googlechat-status) updates the typing placeholder with queued, thinking, tool, and compaction activity when `typingIndicator: "message"` and status reactions are enabled. It stops activity before the answer replaces the placeholder and removes unused placeholders after the turn. [Review A](https://github.com/jai/OpenClaw/commit/b65603df66b).

## B. Google Chat DM thread routing

[`patch/b-googlechat-dm-thread`](https://github.com/jai/OpenClaw/tree/patch/b-googlechat-dm-thread) puts automatic typing and replies in the inbound DM thread. An explicit `message(action=send)` inherits that thread only when the model sends to the same DM space without an explicit thread target. An explicit thread or top-level target wins. Other spaces, accounts, providers, groups, and reply mode `off` do not inherit it. This patch does not split agent sessions by thread. [Review B](https://github.com/jai/OpenClaw/commit/2aeedf73e6e).

## C. Explicit message formatting

[`patch/c-message-action-format`](https://github.com/jai/OpenClaw/tree/patch/c-message-action-format) converts bold text and links for explicit Google Chat `message` sends and keeps chunks of a long send in the same thread. Automatic reply formatting is already in upstream main. [Review C](https://github.com/jai/OpenClaw/commit/1e6f312d6c5).

## D. Rejected edit cleanup

[`patch/d-rejected-edit-cleanup`](https://github.com/jai/OpenClaw/tree/patch/d-rejected-edit-cleanup) removes a typing placeholder after Google Chat definitively rejects editing it (HTTP 400, 401, or 403). If the response is lost or times out, it leaves the placeholder because the edit might have succeeded. A missing placeholder (404) uses the existing send fallback. [Review D](https://github.com/jai/OpenClaw/commit/4327ae50966).

## E. Queued final reply thread

[`patch/e-googlechat-terminal-thread`](https://github.com/jai/OpenClaw/tree/patch/e-googlechat-terminal-thread) records the inbound thread as delivery-only transport metadata when `replyToMode` is `all`. A follow-up queued while another turn is running uses the generic outbound route for its final reply. That route needs the transport thread because it bypasses the monitor's conversion of source message references to thread references. Explicit thread targets and top-level sends override the inherited thread. Message-tool receipts record the actual delivered thread to suppress duplicate answers. Automatic replies without a reply target also inherit the source thread in `all` mode. This includes stop and approval acknowledgements. Other reply modes retain their placement policy. Session keys and reset policies stay unchanged. [Review E](https://github.com/jai/OpenClaw/compare/4327ae509664a6cc2598b2f59bee220e4aeb6038...72b6b3274d4).

## Refresh and rollout

1. Fetch upstream main, record its exact commit, and port A through E in order. Review each commit diff against the new base. Upstream contains the old Google Chat formatting backport, so do not replay it.
2. Install the lockfile dependencies and run the Google Chat tests, TypeScript checks, and build. Before switching a gateway, run the candidate Codex extension's pinned binary with `--version`.
3. Test on SysOps first. Keep its existing runtime checkout for rollback and preserve its session store. After the switch, require an isolated `gateway call agent --expect-final` turn with external delivery disabled, then verify a natural Google Chat reply and typing lifecycle. Gateway connectivity alone does not establish model readiness.

The infrastructure inventory owns each gateway's checkout revision and launcher. Update that inventory when promoting a tested stack. A source branch alone does not change a running gateway.
