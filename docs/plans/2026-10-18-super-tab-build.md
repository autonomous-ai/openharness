# Super Tab implementation and validation

Status: in progress, 18 October 2026. The interaction contract is
[Super Tab MVP](../research/2026-10-17-one-human-many-agents/17-super-tab-mvp.md).
This is a new tab type. Existing tabs and running sessions are not converted.

## Implemented so far

- Backend-owned conversations, people, invitations, agent contributions and work attempts.
- Transactional commands, stable operation receipts, message history and delivery claims.
- Assignment ownership across tabs; independent acceptance evidence; explicit host stop receipts.
- Revocation checks for contributors, viewers, execution hosts and machine sharing.
- Client conversation state: personal selection, drafts, unread positions, paginated history,
  and durable receipt IDs for retrying an uncertain send.
- Flat conversation sidebar, compact participants, local human questions, invitations and membership controls.
- Hidden Cmd+Option+Shift+T creation using the existing New Harness form and native creation receipts.
- Lead selection, machine, project, provider, account, worktree and attachment controls retained.
- Add agent attaches to the captured conversation; native terminal inspection keeps the existing pane instance.
- Daemon service and agent CLI for conversation commands and durable native message delivery.
- Revocable input leases and durable host journals prevent replay after uncertain execution.
- Mentions retain agent identity across restarts; work details show acceptance checks and exact result links.
- Session-only terminal views reuse the existing encrypted observer protocol, with backend membership checks and expiring host authority.
- Scoped agent start/resume with native creation receipts and single-dispatch claims; machine and quota admission.
- Background attachment delivery through the native terminal protocol, retained launch files,
  explicit recovery after an uncertain transfer, and account-change cancellation.
- Native stopped-session evidence releases backend assignments, including a removed contributor's work.
- Per-conversation native terminal selection survives navigation and restart; closing its pane clears the selection without stopping the harness.
- Explicit recovery for uncertain input: inspect the terminal, confirm receipt, dismiss the warning, or deliberately resend with a new delivery identity.
- Host receipt reconciliation preserves native evidence and can retire cancelled input after its agent is withdrawn, without restoring conversation access.
- A backend delivery claim whose local host journal was lost becomes an explicit uncertain delivery. It retains the original claim, withholds native input, preserves any existing receipt, and uses the conversation's human recovery controls.
- Shared desktop typography, colors, selectors, modal backdrop and focus behavior; readable large-text controls and searchable archived conversations.
- Recent-harness navigation consumes an empty Super Tab draft only after opening work; ordinary search opens native work outside completed Super Tabs and preserves their conversations and terminal selection.
- Definitive native-start refusals are reconciled through durable cancellation receipts. Lost cancellation or backend replies resume the same identity, and unknown/storage/conflict failures never become permission to launch again.
- Add agent uses the existing desktop picker with a focused conversation title, sharing scope and one action. A teammate's contributed agent can join another conversation without machine access or another native pane. The participants dialog hands focus over after closing; creating a new harness retains the captured conversation. Membership and archive changes update or dismiss an open picker.
- Runtime model/effort observations follow the native profile into the shared roster. Per-agent versions fence delayed updates and re-contributions. A separate configuration history records the initial configuration and observed changes against active assignment IDs; an assignment's starting configuration stays intact. Unknown context size is not inferred from a model name.
- Autonomous starts reserve declared memory and destination disk budgets in one durable ledger on the execution host, shared across Super Tabs and concurrent service instances. A retry retains its reservation. Pending or unknown launches keep capacity; only a native failed/cancelled receipt or a confirmed stop releases it. Worktrees sample the managed workspace's filesystem, and a retry refuses a changed destination volume. Current CPU/memory pressure and known quota checks remain in admission.
- Experimental settings cleanup and retired PR branding, preserving compatibility fields and usage controls.
- Shared native prompt/answer recording with an authenticated conversation context, ordered durable receipts,
  bounded core observations, and explicit gaps when provenance or continuity cannot be established.
  Raw terminal input and composed/queued messages retain the same context. No private pre-open history is imported.
- Native terminal viewers use the existing watch-only protocol. Account, membership, contribution and machine-grant
  changes invalidate recording authority; the UI closes a failed recording view without stopping its harness.

