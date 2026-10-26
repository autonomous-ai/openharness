# Adopt role skills when old Swarm sessions restart

Approved by the project Lead after #1533 merged. The owner reversed the earlier fresh-launch-only scope.

Goal: an existing Claude Code or Codex Swarm session without stored role metadata gains the correct built-in skill when restarted or resumed on its own machine. Current group Leads receive Lead; assigned/member workers receive DEV. A personal session, missing roster entry or unsupported engine receives nothing. Existing role metadata stays unchanged.

Implementation decisions: confirm the exact harness in a fresh machine-scoped host roster, then read its current tab state to derive the group role. Both reads use the existing account backend and a bounded Super Tab service lookup; no backend changes or stale roster cache. A removed entry in either read cannot be adopted. Lead takes precedence if the same session leads one group and works in another. Archived groups do not grant a role. Adopt metadata before native preparation while checking cancellation/binding authority; live rows persist it, and stopped rows carry it into their resumed registry entry. Reuse prepareSwarmSkill through the existing relaunch path so generated files remain session-workspace-only and git-ignored.

1. Add failing roster/service tests for Lead, member/assigned worker, personal/removed/foreign sessions, stopped service and unavailable backend. Add lifecycle regressions for adoption before restart/resume and persistence.
2. Implement a guarded, bounded service lookup, core wiring and role fill-in; reuse fresh-launch materialization. Preserve launch authority, permission modes, Store harnesses and native launch recovery.
3. Verify affected CLI tests, typecheck, Super Tab routing coverage and full core coverage. Exercise old Lead/worker restarts and personal-session exclusion through the real daemon with fake engines, loopback backend, throwaway homes and private tmux. No tests use the live daemon, personal engine homes or real tmux.
4. Review the final diff, push one branch and open a draft PR with exact evidence and unverified limits. Do not mark ready, merge or release.

Owned code: CLI Super Tab host/service and process adapter, core agent restart/lifecycle and their wiring, registry fill-in, isolated tests and this plan. No Desktop or backend behavior changes.

Validation record (2026-10-22, macOS arm64, Node 24.3.0):
- New lifecycle regression tests failed before implementation: four adoption, cancellation and persistence checks. A separate regression showed that waking the host for a personal restart would start its delivery loop; the final lookup is a one-shot roster and tab-state read with no host wake.
- `npm run typecheck` passed.
- Affected CLI unit tests passed: 26 files, 669 tests.
- `npm run test:super-tabs` passed: 111 tests and 100% statement, branch, function and line coverage.
- `npm run test:core -- --maxWorkers=3` passed: 201 files, 2,976 tests and 100% coverage in all four measures.
- The bundled isolated daemon acceptance test passed. It restarted old Claude Code Lead and Codex worker sessions, resumed a stopped Claude Code worker, excluded a personal session and a removed roster entry, and verified stored roles, actual skill launch arguments, unchanged permission modes and workspace-only generated files. It used fake engines, a loopback backend, throwaway homes and private tmux; real engine execution and a physical second machine were not exercised.
- `git diff --check` passed. No Desktop or backend files changed; their tests are outside the changed input scope.

Review correction (2026-10-22): the host's durable retained-roster file now screens candidate harness IDs locally before the bounded backend lookup. A missing local entry is not cached, so a later confirmed roster can still make the session eligible. A completed lookup with no role (including an unreadable backend) is cached per session for the current daemon, avoiding repeated waits; a daemon restart permits another check. No-role lookups return the current session without requiring the full-row write authority, while a positive role still requires that authority before persistence. Four new regression cases failed before the correction, including an offline personal restart and a row change during a no-role restart; the affected tests pass after it. The acceptance fixture now records the same local roster the real host does.

Review validation: typecheck passed; affected CLI suite passed (26 files, 669 tests); isolated daemon acceptance passed (1 test); full core gate passed (201 files, 2,983 tests, 100% statement, branch, function and line coverage); `git diff --check` passed. These native CLI checks ran with macOS boot and process access. Earlier sandboxed attempts could not read the boot marker and are not counted as evidence.

Final review correction: an unavailable role lookup (timeout, backend error, missing port or invalid process reply) is now distinct from a confirmed no-role response. Only the latter enters the daemon's negative cache, so a worker can retry after the service recovers. Five focused tests failed before this distinction; after it, 212 focused tests, typecheck and the 201-file/2,984-test core gate passed, with 100% coverage in all four measures. The restart comment and file header imports were also restored to their proper positions.

Final integration on main after #1542: typecheck passed; the affected CLI suite passed (26 files, 672 tests); the core gate passed (201 files, 2,986 tests and 100% coverage in all four measures); the isolated daemon acceptance test passed (1 test); `git diff --check` passed. The rebase was clean. Main's concurrent CLI changes add process API and reservation cleanup fields without changing this role-lookup path.

Final rebase after #1543, #1546 and #1547: the host import conflict was resolved with both the new ended-work statuses and Swarm role lookup. Typecheck passed; the combined Super Tab host/service/process suite passed (22 files, 429 tests); the routing gate passed (111 tests, 100% coverage); the core gate passed (201 files, 2,986 tests, 100% coverage); `git diff --check` passed. The earlier isolated daemon acceptance still covers unchanged role adoption and native launch code; this rebase changed the host stop/cancel path and a shared import, which the Super Tab and core suites exercised.
