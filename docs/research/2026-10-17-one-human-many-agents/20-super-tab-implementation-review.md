# Super Tab review build — 19 October 2026

## Review polish

The next internal build keeps the approved layout and removes extra controls:

- Chat, terminals and PRs use icon buttons with an explicit selected state. Click the workgroup title for details, rename or archive.
- Workgroups have stable tab-local numbers (`#1`, `#2`, …), shown in navigation and linked in messages. Renaming or archiving a group preserves its number. Lead stays unnumbered.
- The terminal view shows every group member, including stopped or unavailable agents. Clicking a member focuses it within the group. Individual close and zoom controls are absent; changing to Chat does not stop a harness.
- Messages share the conversation's scroll area. Code wraps; paragraphs do not create their own scrolling surfaces.
- The global footer is hidden inside Super Tab. Roster headings are simply Leads, Humans, Agents and Machines. Humans, Agents and Machines each have a `+` for their own action.
- Machine cards use three left-aligned lines: name, owner and active agent count; available CPU/GPU and free RAM/SSD; engine icons and remaining allowance. Details and reset information remain behind the machine/allowance hover or detail view. Unknown readings remain `—`.
- **Add machine** asks only which owned machine to use. Harness reuses the lead's local project or prepares its GitHub repository on another machine, discovers installed engines (including Pi when installed), and sets a resource-based concurrency ceiling. Actual starts still pass capacity admission. It does not install or sign in to engines automatically.

Machine setup uses a polled operation receipt so a slow clone does not block other daemon requests or repeat after a timeout. No agent starts until the owner submits the contribution. Project URLs with embedded credentials are excluded. A project without a clonable repository can be contributed on its existing machine; another machine needs a shared repository first.

Validation for this update includes scoped TypeScript checks, Super Tab unit/widget tests, disposable backend replica-set integration, a two-account machine preparation/execution test using isolated daemon homes, and a native macOS fixture with screenshots of chat, the one-field machine form and four group panes. CI and the official signed internal build identify the final source revision in the PR. The delivery record below describes the preceding build until that next package is installed.

## Preceding installed build

The review build is installed and running on this Mac at:

`/Users/ab/Applications/Harness SuperTab Oct19.app`

Press **Cmd-Option-Shift-T** to create a Super Tab. Choose the lead's engine, machine, repository and settings using the existing Cmd-N form. Recent harnesses are omitted from this form.

[Download the signed Apple Silicon internal build](https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop-internal/9207d418957f7828742b619a9d848fac/Harness-macos-arm64-1.2.94-da0a3f9.dmg). It is notarized, unlisted and has public app updates disabled. No public Desktop or CLI release was made.

## What is built

- Flat workgroup list on the left; chat, group terminals and PR references in the centre; Leads, Humans, Agents and machines on the right.
- Clicking an agent opens or focuses its exact native terminal. The group terminal icon shows the group's agents together. Hiding a pane preserves its running harness, and reopening uses the same session.
- Two-line member rows, stable avatars and engine icons. Agent details are secondary. Human invitations and machine contributions sit beside their respective section headings.
- Local native questions and recorded `needs_human` assignments produce a notice in the relevant group. Clicking it opens the waiting terminal; the native question-close event clears the local notice. Answers remain in the engine's terminal UI.
- Machine cards show device/chip/OS, CPU/GPU, RAM and project-volume disk, available resources, subscription allowance remaining and reset times. Unknown values remain unknown.
- A machine owner explicitly contributes a project, engines/default accounts and concurrency limit. The owner can pause new work, configure the contribution or attach an existing harness.
- The owner-side executor launches queued agents through durable native receipts. Repeated requests reconcile the same launch. Model setup must settle before work assignment; contribution settings cannot change during that interval.
- Routing considers fresh host resources, subscription windows, permitted engines and available slots. It excludes stale/full/paused machines and candidates missing required resources/tools. The host independently reserves native capacity before launch.
- PR references appear in chat and the centre PR view. Only actual references and observed native PR state are shown; unknown checks or titles are not invented.

## Starter and teammate review

1. Create a lead with the hidden shortcut and discuss a piece of work.
2. Ask the lead to create a workgroup. Click a member, switch between Chat and group terminals, then hide and reopen a pane.
3. Use **Humans +** to invite a collaborator. Conversation access does not silently grant machine access.
4. Each contributor uses **Machines +**, chooses an owned machine/project, enables the engines they want to contribute, and sets a concurrency limit.
5. Check resource and allowance readings, pause/resume new work, and ask the lead to delegate a task to contributed capacity.

