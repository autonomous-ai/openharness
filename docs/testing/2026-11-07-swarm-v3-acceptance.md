# Swarm v3 acceptance, November 7

Task #4172; test-only PR #3456. **Overall: PASS on main `c18dc5ede6ed8fc34e6c4a17310851ca664b0b6f`**, after #4120 / PR #3446 merged. Both continuous real-store cases pass with the exact Desktop + New agent payload. No product code changes in this task.

The initial Pass at ed429d4c6 is superseded: its real-store fixture omitted the dialog's `teamAccountOnly: true` restriction. The corrected fixture includes that field, `agents: memory`, and the dialog's capacity setting. Both continuous cases failed on main before #3446, correctly exposing the remaining Team-account requirement. The failure was handed to #4120. The final rerun on main after that merge passed both cases; this final result supersedes the intermediate Fail, while the earlier incomplete-fixture Pass remains withdrawn.

## Source

- Main initially tested: `b39fbe09b48ac476c8a853b68b41302286ba77fb`.
- Main after Tasks merged: `3932fd2c7f49478c7e4a178f51e1f2c840761c48`.
- Intermediate main tested after the CI correction: `57e129117515e558f34d01b443dc73a221972bbd`, integrated as `0cb86d7f1766fb9d9b0d71ce3267c2ea227672e6`; both acceptance cases still fail at the same Team-account gates.
- Final main: `c18dc5ede6ed8fc34e6c4a17310851ca664b0b6f`, tested in a detached temporary checkout with only the two acceptance files added. Duration 17.57 seconds; 2 passed. Main then merged into the PR as `fc22b3f53cfe1484871e711c0f90595a2b3c95ce`; acceptance files unchanged.
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
| Auto approve proceeds | Pass | PM assigns the member's own Regular agent in the PM project; own Tasks becomes working with that agent. |
| Review waits with suggested worker | Pass | Pending task shows the suggested Regular agent; assignment before approval is refused, and PM approval is refused. |
| Person approves | Pass | The member approves; PM assigns the suggested agent; personal Tasks becomes working and loses approval eligibility. Desktop sends once and retains the task. |
| Person rejects | Pass | A second task is rejected by the member; its reason persists, eligibility is false and assignment remains refused. Desktop requires/submits the reason. |
| Plain Buddy proposals stay distinct | Pass | Desktop missing/false eligibility opens conversation without decision commands; staged approvals retain controls. |
| No Claude/ChatGPT login reads | Pass | Existing CLI source guard (all shipped TS/MJS) and Desktop guard pass. Claude status-line and Codex app-server report tests pass without real engines/sign-in. |
| Light/dark Tasks and decisions | Pass | Two capture tests, six captures (Auto approve, Review, reject in each theme); all six inspected. |

Adding a Regular worker uses the normal + New agent capacity admission after joining with the Buddy. That admission is internal to the dialog, not a separate person action. The Buddy stays the person's own and is never assigned PM work.

## Commands and counts

Run from backend, with `TMPDIR` created by `mktemp -d` and the cached Mongo 7.0.24 binary supplied through `MONGOMS_SYSTEM_BINARY`:

```sh
npx vitest run --config src/superTabs/__tests__/v3.vitest.config.test-support.ts
npx tsc --noEmit
```

Final corrected acceptance on main `c18dc5ede`: **2 passed**, covering both modes and every backend step above. The intermediate run on main `57e129117` had 2 Team-account failures; #3446 resolves them. The earlier incomplete-fixture Pass at `ed429d4c6` remains withdrawn. TypeScript passes after main integration. The explicit config keeps a real-store release acceptance out of the unit suite; required CI alone does not run or supersede this explicit acceptance gate.

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

**15 passed**, 177 intentionally unselected: Buddy launch ownership, signed-out refusal, full-mode launch without GitHub App token, and Regular-agent folder isolation. CLI total: **167 passed**. Combined component results: **206 passed**, plus **2 continuous backend cases passed** on final main.

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


## Historical candidate and CI correction

Both corrected acceptance cases passed in a temporary checkout combining main `3932fd2c7f49478c7e4a178f51e1f2c840761c48` with #3446 at `ed86fd9bfeb6bcb3cfebb574b6fa0ead9fa72e99` (combined source tree including acceptance: `c17f1a6143505773df3c09e65811e73a369936d9`). That was candidate evidence only. The final main rerun above now establishes the main Pass.

CI at `ad91434f0` exposed two failures: the known main usage-vocabulary mismatch (#4173), and this PR's acceptance/config filenames being treated as production files. The existing `productionBuild.test.ts` reproduced the latter locally (1 failed, 3 passed), naming all three dev imports. Renaming both files to `.test-support.ts` keeps them out of production and out of automatic unit discovery. The same packaging check then passed all 4 tests; TypeScript passed. The renamed explicit config still runs both acceptance cases and reproduces the same Team-account failures. Its first invocation stopped before any case on a transient Mongo port collision; a second invocation reached both expected failures. Neither invocation is reported as a pass.

Main `57e129117` contains the vocabulary correction through #3450. After integrating it, `npm test -- src/lib/productionBuild.test.ts src/lib/productUsage.test.ts` passed all **83 tests**, and `npx tsc --noEmit` passed. The explicit renamed acceptance ran on this main source and still failed both cases at the same assignment/suggestion gates. Full backend and integration evidence remains automatic PR CI; these local checks do not claim that suite green.


## Final main integration

After #3446 merged, the exact corrected acceptance ran on detached main `c18dc5ede6ed8fc34e6c4a17310851ca664b0b6f`: **2 passed**, no case skipped. This covers join, Buddy creation, real PM delivery, requester attribution and personal feed visibility, Auto approve assignment, Review suggestion/wait, refusal of PM approval, member approval, member rejection with reason, and refusal of rejected assignment.

The CLI source is unchanged since its 167-test receipt. Desktop join, agent-launch, Tasks model/pane and credential guard sources are unchanged since their 39-test receipt; subsequent Desktop changes are the independent Leaderboard. Those existing receipts and six inspected captures carry for this acceptance scope. No repeat full component suite was run locally. After merging main, the two CI regression files pass all **83 tests**, and TypeScript passes. CI was green at preceding head `653837942`; the final pushed head's automatic CI and independent review remain merge gates.