The desktop surface is connected, but the complete workflow is not ready. Scoped autonomous
agent starts and capacity checks are connected through the existing native creation protocol.
Terminal access, native stop reconciliation and explicit uncertain-delivery recovery are connected.
Shared recording of native interventions is connected and covered by isolated fixtures. The
implementation can enter automatic PR CI and review; rollout still requires the acceptance below.

## Validation plan

These changes cross shared state, authentication and protocol boundaries. Before rollout:

| Scope | Required evidence |
| --- | --- |
| Backend | Typecheck, complete backend unit suite, isolated replica-set transaction/API integration |
| CLI | Typecheck, complete CLI suite, affected core/services/harnessd coverage gates and relevant E2E |
| Desktop | Analyze, complete desktop suite, affected macOS/native integration |
| End to end | Two accounts and machines, both initial lead engines, shared group work, invitation/removal, native terminal, exact result |
| Recovery | Lost start/send replies, busy and disconnected agents, removed/reinvited members, stale machine/account grants, restart/reconciliation |
| Product | Physical hidden shortcut, creation form defaults/destinations/IME, narrow window, 20 people, focus/draft preservation |
| Release | Required CI and independent review of the final stable head, merge, official review build and publication verification |

Use the repository's pinned toolchains and isolated fixtures. Do not use the user's live
harnesses or the live database. A passing backend fixture does not establish native execution
or product readiness. Preserve valid evidence for unchanged scopes instead of repeating full suites.

## Current evidence

Focused checks completed during implementation (18 October):

- Backend and CLI typechecks passed.
- Backend commands and session-share access: 24 tests passed; machine policy/access/sharing checks also passed.
- `npm run test:super-tabs`: 12 integration tests passed in a disposable, loopback-only
  MongoDB 7.0.24 replica set. Includes transactional retry, cross-tab assignment ownership,
  host-confirmed stop, concurrent native start claims and machine-share removal/restoration fencing for queued instructions.
- CLI Super Tab, terminal sharing and architecture checks: 63 tests passed. PR attribution and launch overrides: 47 passed.
- CLI launch argv goldens: 2 tests passed without recording. Launch-shape recording showed no
  fixture changes; a normal comparison run remains to do.
- Focused core/process coverage: 77 tests, 100% statements, branches, functions and lines for
  changed API/delivery/process wrapper files at that checkpoint. Full coverage gates remain.
- Flutter creation, attachment, shortcut, keymap and state regression checks: 98 passed.
- Flutter conversation surface/state and entry rules: 40 passed, including hidden shortcut,
  persistent mention identity and lost acknowledgements.
- Flutter Super Tab launch/account recovery and conversation state: 15 passed for both lead engines, lost native/join
  replies and account changes. Experimental settings: 15 passed earlier.
- Latest attachment, account and conversation checks: 29 Flutter tests passed. Includes files reaching
  both engines without a pane, retained files after restart, explicit resend after uncertainty,
  a failed creation becoming editable, and closing a background writer on account change.
- Native daemon fixture (`cli/e2e/superTabs.e2e.ts`): passed in 15 seconds. Real master/core/services,
  private tmux and fake Claude Code/Codex engines; starts once, posts to the captured group,
  types a shared instruction once, refuses a revoked contribution and confirms an actual native stop.
  Its coordination HTTP fixture does not establish database or external SSO behavior.
- Latest backend replica-set integration: 12 passed, including automatic stopped-assignment release.
  CLI focused native lifecycle/service checks: 87 passed. Focused coverage for `core/api.ts`,
  `core/experimentQueries.ts` and `services/processCoreApi.ts`: 70 tests, 100% in all four measures.
- Delivery recovery integration: 15 tests passed in a fresh replica set, including concurrent human resolution,
  late host acknowledgements, machine-grant changes, withdrawn hosts and reassigned machine ownership.
  Backend typecheck passed after adding recorded execution ownership to delivery receipts.
- CLI host reconciliation: 10 tests passed, including retiring a confirmed receipt without typing it again.
- Desktop UI, navigation, conversation state and launch regression batch: 35 passed. The 11 affected UI checks
  passed again after the final focus and large-text corrections; the unchanged state/launch evidence is retained.
  Focused Dart analysis and the shared icon audit passed.
- Flutter VM renders with the actual macOS system font were inspected in light and dark appearance at 1280×800,
  and at 200% text with Increase Contrast in an 800×480 window. Reviewed conversation, participants, Invite and
  uncertain-delivery surfaces. Fixed a clipped footer label, inaccessible recovery action, generic dropdown,
  double dialog frame and missing initial search/email focus. These are synthetic fixtures, not native window evidence.