The matching development CLI is installed on this Mac as `0.4.23-dev.f2e4605215`. Other machines participating in this internal pilot also need a CLI built from main containing PR #1436. Use the repository's `make install-cli` on those hosts; the normal public updater does not distribute this unpublished build. Owners keep their own credentials and subscriptions.

## Delivery and evidence

- [Implementation PR #1436](https://github.com/autonomous-ai/openharness/pull/1436) merged as `2d174499f9ad5f75ad50a23e15c039433e79a769`.
- [Required CI](https://github.com/autonomous-ai/openharness/actions/runs/39296700219): all four Desktop shards, all four CLI shards, backend, typecheck and process checks passed.
- [Official internal Desktop build](https://github.com/autonomous-ai/openharness/actions/runs/39294760131): version `1.2.94`, Desktop source `da0a3f9dacbd70e31cc78905f2208f77affa84b8`. Subsequent changes were backend, tests and documentation; Desktop implementation inputs are the same. All workflow downloads were verified, and the installed DMG matched its checksum and passed local Gatekeeper assessment.
- DMG SHA-256: `9e3a2d3f5e60add9380c1acde01e57744accd71c99bfa462bb76395730cf4682`.
- [Matching backend publication](https://github.com/autonomous-ai/openharness/actions/runs/39298123649): `v1.2.92_backend`, image digest `sha256:50b15d75d89877cf3e5e31fa77aacca6473e6661e95bd2e7419df98ecce4817b`. The live `/api/health` reported this version and the merged SHA, rather than only relying on image-build success.
- Local checks: 101 affected Desktop widget tests; native macOS terminal/roster/resource fixture; 265 CLI tests; 33 backend replica-set integration tests; both TypeScript typechecks; shared icon catalogue audit. Routing coverage is 100% for statements, branches, functions and lines.
- Two disposable daemons verified contribution without a whole-machine share, real native creation receipts and duplicate-start reconciliation. The pool E2E passed again after main's creator-scoping fix. No real user harnesses were used for test prompts.

The final welcome-page CI failure was an obsolete assertion that expected Recent harnesses on Super Tab creation. The corrected test verifies the lead-only form and preservation of existing harnesses. Required CI then passed.

## Remaining boundaries

Native terminal control still follows existing machine/harness access. Joining a Super Tab does not give a collaborator permission to type into an otherwise read-only terminal. Owner-controlled native question handling works; broader cross-account terminal control needs its own scoped access design.

The older `superTabsCollaboration.e2e.ts` hits main's `GUEST_NOT_ALLOWED` refusal on its legacy capacity RPC. This work preserves guest isolation and exercises the new explicit contribution flow separately. Whole-tree Flutter analysis also reports existing third-party/deprecated and unrelated device-test warnings; it is not described as a clean whole-tree analysis run.

The official app was verified to start and restore existing windows. Native layout and question/terminal handoff were tested with disposable fixtures. Keyboard automation could not reliably activate modifier chords in the installed Flutter app; the hidden shortcut is covered by the widget tests.

The leaderboard and learning from long-term quality/impact outcomes remain roadmap work. This iteration uses the existing routing policy plus measured capacity and allowance; it does not claim an empirical model leaderboard.

## Timing and local receipts

Implementation and affected local validation preceded packaging. The recorded final delivery phases were:

- Internal packaging/signing/notarization/download verification: 17:30:53–17:38:39 UTC (7m 46s).
- Final required CI after the welcome-test correction: 17:44:27–17:51:08 UTC (6m 41s).
- Merge: 17:51:19 UTC.
- Backend image publication: 17:54:40–17:56:00 UTC (1m 20s), followed by live-version verification during rollout.

These workflow durations are not the total implementation time. They overlap local review and installation; earlier implementation duration is not reconstructed from incomplete handoff timestamps.

The checkout retains `.harness/review/delivery-receipt.json`, the merge helper's exact-head evidence under `.harness/validation/`, and a binary-only CLI rollback copy at `.harness/review/cli-rollback-before-f2e4605`. The local native fixture screenshots are in `/private/tmp/super-tab-review-final`. Production user data was not copied into these receipts or the repository.
