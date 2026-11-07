# Machine tool PATH implementation plan

**Goal:** Task #3945: find tools on the same shell PATH as an agent, refresh the report on daemon startup, and explain the checked PATH when a tool is missing.

**Architecture:** Keep the existing bounded `commandAvailableInInteractiveShell` probe and per-daemon `ContributedMachines` cache. Current main already loads zsh's login files and bash's interactive files, as agent launches do; verify these paths rather than introduce a second environment capture. Carry a missing probe's PATH-source explanation through the existing optional `toolProbeErrors` map to route and admission diagnostics.

**Tech Stack:** TypeScript, Node.js, Vitest, disposable shell profiles.

**Spec:** Harness task #3945, conversation `e5ec7249ea7616cc3cbc3330`: read-only discovery, startup refresh, useful missing-tool diagnostics; Windows must never flash a window.

Implement sequentially in this session, test first, with one independent review of the final pull request.

## Global constraints

- Never execute or install the tool being checked, or change a person's profile.
- Preserve the launch shell's existing startup semantics; Windows keeps filesystem-only discovery.
- No full PATH, environment values, credentials or profile output in a report. Name the PATH source only.
- Keep the existing five-second deadline, four simultaneous probes, twenty-tool bound and cache lifetimes.
- No new runtime dependency or backend field.

## Design

- Growth: a bounded explanation per requested tool, at most twenty; removed with the existing observation/cache lifecycle.
- Concurrency: the existing serialized host pass and per-instance cache remain the only writers.
- Read cost and scale: same filesystem/shell probes; no extra polling or process. Existing observation timing measures remain applicable.
- Compatibility: extend the content of the existing optional detail map, whose bounded strings the server already accepts. Older readers still use the boolean result; older servers retain the existing fallback that drops this map.
- Migration and rollback: none; revert the diagnostic change. No persisted user configuration changes.
- Audience and identity: existing machine-observation access and execution account, unchanged; publish no raw paths.
- Failure: missing remains distinct from a failed or timed-out probe; the report explains the PATH source.
- Platforms: macOS/Linux shell discovery and Windows filesystem discovery. No Windows process-start change.

## Review focus

- A tool present only in a disposable login profile must be available to a start requiring it, without executing that tool.
- Missing, available and failed probes must remain distinct when details pass through a cached observation.
- A new daemon instance must replace the prior instance's missing-tool reading immediately.
- Shell/profile output and raw PATH must not reach shared route text.
- Windows must remain filesystem-only and identify that PATH honestly.

## Task 1: Keep discovery evidence through report and admission

**Files:** `cli/src/lib/engineLaunch.ts`, `cli/src/lib/engineLaunch.spec.ts`, `cli/src/superTabs/capacity.ts`, `cli/src/superTabs/capacity.spec.ts`, `cli/src/superTabs/machines.ts`, `cli/src/superTabs/machines.spec.ts`, `cli/src/superTabs/start.spec.ts`, `cli/src/superTabs/routeCommand.spec.ts`.

**Interfaces:** retain `CommandAvailability` (`status`, optional `detail`), `readCapabilities`, `requiredToolReason`, and the existing `toolProbeErrors` wire field. Missing results may carry a bounded PATH-source explanation; true results carry none.

- [x] Add real disposable-profile coverage for login-only discovery and start admission; assert the tool's execution marker is absent. Record already-passing behavior accurately.
- [x] Add regressions for missing PATH-source details in the probe, admission, cached machine report and route, plus a new-instance refresh check. Commit tests and observe failures before implementation.
- [x] Add the minimal diagnostic propagation. Keep old missing results without a detail compatible; keep failed probes unverified.
- [x] Run affected specs and typecheck; record red/green evidence. Use automatic CLI CI for the whole unit suite, plus the required portability gate if the engine helper changes.
- [ ] Push ready work, obtain independent review and platform acceptance, and hand off with exact revision and evidence.


## Execution evidence

- Red commit `718527faa`: five diagnostic regressions fail; the real login-profile start acceptance already passes on main's behavior.
- Green code `00ba599a6`: all six selected cases pass. The complete affected run passes 809 tests, with four pre-existing opt-in/platform skips; typecheck passes on macOS arm64 / Node 22.23.2.
- No covered implementation file in a CLI per-file coverage gate changed; the portability gate does not include `engineLaunch.ts`. Native process arguments are unchanged. The Windows no-window guard passes.
- The full CLI unit suite runs in automatic ready-for-review CI. Platform testers verify the existing path behavior; no live target-machine reproduction or Windows desktop session was claimed locally.
