# The Harness Team setup lock never holds anyone: plan

> Way of working: this project's Engineer role (project instructions): test-driven development, each failing test
> committed before the code that passes it, one pull request, one independent review.

**Goal:** after the person types their password, the Harness Team setup lock always ends: the app opens, or it says
why with Try again, or it offers Remove this Mac. Nobody waits on a spinner with nothing to press (Scholes, 2026-11-04,
task #2667).

**Architecture:** Desktop's `TeamAccountSetupLock` (desktop/lib/super_tabs/team_account_setup.dart) polls this Mac's
daemon (`teamSetupStatus`, cli/src/team/autoSetup.ts `TeamAutoSetup.status`) while the daemon runs
`harness team setup --json` (cli/src/team/command.ts `setup`), whose root script runs behind macOS's administrator
prompt (cli/src/team/admin.ts, osascript, 15-minute limit) and then waits up to 90 s for the team daemon's report.

**Tech Stack:** Dart/Flutter widget tests (memory store, fake daemon, fake CLI sign-in), TypeScript + vitest specs with
fakes for everything system-touching (no osascript, sudo, dscl or real setup).

**Spec:** task #2667's brief.

## Root cause

The wait that has no end the person can see is inside the root script, behind the password: step 5b installs Claude
Code and Codex for the team account with `npm install --global`, with no time limit at all (cli/src/team/script.ts
`TEAM_ENGINES_INSTALL`). On a new Mac the npm cache is empty and both packages fetch large native binaries; on a slow or
filtered network npm retries each fetch for minutes. The script keeps osascript open the whole time, so the daemon keeps
answering `running` and the lock keeps saying "macOS is asking for your password" for up to the prompt's 15 minutes
(Desktop's own limit is 16), with no button. When osascript's 15 minutes run out, or the daemon restarts, the setup ends
with no account and, for any code outside `MADE_NOTHING` (or none), no decision: the daemon then answers `none`, which
the lock does not read as an end, so it polls on to its 16 minutes.

Every other wait after the password is bounded: the sign-in code is minted through backend calls with a timeout
(lib/controlPlane.ts), `launchctl bootstrap` tries 5 times a second apart, and the report wait is 90 s.

## Global constraints

- Never run osascript, sudo, dscl, or a real team setup on this Mac; never create or remove the Harness Team account.
- Desktop tests use a memory store and a fake sign-in; nothing calls the real CLI logout.
- Swarm code stays out of cli/src/core. Copy follows docs/naming-system.md and the Harness Design Language.
- Only the tests of what changed run locally: desktop/test/team_account_lock_test.dart (and the offer test), cli/src/team
  specs, Desktop's guard tests (check-ui-style, laid_out_list_test).

## Review focus

- The lock ends on every daemon answer but `running` and `exists`; `null` (daemon unreachable) does not end it early.
- Try again during the wait never starts a second setup while one runs.
- The engine-install limit cannot leave a process holding osascript's output open.

## Task 1: the lock ends when the daemon stops answering `running`

**Files:** desktop/lib/super_tabs/team_account_setup.dart, desktop/test/team_account_lock_test.dart

- [ ] Failing test: `running`, then `none` → the lock shows "Setup stopped before the Harness Team account was made. Try
      again." with Try again, at once (not after 16 minutes).
- [ ] `_readSetup`: any answer but `running`, `exists` or no answer ends the wait with its reason.

## Task 2: Try again and Remove while waiting

**Files:** same.

- [ ] Failing test: the waiting step shows its text with Try again and Remove this Mac from the Swarm; Try again re-reads
      the status and asks for a setup only when none runs; Remove asks first (the existing confirm flow) and Back returns
      to the wait.
- [ ] `_LockStep.waiting` actions: Remove, Try again. Try again reads `teamSetupStatus`: `running` keeps waiting,
      `exists` opens the app, anything else starts setup again.

## Task 3: a setup that made no account remembers why

**Files:** cli/src/team/autoSetup.ts, cli/src/team/autoSetup.spec.ts

- [ ] Failing spec: a setup answering a code outside `MADE_NOTHING`, or none, or a null exit, with no account afterwards,
      records `failed` with the setup's own message (or a sentence naming the exit).
- [ ] `run()`: after any outcome but CANCELLED, when the account does not exist, write `failed`.

## Task 4: the engine install has a time limit

**Files:** cli/src/team/script.ts, cli/src/team/script.spec.ts

- [x] Failing spec: a stand-in npm that never ends is stopped after the limit, said plainly (the account works without
      them; `harness team setup` installs them), nothing else is tried, nothing is left running, and setup goes on.
- [x] `TEAM_ENGINES_INSTALL`: both packages in one npm run first (each alone if that fails); npm runs in the background
      with its output on /dev/null, waited on a second at a time, stopped after `HARNESS_TEAM_ENGINE_SECONDS` (480 s).

## Task 5: the waiting step says the step and the time so far (River, 2026-11-04, after Scholes: it finished in ~7 min)

**Files:** cli/src/team/{script,admin,command,autoSetup}.ts, desktop/lib/super_tabs/team_account_setup.dart,
desktop/lib/state/app_state.dart, their tests.

- [x] Failing specs: the script says each step (as the owner, into its private stage); the admin runner hands each new
      step on while the script runs; setup says `password`, the script's steps, then `report`; status answers `step` and
      `elapsedMs` while running. Failing widget test: the step's sentence and "Step 5 of 8 · 2 min 5 s so far."
- [x] The code that passes them.
