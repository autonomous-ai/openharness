# Shell guard follow-up implementation plan

> Implement task by task in this Engineer session, test first, with independent security reviews of the completed PR.

**Goal:** Close the three shell guard bypasses in task #3668.
**Architecture:** Extend the existing parser and kill target check; force hooks enabled in Claude session settings. Keep personal sessions untouched.
**Tech Stack:** TypeScript, Node, Vitest.
**Spec:** Swarm task #3668, conversation 377527a961f39144696483d3; prerequisite PR #3304.

## Global Constraints
- Build on #3304; keep a draft until it merges, then merge main and target main.
- Swarm code stays outside cli/src/core; no new dependencies.
- Never execute dangerous commands in tests; parser inputs only. Isolate all filesystem fixtures.
- Two independent security reviews. Record red/green evidence before Ready.

## Review Focus
- Signal options versus negative targets: allow SIGHUP to a positive PID, refuse process groups.
- Bare negative numbers and explicit -- target separators.
- Assignment chains, braces, concatenated paths, and reassignment.
- Quoted or escaped dollar signs remain literal; unknown values stay unknown.
- Claude session settings override disabled hooks without changing personal settings.

### Task 1: Negative kill targets
**Files:** cli/src/superTabs/shellGuard.ts; cli/src/superTabs/shellGuard.spec.ts.
**Interfaces:** shellRefusal(command, facts): string | null, existing refusal result.
- [ ] Add failing cases for bare kill -1, negative groups after signal/--, and zero; retain positive signal targets.
- [ ] Run and commit failing tests.
- [ ] Refuse ambiguous bare negative targets and every nonpositive target after signal parsing.
- [ ] Run affected guard tests and commit implementation.

### Task 2: Simple assignment expansion
**Files:** cli/src/superTabs/shellGuard.ts; cli/src/superTabs/shellGuard.spec.ts.
**Interfaces:** Existing shellRefusal API; split tracks command-local known assignment values.
- [ ] Add failing cases for /tmp root variables, chains, braced references and literal dollar signs.
- [ ] Run and commit failing tests.
- [ ] Expand known simple assignments in command order while preserving quotes and unknown substitutions.
- [ ] Run guard tests and commit implementation.

### Task 3: Disabled hooks
**Files:** cli/src/lib/agentShellGuard.ts; cli/src/lib/swarmEngineArgs.spec.ts.
**Interfaces:** claudeShellGuardArgs(): string[], existing launch settings.
- [ ] Add a failing session-settings test requiring disableAllHooks false even over a disabled base.
- [ ] Run and commit failing test.
- [ ] Force disableAllHooks false in Swarm launch settings.
- [ ] Run affected tests, hook process/bundle tests and typecheck; commit implementation.

## Validation
Affected guard and launch tests on macOS; typecheck. Full CLI unit suite runs once in ready PR CI on Linux. Verify real engine settings precedence if the CLI is available; report unavailable native/platform checks. No coverage-gated directories changed. Reuse unchanged prerequisite evidence for its own behavior. Review and test steps run independently at final head.