- Native macOS fixture compiled successfully, loaded its synthetic conversation, then timed out at the first rendered
  frame after two minutes. Flutter reported that it could not foreground the test app. A read of console flags confirmed
  `CGSSessionScreenIsLocked: true`. Native interaction, physical shortcut/IME and full terminal acceptance remain unverified;
  repeat them once the console is unlocked. The fixture uses in-memory accounts and terminal traffic, never real harnesses.
- Restored the ordinary macOS debug app with `scripts/build-macos-debug.sh --no-pub --target lib/main.dart`
  and the pinned Flutter toolchain. Build, renderer configuration and local signature verification passed.
  This is a local artifact, not an official release or a complete end-to-end acceptance result.
- Navigation and creation regression: 99 Flutter tests passed across Super Tab navigation/launch, search,
  normal tab state/navigation and the welcome composer. Includes the actual hidden shortcut and recent row in
  a widget fixture, retained terminal identity, failed selection, existing-view focus and group/multiple-agent
  navigation with all placements. Focused Dart analysis passed. This evidence uses injected Flutter keys,
  not physical macOS shortcut acceptance; the local debug artifact predates these navigation changes.
- Native-start refusal recovery: CLI typecheck and 20 focused start/command/capacity tests passed. The real-daemon
  fixture passed in 15.63 seconds, including both fake engines, a refused permission mode, its durable cancellation,
  a delayed create that cannot revive it, and a resume that retains the failed result. No production sessions were used.
- Agent picker and ordinary navigation regression: 153 Flutter tests passed across the actual workspace picker,
  Super Tab view/launch/navigation and normal search identity, previews, rendering and keyboard edge cases. After the
  final live-membership guards, all 8 picker tests passed again, including a disabled action when a teammate already
  added the agent, removal of access and archiving the target. Inspected light/dark 1280×800 and 200% text at 800×480
  fixture renders; the contribution picker has no unrelated preview/actions and its selected row remains visible.
  Focused Dart analysis had no errors or warnings; it reported two existing brace-style informational diagnostics
  in `swarm_screen.dart`. These checks do not replace native or official-build acceptance.
- Missing-host-journal recovery: CLI typecheck and 15 focused host/service tests passed. The real-daemon fixture
  passed in 14.93 seconds with the original native delivery identity retained, an uncertain receipt exposed for
  human review, and later host polls verified not to type the instruction. Unit checks also cover another lost
  backend acknowledgement/restart and preservation of an existing uncertain native receipt. No claim is stolen
  or automatically replayed. The backend's existing transactional acknowledgement/resolution path is unchanged.
- Runtime observations: backend and CLI typechecks passed; 13 backend policy tests, 16 disposable replica-set
  integration tests and 18 CLI configuration/host/service tests passed. The integration test verifies host-only
  authority, immutable starting configuration, ordered history, duplicate/lost replies, concurrent/stale updates
  and withdrawal. A slow configuration write does not hold up native delivery or its leases.
  The expanded native fixture passed in 21.86 seconds, switching both fake Claude Code and Codex through the app's
  existing `agent_update` controls and observing the changed model/effort through the separate service process.
  The fixture waits for both actual turns to finish before switching; an idle snapshot from the prior turn was
  insufficient. The generic runtime projection is isolated in `f7ab9240ca`; its 42 focused API/process/architecture
  checks passed with 100% statements, branches, functions and lines for the two changed boundary files.
- Runtime observation microbenchmark: Node 22.23.1, 100 unchanged agents, 5,000 passes after warm-up, same synthetic
  native roster on this Mac. Existing traversal averaged 0.00076 ms/pass and 0.90 µs CPU; traversal plus observations
  averaged 0.0729 ms/pass and 72.76 µs CPU. Neither retained additional RSS after collection. Observations run at most
  once every five seconds on the existing roster read. This isolates local parsing/comparison cost, excludes network
  writes and is not a full-daemon or customer workload performance result.
- Prepared a generic native-creation observation seam for resource reservation recovery. It projects only an
  exact creation ID, state and created harness ID through the existing receipt provider and service boundary;
  unavailable, malformed or older-core replies stay unknown. CLI typecheck passed. The 94 affected API, query,
  process, parser and architecture tests passed with 100% statements, branches, functions and lines for all four
  included boundary/parser files. The reservation caller and its real-daemon integration are now implemented below.
