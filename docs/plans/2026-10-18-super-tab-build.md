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

The desktop surface is connected, but the complete workflow is not ready. Scoped autonomous
agent starts and capacity checks are connected through the existing native creation protocol.
Terminal access, native stop reconciliation and explicit uncertain-delivery recovery are connected.
Shared recording of native interventions remains. The PR stays a draft until that is implemented and
the complete workflow is tested and reviewed.

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

These establish individual boundaries, not the complete customer workflow. Full component suites,
two-machine/two-account integration, real-engine/native desktop validation, full-app visual inspection,
independent review, merge, official build and release remain.
No production deployment has occurred.

Implementation remains on `feat/super-tab`, draft PR #1405. Native refusal recovery is committed as `239a094bd4`
and ordinary navigation as `1c30d01ca9`, following the earlier recovery/UI commits. Earlier pushes failed with
connection resets. The latest push exceeded its 45-second bound and was terminated; a remote-head lookup also
timed out after 25 seconds, so upload of the local commits is unconfirmed.
Local commits and validation are preserved. The original research worktree's merge remains untouched.

## Remaining implementation and acceptance

- Reflect native terminal interventions and answers in the appropriate shared conversation with reliable attribution.
  The current agent instructions explicitly require posting questions/results through the shared conversation CLI.
- Run the complete component suites, required coverage gates and isolated multi-account/machine journey, then review the final head.
- Once the Mac is unlocked, finish native terminal, physical shortcut/IME and full-app visual acceptance on an official review build.
  Publish only after the remaining implementation and validation pass, following the normal release schedule.

## Follow-through

Keep the host's durable native delivery receipt separate from backend acknowledgement. A timeout
does not prove an instruction was not executed. Check authority immediately before queued input
can be written. Retain assignment identity after removing its contributor so the execution host
can still reconcile it. Verify machine unshare/re-share behavior as part of the runtime work.

Measure implementation, validation, waiting, merge and publication separately from the user's
original request. The current draft is an implementation checkpoint, not a release receipt.
