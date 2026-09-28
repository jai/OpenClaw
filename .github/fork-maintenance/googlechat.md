# Google Chat fork patches

Prepared 2026-09-28. These branches are unpublished upstream candidates, not a
runtime release. No production deployment or restart is part of this work.
The candidate targets the 2026.9.6 source/SDK snapshot; its bundles are not
validated as a drop-in replacement for a deployed 2026.9.5 core.

## Branch strategy

Keep a dated, immutable upstream snapshot and small topic commits. Git is the
patch source; do not maintain a second copy of the same changes as patch files.

- `upstream-snapshot/2026-09-28`: upstream `openclaw/openclaw` main at
  `a61b5214bc8352533215db48db228e35a9278e35` (2026.9.6).
- `patch/googlechat-threading-2026-09-28`: remaining inbound reply routing only.
- `patch/googlechat-formatting-2026-09-28`: formatting delivery paths only.
- `maintain/googlechat-2026-09-28`: the snapshot plus threading, formatting,
  lifecycle/status, and these maintenance notes.

The two topic branches each start directly from the snapshot. Lifecycle/status
is a separate commit on the combined branch because it changes the same inbound
delivery owner as threading. Submit it after threading lands, or extract it onto
a fresh upstream base and resolve that overlap explicitly. Labels and ellipses
belong to the lifecycle commit; they are not a separate feature.

The existing fork `main` has fork-specific history. Do not force it to upstream or
change its default branch as part of this maintenance. The dated snapshot is the
clean upgrade base. Preserve both the deployed Google Chat branch and the
independently owned VOC retention branch.

## Provenance and intended behavior

Source lineage: `ec9c1a13db8` → threading `344e32ddd824` → formatting
`7a86411d029` / `0ea4c1bd9e3` → cleanup and lifecycle changes through
`051bcf585b308508c7542124f788005bf319eaa8`, plus the subsequent async correction
`6b369a8c94955d9a090a9dc9ce2a628687296d73`. The correction awaits status-controller
operations. This port preserves current upstream plugin boundaries and action
entrypoints instead of copying older files wholesale.

- Inbound replies honor `replyToMode` (`off`, `first`, `all`), explicit targets,
  and opt-out. The current message ID maps to its Chat thread. Suppressed/status
  notices do not consume the adapter's first visible threaded answer. Explicit null thread
  metadata prevents durable delivery from inheriting a thread after opt-out.
- Typing-message edits and explicit `message(action=send)` use the existing Chat
  Markdown renderer. Normal replies retain byte-bounded splitting and code
  literals. Explicit actions retain their existing one-request contract.
- With `typingIndicator: "message"` and `messages.statusReactions.enabled: true`,
  one placeholder displays an emoji and a descriptive activity label. Ongoing
  labels end in an ellipsis; `Received` does not. Status edits drain before the
  final answer replaces the placeholder. Cleanup relinquishes ownership before
  PATCH so a lost response cannot delete an answer already accepted by Chat.
  No verbose commentary is emitted.
- Unclaimed placeholders are removed on terminal paths. Message-tool sends stay
  on their existing send path; they do not edit the placeholder, which is cleaned
  up when the turn ends. This does not claim to implement message-tool placeholder
  consumption.
- Keep runtime verbosity and block streaming off in the owning infrastructure
  configuration when the desired UX is one status message followed by the final
  answer. This repository change does not modify deployed configuration.

## Upgrade and reapply

1. Use a separate sibling clone. Confirm a clean working tree and read the current
   upstream contribution instructions. Fetch upstream and origin. Record the
   exact new upstream SHA; create a new dated snapshot and maintenance branch.
2. Inspect current upstream Google Chat code and relevant PR state. Drop patches
   whose behavior is already implemented. Never blindly replay the original
   deployment history or cherry-pick its intermediate commentary experiment.
3. Cherry-pick the maintained threading commit, then formatting, then lifecycle.
   Use the commit map below. Resolve conflicts in current owners; preserve newer
   upstream imports, contracts, cancellation, and delivery receipt behavior.
4. Install the pinned toolchain/dependencies, run the focused regressions and
   Google Chat suite, then run changed-file checks against the new snapshot.
   Rebuild when imported runtime/bundle boundaries changed. Obtain fresh review.
5. Push new dated branches without force. Keep the old candidate/deployed refs
   until no runtime or task needs them. Source validation is not deployment
   authorization; runtime upgrade and rollback remain separately owned.

Typical commands after choosing the new base and topic commit SHAs:

```sh
git fetch upstream main
git fetch origin
# Create a new dated branch at the reviewed upstream commit.
git switch -c maintain/googlechat-YYYY-MM-DD <new-upstream-sha>
git cherry-pick <threading-sha> <formatting-sha> <lifecycle-sha>
pnpm install --frozen-lockfile
pnpm test extensions/googlechat --maxWorkers=1
node scripts/check-changed.mjs --base <new-upstream-sha>
git diff --check
git push -u origin maintain/googlechat-YYYY-MM-DD
```