- Closed native creation identities remain observable even after their terminal is unavailable. This lets the
  service reconcile a harness that started and stopped before it could record the launch. The generic change is
  isolated in `032d68194f`. Its 96 launch/query/architecture checks passed with 100% statements, branches, functions
  and lines for both changed core files. The affected backend-socket cases passed (10 selected; 216 unselected).
- Host capacity reservations: CLI typecheck and 54 focused capacity, storage, start and service checks passed.
  Tests cover two actual concurrent Node processes sharing the ledger, duplicate/lost replies, service restarts,
  missing/pending/unknown native outcomes, cancellation, stopped harnesses, changed host identity, request cancellation,
  private file permissions, lost/corrupt/replaced storage and destination-volume changes. One reservation cannot
  be reused with different requirements. Node runtimes without builtin SQLite refuse this new feature with an
  update instruction; they do not crash the daemon or silently skip reservation.
  The real-daemon fixture passed in 18.50 seconds with both fake engines, concurrent host admission and release
  after native cancellation and stop. The later destination-volume retry guard and narrowed created-ID handling
  passed the focused regression batch and typecheck; they do not change the fixture's first-admission path.
- Capacity admission microbenchmark: Node 22.23.1, 10 retained pending reservations, 100 admissions after 20 warm-ups.
  Fixed in-process native/resource readers with real local SQLite writes: existing preflight averaged 0.00223 ms
  and 2.57 µs CPU; preflight plus reservation averaged 0.671 ms and 600.6 µs CPU per admission. Observed RSS grew
  0.5 MiB and 5.8 MiB respectively without forced collection. This measures local admission work, not retained
  memory, cross-process/network latency, native launch, or full-daemon performance. Reservation runs on demand;
  it adds no polling timer. Declared budgets are conservative admission allowances, not OS-enforced quotas.

- Native recording backend: 19 replica-set integration tests passed in 8.75 seconds, including ordered retries,
  lost acknowledgements, forged source rejection, group isolation, lead notification without echo, viewer denial,
  removal/rejoin fencing and machine-grant changes. Backend and CLI typechecks passed.
- Native host recording: 48 focused host/service/architecture tests passed, including independent capture during
  slow backend writes, journal recovery, lost replies, access revocation, visible gaps after expiry and retirement
  of expired views while another remains open. The private outbox advances its cursor only with durable content.
- Generic input observation boundaries: 223 tests passed with 100% per-file statements, branches, functions and
  lines for the changed API/query/funnel/process wrapper/observer files. The composed-input follow-up passed
  168 tests with 100% in all four measures for `core/input.ts` and `lib/nativeTurnObservations.ts`.
- Real-daemon native recording fixture passed in 37.95 seconds for both fake engines: raw and composed prompts,
  matching answers, a lost backend reply, and ambiguous input that produces a gap without exporting its contents.
  This exercises the real daemon/service/terminal paths, not a signed desktop build or live engine subscriptions.
- Desktop native recording checks: 114 affected Flutter tests passed; the composed-message follow-up passed all
  77 terminal session tests. Focused analysis found no issues. Three system-font fixture renders were inspected in
  light/dark appearance and at 200% text. Metadata and actions use the existing design tokens and control family.
  These renders establish layout evidence, not physical keyboard, IME or full-app acceptance.
- Complete core/service coverage gate: 2,770 tests passed, 100% per-file coverage in all four measures.
  Daemon supervisor gate: 273 passed, one platform-specific systemd check skipped on macOS; 100% coverage.
  Machine sharing gate: 75 passed, 100% coverage, including expiring Super Tab authority while preserving unread legacy rosters.
- Full backend unit run: 1,543 passed, one stale backend-frame expectation failed, 11 external-provider tests skipped.
  The unchanged production refusal list already included `connectors_changed`; its expectation was corrected and
  both frame-contract tests passed. Combined evidence covers all enabled backend unit tests; the original full run was not green.
- Full CLI unit run: 16,107 passed, six failed, 106 skipped. The new sharing fixture was corrected and its entire
  coverage gate passed. A symlink-loop expectation now accepts whichever of the two explicit bounded-path limits is
  reached first on the host's temporary path. Unchanged loopback/tmux tests passed when isolated. The private Darwin
  helper was built and verified for native identity tests; 131 native/path checks passed, one transient process probe
  failed and then passed in isolation. Original full-run failures and targeted follow-ups remain separate evidence.
