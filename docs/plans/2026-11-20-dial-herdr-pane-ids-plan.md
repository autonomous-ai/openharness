# Dial: herdr pane ids with letters — plan

Spec: [2026-11-20-dial-herdr-pane-ids-design.md](2026-11-20-dial-herdr-pane-ids-design.md). Executed by devcrew phase 3.
The two tasks share no file and start at once.

## Task 1: herdr's pane id form, and the skips said (effort: high)

Files: `cli/src/cable/hosts/herdrClient.ts`, `herdr.ts`, `herdrSource.ts`, `herdrOuter.ts` and their `.spec.ts` files.
Depends on: nothing.

Red first (one commit), each with `w2:pE`:
- `herdrClient.spec.ts`: `HERDR_PANE` accepts `w2:pE`, `wA:p10`, `w0:pZ`; it still refuses `w1:pI`, `w1:pe`, `w1:p`,
  `w1:p1:x` and an id over 9 characters a side.
- `herdr.spec.ts`: `paneOf` takes `HERDR_PANE_ID=w2:pE` (with and without an outer app), and `focus` and `show` run
  `herdr agent focus w2:pE`.
- `herdrSource.spec.ts`: a listed `w2:pE` agent is a row; a list with out-of-form ids logs `[herdr] skipped · <n> pane-id`
  once per count change.
- `herdrOuter.spec.ts`: a hook with `HERDR_PANE_ID=w2:pE` runs the lookup; an out-of-form id logs
  `[device] herdr client · skipped · pane-id` once per id, with no id in the line.

Then the code (one commit) that makes them pass.

## Task 2: the e2e meets ids with letters (effort: high)

Files: `cli/e2e/dialHerdrTerminal.e2e.ts`, `cli/e2e/harness/herdrServer.ts`. Depends on: nothing (its green comes with
Task 1).

The test's private herdr server opens and closes panes in its workspace until the next pane id carries a letter (`pA` or
later), before the two Claude Code panes start. Every existing case then runs on those ids. One commit: the test, red on
the base (shown in the report), green once Task 1 lands.

## Verification

- `dialHerdrTerminal.e2e.ts` and `deviceHerdr.e2e.ts` on this Mac, against herdr **0.9.5** downloaded into the session's
  scratch folder (the `herdr-macos-aarch64` release asset, sha256 checked against its GitHub digest) and put first on
  PATH, with a throwaway HOME and socket. Two Claude Code panes with lettered ids, attached from a fake Terminal tab: both
  are rows on Terminal's page; a swipe with Terminal in front selects the tab and focuses each pane; a tab line turns the
  dial to the agent. Never the person's herdr, Terminal, Herdr app or daemon.
- `npm run test:core` is not needed: no file under `cli/src/core/` changes.
- After merge and release, Diego checks it on his own herdr 0.9.5 (the PM asks him).