For upstream submissions, use the independent topic branch, refresh its base when
needed, rerun affected proof, and keep fork maintenance notes out of the PR diff.
Do not open a PR or schedule publication until the operator ends the requested
production-observation period.

## Upstream audit

Live audit on 2026-09-28 found no open PRs authored by GitHub identity `jai` in
`openclaw/openclaw`; no PR closures were necessary.

- [PR #74235: preserve thread reply target](https://github.com/openclaw/openclaw/pull/74235)
  is already closed unmerged. Its ambient-context portion was superseded by
  [merged PR #80996](https://github.com/openclaw/openclaw/pull/80996), which also
  closed [issue #80995](https://github.com/openclaw/openclaw/issues/80995).
  The prepared threading patch covers the remaining inbound delivery/mode gap.
- [PR #113024: render outbound Markdown](https://github.com/openclaw/openclaw/pull/113024)
  and later renderer fixes are already upstream. The formatting candidate wires
  that renderer into two remaining delivery paths; it does not replace it.
- [Issue #82014](https://github.com/openclaw/openclaw/issues/82014) was closed as a
  duplicate, not as fixed. Canonical [issue #127567](https://github.com/openclaw/openclaw/issues/127567)
  and [PR #132860: delete unused typing placeholders](https://github.com/openclaw/openclaw/pull/132860)
  are open. Do not submit a duplicate cleanup PR. Recheck that PR before eventual
  lifecycle submission and remove any cleanup already merged.
- Fork [PR #7: Google Chat deployed patch](https://github.com/jai/OpenClaw/pull/7)
  remains relevant as the deployment lineage. Its old commentary-focused title
  and body are historical and do not describe the current final-only UX.
- Fork [PR #8: reclaim abandoned source captures](https://github.com/jai/OpenClaw/pull/8)
  remains independently owned. This work neither incorporates nor rewrites it.

## Unpublished PR drafts

### Thread routing

Title: `fix(googlechat): keep inbound replies in the configured thread`

Related: https://github.com/openclaw/openclaw/issues/80995 (remaining delivery-path
follow-up; the original message-tool context issue is already closed). Before
publication, check for a current issue covering this narrower repro; follow the
then-current issue-first contribution policy without claiming the closed issue
is still unresolved.

#### What Problem This Solves

Replies can escape the inbound Google Chat thread when the adapter delivers an
answer without an explicit thread target or maps a current-message directive.

#### User Impact

Replies honor the configured off/first/all mode, explicit targets, and opt-out,
including when typing preview creation fails or durable delivery takes over.

#### Why This Change Was Made

Resolve the reply target in the channel owner and carry an explicit null thread
for top-level delivery. Count only acknowledged visible answers toward first mode.

#### Evidence

Exercise a threaded room event with typing created, disabled, and failed; test
all/first/off modes, current-message and other-thread targets, suppressed answers,
and opt-out. The regression enters through the registered event processor and
asserts the physical Chat send/update target and durable options. Record current
focused test counts and measured wall time from the validation section below.

### Formatting delivery

Title: `fix(googlechat): render Markdown in typing edits and explicit sends`

Related: https://github.com/openclaw/openclaw/pull/113024 (existing renderer).

#### What Problem This Solves

Final replies that replace typing messages and explicit message-tool sends expose
raw Markdown instead of Google Chat formatting.

#### User Impact

Headings, emphasis, links, lists, and literal code render consistently across
reply paths. Long normal replies remain bounded by the configured byte limit.

#### Why This Change Was Made

Use the existing Google Chat renderer at the two bypassing delivery entrypoints;
preserve the single-request contract of explicit sends.

#### Evidence

Repro text: `**Ready** — [plan](https://example.com/plan)` followed by a list
containing emphasis and a literal code span. Compare normal send, placeholder
edit, edit-404 fallback, and explicit message action. Tests assert native Chat
markup and multibyte chunk bounds. Before publication, attach sanitized real Chat
before/after screenshots of the edit and explicit-send paths.

### Lifecycle status

Title: `feat(googlechat): replace one activity status message with the final answer`

Related: https://github.com/openclaw/openclaw/issues/127567 and
https://github.com/openclaw/openclaw/pull/132860 (overlapping cleanup).

#### What Problem This Solves

A static typing placeholder gives no useful activity feedback during long turns,
and unused placeholders can survive completion.

#### User Impact

When status reactions are enabled, one message shows a concise emoji and activity
label, then becomes the final answer. Verbose commentary stays off.

#### Why This Change Was Made

Adapt the existing status controller to message edits, drain queued edits before
answer delivery, and keep placeholder cleanup with the inbound turn owner.

#### Evidence

Exercise tool work, compaction, silent/error turns, message-tool replies, and a
delayed status edit racing the final answer. After final delivery, advancing
activity timers must not overwrite the answer. Before publication, reconcile
PR #132860 and attach sanitized before/after Chat screenshots showing the status
sequence and its replacement. Explicit abort and current-base live Chat proof
must be collected during observation; local API mocks do not prove provider UI.

## Known proof limits

The first-mode suppression tests cover the adapter boundary. The existing core
reply-threading filter can spend its first slot while normalizing a block before
transport suppression, then pass `replyToCurrent: false` on later payloads. This
port preserves that upstream contract; it does not claim an end-to-end fix for
that core suppression case. No runtime configuration or live provider behavior
was changed or measured by this preparation task.

## Contribution and observation checklist

Use current upstream CONTRIBUTING.md, AGENTS.md, and PR template at submission
time. Keep one concern per PR and maintainer edits enabled. Reuse relevant issue
context; obtain fresh independent review and run the required autoreview before
opening/updating a PR. Do not modify release-owned generated changelogs.

For changed tests, state measured single-worker wall time and CI seconds once a
real run exists. No PR or CI run was created just to obtain proof here.

Visual changes require inspected, sanitized before/after screenshots in the
originating chat and embedded in the eventual PR; verify PR images render.
Historical deployment screenshots do not prove the new upstream-based candidate.
During production observation, record the deployed SHA, relevant configuration,
scenario, observed message/thread sequence, and any failures. The parent runtime
work owns those observations and production changes. No automatic publication is
scheduled.

## Commit map and validation

Apply these combined-branch commits in order:

- Thread routing: `b224fe109e61cb9d615b62b85e23e7ae30e98d2c`.
- Formatting: `a1dec539408b7c1f2b3aa0c761dcec9e43968eb2`.
- Lifecycle/status and ambiguous-PATCH custody:
  `a8574c1a7bc42dab7176487a9f5f79b96891c290`.

The independent formatting branch contains the same formatting diff as
`12bf2fc36be9fe95bd2acfd5be469f40517f405f`, directly on the snapshot.
The independent threading branch ends at the threading commit above.
Maintenance notes are a separate fork-only commit.

Validation uses Node 24.21.0 and the repository-pinned pnpm 12.5.1, installed in
this task's independent checkout with the frozen lockfile.

- Unpatched upstream with carried-forward threading/formatting regressions:
  41 behavior assertion failures, 19 passes, and 2 fixture-import failures.
  The removed upstream imports were restored in the test fixture before further
  proof; those two failures are not counted as product regressions.
- Threading and formatting repairs: 60 tests passed while the two missing imports
  were identified; both fixture cases subsequently passed (edit and 404 fallback).
- Without the lifecycle patch: 8 failures and 49 passes in the focused owner run.
- Additional review regression: a final PATCH accepted by Chat followed by a lost
  response left the visible answer deleted. One focused test failed before the
  custody fix; cleanup now relinquishes the placeholder before PATCH.
- Full Google Chat suite with the custody repair: **391 passed, 0 failed**, across
  36 files; `pnpm test extensions/googlechat --maxWorkers=1`, 40.96 seconds wrapper
  wall time. Upstream's suite differs from the older deployed 425-test suite.
- Independent code review identified the custody defect above; after its repair,
  no further P0–P2 findings. A redundant ownership clear was removed afterward
  as requested by the same reviewer; final owner proof: **63 passed, 0 failed**
  across the threading and reply-delivery owners, 27.41 seconds Vitest duration.
- Independent threading branch: **37 passed, 0 failed**, 26.39 seconds wrapper
  wall time. Independent formatting branch: **58 passed, 0 failed** across two
  shards, 34.35 seconds wrapper wall time.
- Changed-file checks completed through the final runtime import-cycle check:
  production and extension-test type checks, lint, formatting, boundary guards,
  dead-code scans, and runtime guards passed. Import cycles: zero.
- Full `pnpm build` exited successfully. The Control UI budget check emitted
  a startup-JavaScript warning (372375 bytes versus 372347 allowed). A separate
  `pnpm ui:build` with upstream source reproduced the exact same warning and
  also exited successfully. These patches change no UI files.
- Final channel and maintenance documentation passed MDX checks; source matches
  the independently reviewed snapshot. Git whitespace checks passed.
- Built Google Chat import screening completed successfully with no failed or
  timed-out imports. It is **unqualified** as a source-bound performance result:
  the full build predates the final commit identity, so the profiler reports a
  build/source declaration mismatch. Do not use its RSS figure as release proof.

No current-base live Chat test or new screenshot was produced. Deployment
observation still concerns the older deployed source, not this 2026.9.6 candidate.
Full release/platform/install-migration proof and PR CI are not claimed.