- Full macOS Flutter run: 6,880 passed, 46 failed, 12 skipped. It exposed two unnecessary waits introduced around
  ordinary creation and initial pane attachment; both were removed. Follow-ups passed 105 creation/recovery checks
  and 44 pane/Super Tab checks. Nine files initially failed to connect to Flutter's test process; their serial rerun
  completed 176 checks with five configured skips and found the pane timing issue fixed in the subsequent 44-test batch.
  Focused feature analysis is clean; `app_state.dart` retains 12 pre-existing brace-style info diagnostics.
- Native observation microbenchmark (Node 22.23.1, 10,000 turns after 1,000 warm-ups): baseline 0.156 µs wall time
  per turn, unobserved 0.468 µs, observed 3.757 µs. The observed case retained about 64 KB more heap after collection;
  RSS rose about 16.8 MiB. This measures input classification and bounded observation only, excluding transport,
  network, backend and the rest of the core; it is not a full-daemon benchmark.

- Two-account/two-machine E2E passed in 14.43 seconds. A lead on the starter's real isolated daemon
  launches a worker on a teammate's explicitly shared machine over the encrypted relay. The agents exchange
  work, the worker joins a second group without restarting, and native terminal observations retain the
  starter's identity as opener while the teammate's host records execution. Revoking the machine grant
  disconnects the remote client without stopping the worker. Coordination HTTP and engines are fixtures;
  database authorization is covered separately by the replica-set integration above.
- That journey found an account-authority bug: a shared machine controller could use the execution host's
  account proxy. The gateway now conveys verified account authority separately from machine control,
  and the Super Tab service requires it for account-backed requests. Forged payload flags do not affect it.
  The generic boundary is committed separately as `2a976f84f7`; the feature guard and E2E are `a23509e729`.
  Gateway/transport/service checks passed 497 tests; one unrelated fake-Grid subprocess test timed out at
  five seconds and passed when isolated. The complete affected API/process coverage scope passed 73 tests
  with 100% statements, branches, functions and lines. The wider unchanged core gate evidence remains valid.
- Final appearance and keyboard pass (`85df17ec14`): 13 conversation/native-message Flutter checks passed,
  including keyboard containment in the collapsed sidebar, Escape returning to the preserved draft and
  selecting a group without losing that draft. Focused Dart analysis found no issues. Conversation links
  now refresh with the app appearance; composer geometry and the sidebar backdrop use the shared tokens.
  Light/dark and 200% text system-font renders were inspected again. These remain widget fixtures.
- Local macOS review app rebuilt successfully from the final UI source with the repository's renderer/signing
  script. The CLI release bundle built with the private Darwin helper; its probe and all 56 packaged service
  modules loaded in a disposable home. These artifacts have not been installed over a live app or daemon,
  and the app is not an official signed/notarized internal build. Backend rollout is still required.
- Required real-tmux suite: 60 passed, six failed, seven installed-engine rows unavailable (86.32 seconds).
  The failures were stale expectations in unchanged tests: Codex's existing inline-transcript launch flag
  and the existing guarded-kill callback. Both production contracts match the base commit. The fixtures now
  check the complete launch arguments and forward the kill guard; all six affected cases passed in 10 seconds.
  The original full run remains recorded as failed. The remaining 27 cases in the focused follow-up were
  filtered out, not newly unavailable. Every terminal/server and home belonged to the disposable fixtures.

Broad component runs and their targeted corrections are recorded above. Real-engine/native desktop
acceptance, full-app visual inspection, final review, CI, merge, official build and release remain.
No production deployment has occurred.

