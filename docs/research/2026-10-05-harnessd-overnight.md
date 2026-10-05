# harnessd overnight, 2026-10-04 to 10-05

Everything below is merged to main. Nothing is released.

## Merged

| PR | What |
|---|---|
| #757 | Services can run in their own processes (`HARNESSD_SERVICES=search`, opt-in), supervised like the core: a killed, hung, leaking or crash-looping service costs only itself. Rules for coding agents (`AGENTS.md` per layer, `CLAUDE.md` importing them) and `architecture.spec.ts`, which fails the build when code crosses a wall. |
| #758 | Services answer their own requests. A feature adds a request without touching `backendSocket.ts` or `cli.ts`. The Store is a service. |
| #760 | A 64 MB floor under every engine's whole transcript reads. A test that compares every answer with the released build (nothing differs). Round 16, how agents end. The devices plan. |
| #762 | hn's `terminal_info` is answered; no build had ever answered it. A full desk end to end: 50 agents. |
| #767 | Dead agents stop showing as active when tmux's server dies. No turns replayed live after a restart. Round 17. |
| #768 | A full disk loses nothing the daemon answered. Rounds 18 (full disk) and 19 (awkward and vanishing folders). |
| next | Round 20 (an engine that freezes), and the docs. |

## Found and fixed (5 tonight, 20 in all)

1. hn's `terminal_info` was never answered. The terminal streams pass it over, and the socket
   dropped it.
2. A tmux server that died went unnoticed, so dead agents showed as active. tmux's "no server"
   message for a missing socket file was read as "tmux unavailable".
3. A restore after a daemon restart replayed turns under ten minutes old as live, with their
   notifications.
4. A rename answered while the disk was full was lost to a restart that came before the next rename.
5. On a full disk, a binding the windows never heard of. Saving the resume record threw out of it.

Each fix has a test that fails without it.

## Verified on main

- **Compared with v0.3.57** (`e2e/compat.e2e.ts`): the same scenario on the released build and this
  one gives the same answers. That covers 90 answers, every frame a turn, a question and a permission
  push, and every malformed request's refusal. The only changes are on purpose: hn's `terminal_info`
  is answered now, and `session_search` adds a field.
- **Upgrading from v0.3.57** (`e2e/migration.e2e.ts`): agents at work come through the released
  build's own update, then through the master's first start.
- **The full end-to-end suite** passes: 190 tests in 27 files, on a fake Claude Code and Codex, a
  private tmux server and a throwaway home.
- **The unit suite** passes: 8,839 tests. The core and harnessd coverage gates are at 100%.
- **Scale:** 24 agents run in 230 MiB and 50 in 268 MiB, all back after a restart in 4.6 s and 8.3 s.
- **Soak:** 1,200 turns over 4 agents; memory went 297 → 265 MiB, open files 33 → 33.
- **Chaos:** seeds 12 to 16, 150 random operations each, all pass.
- **The apps:** all 39 requests the desktop sends, 21 from the phone and 20 from hn are answered.

## Before a release

1. Dogfood. On a computer you use: `git checkout main && (cd cli && npm ci) && make install-cli`,
   then the desktop app as usual. `harness version` should print `0.3.57-dev.<sha>`.
2. Build the last release's bundle (`node build-bundle.mjs` in a checkout of its tag) and run:
   - `COMPAT_FROM=<it>/dist/cli.js npm run test:e2e -- compat`
   - `MIGRATION_FROM=<it>/dist/cli.js npm run test:e2e -- migration`
3. `make release-cli`.

## The tests that only run when asked

| Test | How | Why it is not in CI |
|---|---|---|
| Compared with a release | `COMPAT_FROM=<bundle>` | needs an old release built |
| Upgrade from a release | `MIGRATION_FROM=<bundle>` | the same |
| Full disk | `DISKFULL=1` (macOS) | mounts a 64 MB disk image |
| Scale | `SCALE_AGENTS=50` | a few GB of memory |
| Soak | `SOAK_ROUNDS=300` | minutes |
| Chaos | `CHAOS_SEED=<n> CHAOS_OPS=150` | minutes; the default seed runs in CI |

## Known limits and next steps

- **Devices**: the plan is in the design doc (D0 the fleet on its own, D1 the dial behind the
  boundary, D2 its own process, D3 the Wi-Fi device with the relay). It was not started tonight on
  purpose: a deep change in code the end-to-end suite cannot reach (multi-machine) is the wrong risk
  right before a release.
- **Models' requests** (`grid_*`, `models_list`) are still in the socket's switch. That is a
  teammate's active area (#755); they move to `services/models.ts` when the team is ready.
- **Search in its own process** is opt-in until it has been dogfooded.
- **Cursor's watcher** still re-reads Cursor's transcript whole on each change. It needs pages of
  its own.
- **Engine flags:** the cache of what an engine's `--help` supports keeps a flag until the daemon
  restarts, even if an engine update drops it. Rare, and loud when it happens (the engine refuses
  the flag).
- **hn's `terminal_remain`** (drawing a dead pane's message) is not done by the daemon, only by hn's
  own local shells.
