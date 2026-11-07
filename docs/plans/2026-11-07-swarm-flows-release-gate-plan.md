# Swarm flows release gate (#4651)

> Way of working: this plan follows the project's Engineer role — the plan is the pull request's first
> commit, then each task test first (failing test committed and seen failing, then the code that passes it).

**Goal:** New agent failed on every try in a released Desktop and nothing caught it. Every Swarm feature a
person uses gets a click-through test that drives the real Desktop screens against the real backend, and a
failing flow stops the Desktop release, naming the flow.

**Architecture:** One disposable stack per test run: the real backend (`backend/src/server.ts`) on a
throwaway MongoDB and Redis with a stub sign-in (`cli/e2e/harness/realBackend.ts`), and the real daemon
from this checkout under a throwaway home with fake Claude Code and Codex engines that answer
(`cli/e2e/harness/daemon.ts`, `fakeEngine.mjs`). `scripts/swarm-flows-stack.ts` boots it and prints its
ports; it exits when its stdin closes. The Flutter tests in `desktop/test/swarm_flows/` start it, build the
real `AppNotifier` with a `WsConn` to that daemon (exactly the path the shipped app uses: app → daemon →
backend), pump the real `SwarmScreen` headless in `flutter_tester` and tap through each flow as a person
does. `scripts/swarm-flows.sh` runs them and prints one line per failing flow. The Desktop release workflow
runs it in a `swarm-flows` job that both the candidate (`make release-desktop ARGS=--prepare`) and the
publish wait on, and PR CI runs it when Desktop, backend or CLI code changes.

**Tech Stack:** Flutter `flutter_test` (headless, no window), TypeScript via `tsx`, mongodb-memory-server
and redis-memory-server, GitHub Actions.

**Spec:** task #4651 (River, 11-07) and anh Dee's wider scope (20:12): user testing for every Swarm feature,
New agent first.

## Global Constraints

- Never sign the real CLI out or read its login: the daemon under test has its own `HARNESS_AUTH_DIR` with
  a fixture token that only the stub sign-in accepts; the app gets a fake `CliLogin`.
- Never install a build on the shared Mac and never open a window: `flutter test` on `flutter_tester`,
  never `-d macos`. `integration_test/` would need a device and a window, so the flows live in `test/`.
- No fixed sleeps: every wait polls a condition with a deadline and names what it waited for.
- Stop only processes the stack started, by id.
- Windows: the flows run on Linux CI and macOS; nothing here starts a process on Windows.

## Review Focus

- The gate really blocks a publish: `publish` and `candidate` need `swarm-flows` success.
- The flows match what a person does: taps on the real screens, no fixture backend.
- No real login is used or changed.

## Tasks

### Task 1: the stack
Files: `scripts/swarm-flows-stack.ts`.
Interfaces: stdout one JSON line `{localPort, machineId, backendUrl, logs}`; stdin EOF stops everything.
- [ ] Boot the real backend and one signed-in isolated daemon with fake engines; print the line.

### Task 2: the harness and New agent as a Member (#4647)
Files: `desktop/test/swarm_flows/support/stack.dart`, `desktop/test/swarm_flows/new_agent_flow_test.dart`.
- [ ] Failing test: open a Swarm, Cmd-N / + New agent, pick the machine and Claude Code, start: the agent's
      chat opens with no "This project is no longer available". Seen failing on main (the #4647 bug).
- [ ] Passes with the #4647 fix.

### Task 3: the core flows
Files: `desktop/test/swarm_flows/*_flow_test.dart`.
- [ ] New agent as Lead; the agent's first chat reply; a message sent; a task assigned then accepted; a
      card's status changing; join.

### Task 4: the gate
Files: `scripts/swarm-flows.sh`, `Makefile`, `.github/workflows/release-desktop.yml`,
`.github/workflows/ci.yml`.
- [ ] A deliberately failing flow makes `scripts/swarm-flows.sh` exit non-zero and print the flow's name.
- [ ] `swarm-flows` job; `candidate` and `publish` need it; PR CI runs it for Desktop, backend and CLI.

### Task 5: every other Swarm feature
Files: `desktop/test/swarm_flows/*_flow_test.dart`.
- [ ] Left pane, Projects, Decisions, Tasks with Accept and Decline, Board cards, chat (send, voice message,
      cards), Cmd-N, join, agent menu (rename, restart, remove), Project settings. The PR lists each feature
      with its test.

### Task 6: Phase 2 spec (Ken decides the infra)
Files: `docs/validation-and-release.md`.
- [ ] The same flows on a real Mac against a staging Swarm before publish and on the published build after,
      reported in one line to anh Dee and #4634.