Implementation remains on `feat/super-tab`, draft PR #1405. Earlier pushes failed with connection resets
or timed out, leaving the implementation local. GitHub connectivity recovered on the conversation
refinement pass: fetch confirmed the remote at `f2625cdafd` and main at `7476ac0303`.
The implementation through `51a36295e5` was pushed successfully and the PR marked
ready for automatic CI and review. The first signed internal Desktop build succeeded in
[run 39181201156](https://github.com/autonomous-ai/openharness/actions/runs/39181201156).
It used the Desktop inputs from that head; the subsequent exact-message lookup
correction affected backend/CLI only. The large-text fixes below change Desktop
inputs and require a new review build. This internal build is not a public release.
The original research worktree's merge remains untouched.

## Remaining implementation and acceptance

- Review the final stable head. Preserve the broad-suite
  results and targeted corrections above; CI must still validate the pushed head before merge.
- Finish physical shortcut/IME and full-app visual acceptance on an official review build.
  Publish only after the remaining implementation and validation pass, following the normal release schedule.

## Follow-through

### Conversation refinement validation plan, 18 October

The Slack/Discord study and implementation choices are in the MVP's conversation
craft section. This pass changes Desktop message presentation, reply parsing,
the visible read boundary and the CLI host's native delivery text. It preserves
the existing coordination protocol and backend reply routing.
Run the affected Super Tab widget/controller tests, Markdown safety and keyboard
tests, and the icon audit. Inspect system-font renders in both appearances and
at 200% text, including a busy agent group and an active human question. Run the
isolated macOS workspace/terminal fixture, then restore the ordinary app entrypoint.
The new pure Flutter Markdown dependency invalidates previous Desktop build inputs;
the final automatic Desktop CI suite and official build must use the new lockfile.
Earlier backend/CLI evidence remains applicable to unchanged source. Run CLI
typecheck, the host tests and the real-daemon Super Tab fixture for the changed
native prompt, including both supported engine paths.

GitHub connectivity and an unlocked Mac were verified on the resumed pass. Native
rendering now works. The fixture's original animation settle timed out; a bounded
protocol-readiness wait then exposed incorrect fixture capability/agent data.
Increasing its timeout alone did not solve it. The fixture now uses the actual
`terminal.available` wire shape and native capability response. The real macOS
window test passes, including 20 participants, the shared conversation, the actual
native terminal stream and its group input context. Its accounts, server and
engine output are isolated fixtures; it does not establish live subscription or
production-backend acceptance.

- Final affected Desktop batch: 49 tests passed in about six seconds, covering
  keyboard replies, preserved reply context, access revocation, human requests
  scoped to their group, safe Markdown rendering, read boundaries, native launch
  recovery, delivery decisions and workspace terminal restoration. The earlier
  mixed batch was interrupted after a test-cleanup hang; it was not a passing run.
- The first catch-up check found a variable-height list stopping above the actual
  last message. The corrected follow-to-end behavior passes the regression and
  preserves the position of someone reading older messages.
- Dark, light and 200% system-font renders were inspected, with agent and human
  identities, readable code, an explicit reply and a local human question. The
  real macOS conversation and adjacent terminal captures were also inspected.
  Focused Dart analysis found no issues. The shared icon audit passed (668 Dart
  files, 160 catalogue symbols and 603 references).
- CLI host: all 14 focused tests passed; CLI typecheck passed. The real-daemon
  Super Tab E2E passed both Claude and Codex fixture paths in 34.17 seconds
  (48.42 seconds including bundle setup). Native delivery retains the reply ID,
  so a short answer is interpreted with the original question.
- Review found that an older question could fall outside the agent CLI's recent
  history. Exact-message lookup now uses the same tab/group and current caller
  authorization. Backend and CLI typechecks passed; 23 focused CLI tests passed.
  The replica-set run passed 19 tests and failed the new test's expected removal
  status (404 versus the existing `AGENT_UNAVAILABLE` 409 contract). After fixing
  that expectation, the complete new case passed: original beyond 100 messages,
  conflicting filters, another group, non-member and withdrawn agent. The other
  19 cases were filtered in that follow-up, not rerun. The real-daemon fixture
  passed exact lookup through both engine paths in 36.06 seconds (49.83 seconds
  including bundle setup). Desktop source and its validation remain unchanged.
- The ordinary local macOS app was rebuilt successfully after the native fixture;
  it is no longer the integration-test entrypoint. The signed internal workflow
  and automatic CI are in progress. Full-app physical/live-engine acceptance and
  coordinated backend/daemon rollout remain unverified.

Keep the host's durable native delivery receipt separate from backend acknowledgement. A timeout
does not prove an instruction was not executed. Check authority immediately before queued input
can be written. Retain assignment identity after removing its contributor so the execution host
can still reconcile it. Verify machine unshare/re-share behavior as part of the runtime work.

Measure implementation, validation, waiting, merge and publication separately from the user's
original request. The current draft is an implementation checkpoint, not a release receipt.

### CI corrections and review build, 18 October

[Automatic CI at `0d1ee0815e`](https://github.com/autonomous-ai/openharness/actions/runs/39181485948)
finished with failures in CLI shard 4 and Desktop shards 2/4. The remaining selected
checks passed. The failed run is not passing evidence.

- Two remote-device fixtures needed the explicit `accountOwner: false` field from
  the verified authority change. The local-owner contract is unchanged.
- Linux can immediately reuse an unlinked journal file's inode. Recording now
  checks device, inode, size and nanosecond modification/change times, and refreshes
  this identity after its own atomic writes. Replacement or an in-place change
  refuses further recording instead of accepting stale memory. CLI typecheck and
  all 29 affected device/recording/host tests passed in 1.59 seconds.
- Both large-text layout failures reproduced locally with the deterministic test
  font. The Add agent heading no longer consumes the result viewport; the selected
  result stays fully visible. Compact headers show the participant count with full
  details in accessibility/tooltip text. Text scale also informs sidebar collapse.
  Opening Invite dismisses the compact sidebar before handing focus to the dialog.
- The first combined follow-up passed 58 tests, failed one stale large-text Invite
  navigation expectation, and could not load the shared picker test because its
  Flutter test process failed the WebSocket handshake. After updating the navigation,
  the complete delivery and shared-picker files passed all 40 tests in six seconds.
  The original mixed command remains failed; no production assertion was removed.
- All 11 picker/native-message checks also passed with real-font capture enabled.
  Inspected the corrected 800×480, 200% text screenshots. Focused analysis and the
  shared icon audit passed. The chat regression passed all eight tests, including
  keeping question-marked updates separate from adjacent short posts.
- The first official internal build completed signing, notarization, Gatekeeper
  acceptance and verification of both macOS variants and all four downloads.
  The downloaded copy launched as version 1.2.91; the installed app remains 1.2.90.
  An empty creation page was inspected and its disposable tab closed. No instruction
  was submitted to a live harness. Native UI automation did not activate either
  the hidden shortcut or the ordinary Cmd-P command, so physical shortcut/IME
  acceptance remains unverified. This is not evidence of a Super Tab-only failure.

Publish the corrected head once, keep it stable through automatic CI, and run the
required branch CLI end-to-end workflow. Rebuild the official internal Desktop
artifact from the corrected inputs. Coordinated backend/daemon rollout remains
necessary before the signed app can provide the full shared workflow.

### Internal review installation and end-to-end follow-up, 18 October

- Automatic PR CI passed for `0c135930bf`, including `ci/required`:
  https://github.com/autonomous-ai/openharness/actions/runs/39182958100.
  The corrected signed internal Desktop build also passed:
  https://github.com/autonomous-ai/openharness/actions/runs/39182985112.
  Its downloaded Apple Silicon ZIP matched the published checksum; local signature
  and Gatekeeper checks passed. The internal 1.2.91 app and checked
  `0.4.19-dev.0c135930bf` daemon were installed for review, with previous artifacts
  retained. No public Desktop or CLI release was made.
- The full branch CLI E2E run completed with failures:
  https://github.com/autonomous-ai/openharness/actions/runs/39184795010.
  The Mac full-disk checks passed. One new collaboration test raced edge-service
  startup; it now waits on a read before making the sharing mutation. The old PR
  attribution test now verifies that delegation instructions survive while removed
  attribution stays absent, including after restart. A settings assertion now
  includes the existing summary-visibility field.
- The targeted follow-up used the same checked bundle, disposable homes and private
  tmux servers: five cases passed, two Pi recovery cases failed, 40 were unselected
  (109.17 seconds). All three corrected scenarios passed, as did both held-history
  Close cases. The two Pi failures are identical to existing main-branch failures:
  https://github.com/autonomous-ai/openharness/actions/runs/39104876562.
  That existing main run also records the same queued-Close registry transaction
  failure and stale settings assertion. The original full run remains failed;
  these follow-ups do not relabel it as green.
- This follow-up changes tests and this record only. Backend, daemon and Desktop
  build inputs are unchanged; their prior validation and internal artifacts remain
  applicable. Native keyboard automation still does not verify the hidden chord or
  IME. Shared conversations need the matching backend before user review.
- For this rollout the user accepted deploying the matching backend while the
  feature stays behind its shortcut. Future feature review should use an isolated
  internal setup before a public release.
