# Swarm agents always run in full permission mode

## Approved brief

Every new Lead and every agent a Swarm starts uses Harness's existing `full`
permission mode, including agents on contributed machines. Adding a machine is
the owner's consent, disclosed in that dialog. Only new launches change: running
agents retain their mode, and ordinary launches retain the person's choice.
There is no per-Swarm or per-machine switch. New Swarm and + Project Lead forms,
and forms that add an agent to a Swarm, hide the permission choice.

CLI starts must set full mode at the shared native creation boundary used by
both direct starts and contributed-machine host dispatch. Backend admission must
accept `permissionMode: full` while continuing to reject other permission values
and `codexHome`, `gridModel`, and `gridName` on contributed machines. When an older
backend specifically refuses the permission field, retry once without it and
report that the machine's default applies. Other failures must not retry.

Desktop passes the forced mode through `HarnessLaunchIntegration`. Add machine
explains: “Agents the Swarm starts on this machine run without asking for
permission.” Keep this separate from the clone-trust group's copy.

## Ownership and constraints

- CLI: `src/superTabs/start.ts`, shared with the host-side start path, and tests.
- Backend: `src/superTabs/machines.ts` admission and tests.
- Desktop: `lib/super_tabs/launch.dart`,
  `lib/state/harness_launch_integration.dart`, `lib/state/new_harness.dart`,
  one sentence in `lib/super_tabs/machines.dart`, and affected tests.
- No new dependencies, settings, changes to running agents, or unrelated cleanup.
- Tests use disposable fixtures and never the live daemon, port 18473, real tmux,
  or the person's Harness/Claude/Codex data.
- Start from current main, rebase before delivery, push and open a draft PR only.
  Do not mark ready, merge, or release.

## Phase 1: CLI and backend

1. Add failing start tests for direct and host-dispatched Claude/Codex launches,
   overriding a requested mode, resume without recreation, and old-backend retry.
2. Set the mode at the shared native creation boundary. Send full in new backend
   start intents; on a specific pre-dispatch permission refusal retry the same
   operation once without that field, retaining its durable creation identity.
3. Add failing backend admission tests for full and each refused setting; allow
   full and keep accurate, non-sensitive refusal text.
4. Verify CLI start/host suites and launch argv specs, plus backend unit tests.

## Phase 2: Desktop

1. Add failing tests for New Swarm, + Project, and member launches: full is sent,
   saved preferences cannot override it, and permission controls are absent.
   Keep ordinary-launch preference coverage.
2. Add an optional forced permission mode to the launch integration. Apply it to
   launch payloads and hide both advanced and agent-picker permission choices.
3. Add the Add machine consent sentence and a widget assertion.
4. Verify affected launch/controller/widget tests and analyze changed Dart files.

## Phase 3: Validation and draft delivery

- Node 24, CLI: typecheck, all Super Tab unit specs, `test:super-tabs` (100%
  per-file routing coverage), Claude/Codex launch argv golden specs.
- Backend: `tsc --noEmit`, `vitest run src/superTabs`, `test:super-tabs`
  (disposable MongoDB integration fixtures).
- Desktop: analyze changed Dart files and run affected launch, settings,
  recovery, and machine dialog tests on macOS.
- Inspect the full diff, rebase on current main, repeat only checks invalidated
  by integration changes, then push a branch and open a draft PR with exact
  results and any unverified acceptance rows. Report head SHA and PR link.

## Review focus

Compatibility retries must be limited to explicit permission-field rejection;
timeouts and mixed account-setting refusals cannot create a second intent.
Resuming an existing receipt must never update an agent's permission mode.
Hidden controls must include the previewed agent's settings, not just advanced
fields. Engines without native permission modes must retain their launch support.
Recovery of an already submitted Desktop launch must only read its receipt.

## Implementation decisions and review

- Claude Code and Codex declare `full`. Other engines retain their existing
  approving flags through `bypassPermission`, with no unsupported mode sent;
  otherwise native validation would reject OpenCode/Hermes and other members.
  Their permission controls are hidden in Swarm forms as well.
- A repeated start after a legacy fallback may encounter an existing operation
  with the legacy request hash. Retry that same operation with the exact legacy
  payload to recover its receipt. Never allocate a second operation or start.
- Independent review identified both cases above. Regression tests reproduced
  them before the fixes, including the real native launch validator and an
  accepted legacy request whose response is lost.
- The initial raw backend unit invocation lacked its fixture encryption key.
  Running the repository's `npm test -- src/superTabs --maxWorkers=2` supplies
  that fixture key; all 110 tests pass. No production configuration was used.

## Validation evidence

On macOS with Node 24.3.0, Flutter 3.47.5 and Dart 3.13.4:

- CLI typecheck passed; Super Tab specs plus launch argv golden specs passed
  339 tests in 21 files. Routing gate passed 111 tests with 100% statements,
  branches, functions and lines in each gated file.
- Backend typecheck passed; Super Tab units passed 111 tests in eight files after rebasing current main.
  The disposable MongoDB integration suite passed 60 tests in two files. The
  added persisted-full-mode contribution case also passed its targeted rerun.
- Desktop analysis found no issues. All seven affected launch, dialog, settings,
  entry and recovery test files passed together: 149 tests.
- Review fixes were each reproduced before implementation and verified after.
  No real agent session, personal engine data or live daemon was used for tests.
