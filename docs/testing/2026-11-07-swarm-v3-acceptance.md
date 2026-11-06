# Swarm v3 acceptance, November 7

Task #4172; test-only PR #3456. **Overall: FAIL on main 3932fd2c7**, pending #4120 / PR #3446 (Team-account removal). The exact Desktop + New agent payload prevents assignment/suggestion of the new member's Regular agent in another person's project. No product code changes in this task.

The initial Pass at ed429d4c6 is superseded: its real-store fixture omitted the dialog's `teamAccountOnly: true` restriction. The corrected fixture includes that field, `agents: memory`, and the dialog's capacity setting. Both continuous cases now fail at the remaining Team-account requirement, while separate CLI and Desktop checks pass. The failure was handed to #4120; it must be rerun after that task merges.

## Source

- Main initially tested: `b39fbe09b48ac476c8a853b68b41302286ba77fb`.
- Main after Tasks merged: `3932fd2c7f49478c7e4a178f51e1f2c840761c48`.
- Acceptance test commit: `3220a3213`; combined checkout: `08b5a0be35b78c5cf9284cd4f3d55c9e70517430`.
- `git diff b39fbe09b..3932fd2c7 -- backend cli` is empty. Backend/CLI receipts carry unchanged; the Desktop Tasks checks ran after this merge.
- macOS arm64, Node/Vitest and Flutter offscreen. New test calls the real store, host read and personal feed against an ephemeral loopback Mongo replica; no production store, real sign-in or credential file is opened.

## Per-step result

| Step | Result | Receipt |
| --- | --- | --- |
| New member joins | Pass | Invitation accepted as collaborator; member reads their own empty Tasks feed with Auto approve default. Real store, both mode cases. |
| Bring agent becomes Buddy, no separate add-machine step | Pass | `buddy.create` with inline setup on the person's own computer, host dispatch/started/settled, and Buddy ownership in read. Desktop launcher sends one Buddy command and no machine admission or Team setup. |
| Buddy proposal reaches PM | Pass | Person sends the exact proposal text to Buddy; `buddy.propose` creates a real delivery to PM. CLI host renders that person's words with proposal goal/scope/priority. |
| PM task reaches own Tasks | Pass | PM converts the proposal without manually setting requester; the correct member sees the task. Owner's personal feed remains empty. |
| Auto approve proceeds | **Fail — #4120** | work.assign refuses TEAM_ACCOUNT_REQUIRED: the member's own computer may run only its owner's projects until Team-account removal ships. |
| Review waits with suggested worker | **Fail — #4120** | Pending task reaches the feed, but task.suggest refuses TEAM_ACCOUNT_REQUIRED for the member's Regular agent. |
| Person approves | Component pass; continuous flow blocked | Desktop sends once and retains task. The earlier narrower backend fixture passes, but the exact Desktop flow cannot reach this step past suggestion. No end-to-end Pass is claimed. |
| Person rejects | Component pass; continuous flow blocked | Desktop requires/submits a reason. The earlier narrower backend fixture preserves reason and refuses assignment, but the exact Desktop flow stops at suggestion. |
| Plain Buddy proposals stay distinct | Pass | Desktop missing/false eligibility opens conversation without decision commands; staged approvals retain controls. |
| No Claude/ChatGPT login reads | Pass | Existing CLI source guard (all shipped TS/MJS) and Desktop guard pass. Claude status-line and Codex app-server report tests pass without real engines/sign-in. |
| Light/dark Tasks and decisions | Pass | Two capture tests, six captures (Auto approve, Review, reject in each theme); all six inspected. |

Adding a Regular worker uses the normal + New agent capacity admission after joining with the Buddy. That admission is internal to the dialog, not a separate person action. The Buddy stays the person's own and is never assigned PM work.

## Commands and counts

Run from backend, with `TMPDIR` created by `mktemp -d` and the cached Mongo 7.0.24 binary supplied through `MONGOMS_SYSTEM_BINARY`:

```sh
npx vitest run --config src/superTabs/__tests__/v3.vitest.config.ts
npx tsc --noEmit
```

Corrected acceptance: **2 failed**, both TEAM_ACCOUNT_REQUIRED at assignment/suggestion. Earlier **2 passed** is superseded because it omitted the dialog's account-isolation setting. TypeScript passed before this payload-only correction. The explicit config keeps a real-store release acceptance out of the unit suite; required CI alone does not run or supersede this explicit acceptance gate.

Run from cli, each with a fresh mktemp TMPDIR:

```sh
npm test -- src/superTabs/host.spec.ts -t 'Super Tab native delivery handoff|current Swarm role lookup'
npm test -- src/superTabs/host.spec.ts -t 'hands the PM a proposal'
npm test -- src/lib/quotaReports.spec.ts src/superTabs/inCore/launch.spec.ts
npm test -- src/lib/codexRateLimits.spec.ts src/engines/claude/statusLine.spec.ts
npm test -- src/loginReads.spec.ts
```

Counts respectively: **110**, **1**, **12**, **27**, **2** passed. Host filters intentionally leave 333 and 442 unrelated tests unselected. No whole component suite was run locally.

Additional actual start-path check (same held production tree):

```sh
npm test -- src/superTabs/start.spec.ts -t 'starts a Buddy in full mode|a Buddy launches only|permanent folder of its own for a Regular agent'
```

**15 passed**, 177 intentionally unselected: Buddy launch ownership, signed-out refusal, full-mode launch without GitHub App token, and Regular-agent folder isolation. CLI total: **167 passed**. Combined component results: **206 passed**, with **2 continuous backend failures** in the corrected acceptance.

Run from desktop with the installed Flutter SDK, fresh mktemp TMPDIR, `--concurrency=2 --reporter=failures-only`:

```sh
flutter test --no-pub test/swarm_v3_join_integration_test.dart test/swarm_v3_agent_launcher_test.dart test/swarm_v3_agent_dialog_test.dart test/swarm_v3_usage_transport_test.dart
flutter test --no-pub test/usage_no_credentials_test.dart
flutter test --no-pub test/super_tab_personal_tasks_test.dart test/super_tab_personal_tasks_pane_test.dart
flutter test --no-pub test/super_tab_personal_tasks_shots_test.dart
```

Counts respectively: **16**, **2**, **19**, **2** passed. Capture run set HARNESS_V3_TASKS_SHOTS to a fresh temporary folder. Captures attached to the task conversation.

## Limits and fixture corrections

This is layered acceptance through real backend storage, the CLI host with fake transport/engines, and Desktop widgets with memory state/fake sign-in. It does not claim a native-window/IME, live provider sign-in, production deployment, Windows session or phone check. Release publication remains the release owner's separate 09:00 step.

The first test draft attempted a second suggestion after its worker was already assigned: Auto approve passed and Review correctly refused AGENT_BUSY. The fixture now checks rejection while the worker is free. Initial typecheck also caught test-support imports outside rootDir and the host-read union; both fixture issues are corrected. Later comparison with the real Desktop dialog caught the missing account-isolation setting, reproducing the actual remaining #4120 dependency. No product fix was made, and fixture corrections are not claimed as product red/green evidence. Tests were written before any implementation; this task implements no product code.
