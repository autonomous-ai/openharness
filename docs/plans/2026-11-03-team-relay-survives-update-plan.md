# Team Agents Keep Their Model Across a CLI Update Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** A Harness Team agent started before a CLI update keeps getting answers from its model after it with no person
acting, and one whose engine can't reach its model for 10 minutes is reported to the PM once.

**Architecture:** Team agents reach the owner's subscriptions through a relay the owner's daemon runs in its Swarm service
(`team/relay.ts` `TeamRelayPublisher`, wired in `superTabs/service.ts`). Since #2587 (first in CLI 0.5.26) a restarted
publisher comes back on the same port with the same token, so what a running agent holds keeps working. Two gaps remain:

1. The owner's Swarm service runs on demand, and the core wakes it as it starts only when a Swarm host journal is there
   (`core/api.ts` `EXPERIMENTS.superTabs.state`). An owner's account that only lends its Team account has none, so after an
   update nothing starts the relay until a request happens to wake the service: running Team agents get "Connection
   refused" for hours. The kept grant (`team-relay-grant.json`, which the publisher writes while a Team account exists and
   removes when it is gone) becomes saved state of the Swarm service: the core asks for the service at start, the service
   connects, and the publisher opens the relay on the kept port.
2. The host's 10-minute model alert (`superTabs/terminal.ts` `MODEL_LINE`) misses Claude Code's connection failures as it
   now writes them ("Unable to connect to API (ECONNREFUSED)", "No internet route — … (ENETUNREACH)"). Those lines are
   added, and the Codex screen from the incident is pinned by a test.

The 0.5.25 to 0.5.26 update on 2026-11-03 cut every running Team agent off once whatever this change does: the build
before it kept no grant to come back with.

**Tech Stack:** TypeScript, Vitest.

**Spec:** Task #2306 (Dee's daily improvement), brief by the PM; incident screens in the task's thread (2026-11-03).

## Global Constraints

- The PR body starts with: `Requested by dee@autonomous.ai through Harness.`
- Two independent security reviews: the relay carries the owner's subscription; the owner's credential never reaches the
  Team user. This change adds no new path for the token: the same file, the same relay, the same checks.
- Never run a test that signs this Mac out of the real CLI; tests use temporary data folders and a fake upstream.
- Swarm code stays out of `cli/src/core`: the only core change is one data entry in the Swarm row of `EXPERIMENTS`, a file
  name, with no Swarm import.
- Stop only processes started here, by id. Temporary files only in `mkdtemp` folders.

## Review Focus

1. An owner's Mac whose Team account was removed: the grant file is forgotten at the first pass, so the Swarm service is
   woken once more and then no longer. (Task 1 test: a data folder without the file wakes nothing.)
2. A grant file another local user planted in the owner's data folder: the data folder is the owner's and closed; waking
   only starts the owner's own service, and `readRememberedGrant` still refuses a file not the owner's alone.
3. An agent writing about connection errors in its own words is not a failing model: the new lines are matched only near
   the prompt, as the old ones are. (Task 2 test.)
4. The host journal still wakes the service on its own: an owner who hosts a Swarm and has no Team account keeps today's
   behaviour. (Task 1 test.)
5. A Codex agent at "Reconnecting... waiting for network" is matched by the existing line; pinned so a later change to it
   cannot drop it. (Task 2 test.)

## Design

- **Growth:** nothing new is stored. The grant file already exists and is removed when the Team account is gone.
- **Concurrency:** N/A because the wake is one read at the core's start, as for the other experiments.
- **Read cost:** one more `existsSync` at the core's start.
- **Scale:** N/A because it is one file per Mac; the Swarm service's process (about 60 MiB) now also runs on owners' Macs
  that keep a Team account, which needs it for the relay anyway.
- **Compatibility:** an older core ignores the file and keeps today's behaviour; a newer one wakes the service.
- **Migration and rollback:** none. A Mac whose owner's Swarm service ran on 0.5.26 or later already has the file. Rolling
  back returns to waking on the host journal only.
- **Audience:** N/A because no data is exposed; the relay's own checks (owner-only folder, ACL for the Team user) are unchanged.
- **Identity:** the owner's daemon starts the owner's own service, as before.
- **Failure:** a relay that cannot start is logged and tried on the next pass (unchanged); an agent that still can't reach
  its model is reported to the PM after 10 minutes, now for Claude Code's connection lines too.
- **Platforms:** macOS, Linux and Windows alike: the file name is the same on each and the wake reads the data folder.

---

### Task 1: The owner's Swarm service starts again after a restart while a Team relay is kept

**Files:**
- Create: `cli/src/team/relayRestart.spec.ts`
- Modify: `cli/src/core/api.ts` (`EXPERIMENTS.superTabs.state`)

**Interfaces:**
- Consumes: `wakeExperiments` (`core/experiments.ts`), `EXPERIMENTS` (`core/api.ts`), `TeamRelayPublisher`,
  `readRememberedGrant`, `writeRememberedGrant`, `TEAM_RELAY_GRANT_FILE` (`team/relay.ts`), `startSubscriptionRelay`.
- Produces: `EXPERIMENTS.superTabs.state` includes `'team-relay-grant.json'`.

- [ ] **Step 1: Write the failing test** `restarting the owner's daemon under a running Team session`:
  - `it('wakes the Swarm service at start while a Team relay is kept here, and the session's next model request succeeds')`:
    a real relay over a fake upstream; a "session" holds the published grant and gets 200; the publisher stops (the
    daemon stops) and the request is refused; the "restart" asks `wakeExperiments` with the real `EXPERIMENTS`, a data
    folder holding only the kept grant and `outOfProcess` with `superTabs`; only if it asked for `superTabs` a new
    publisher runs; the session's same request then returns 200.
  - `it('wakes nothing for a data folder with neither the grant nor a host journal')`.
  - `it('names the kept grant by the same name the publisher writes')`: `EXPERIMENTS.superTabs.state` contains
    `TEAM_RELAY_GRANT_FILE`, and still `super-tabs/host-*.json`.
- [ ] **Step 2: Run it and watch it fail:** `npx vitest run src/team/relayRestart.spec.ts` (in `cli/`): the first and third
  fail (the service is never asked for; the state has no grant file).
- [ ] **Step 3: Add `'team-relay-grant.json'` to `EXPERIMENTS.superTabs.state`** with a comment naming the incident.
- [ ] **Step 4: Run it and see it pass**, plus `src/core/experiments.spec.ts` and `src/team/relay.spec.ts`.
- [ ] **Step 5: Commit** the test first, then the code.

### Task 2: The model alert knows Claude Code's connection failures

**Files:**
- Modify: `cli/src/superTabs/terminal.ts` (`MODEL_LINE`)
- Test: `cli/src/superTabs/terminal.spec.ts` (`reading a model that keeps failing off a screen`)

**Interfaces:**
- Consumes: `modelFailing(text: string): boolean`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test** `it('knows a relay that is gone: Claude Code's connection lines and Codex's reconnect')`:
  `modelFailing` is true for `⎿  API Error: Unable to connect to API (ECONNREFUSED)\n> `,
  `  ⎿  Unable to connect to API (ECONNREFUSED) · Retrying in 4s · attempt 3/10\n> `,
  `⎿  API Error: No internet route — check your connection or VPN (ENETUNREACH)\n> ` and the incident's Codex screen
  (`• Reconnecting... waiting for network (4h 21m 27s • esc to interrupt)\n  └ Connection failed: error sending request\n› Ask Codex to do anything`);
  false for `I will make the client say "Unable to connect to API" when the relay is down.` far above the prompt
  (`\n` + 30 lines + `> `).
- [ ] **Step 2: Run it and watch it fail:** `npx vitest run src/superTabs/terminal.spec.ts -t "relay that is gone"`.
- [ ] **Step 3: Extend `MODEL_LINE`** with `unable to connect to api`, `no internet route` and `connection failed: error sending request`.
- [ ] **Step 4: Run the file and see it pass.**
- [ ] **Step 5: Commit** the test first, then the code.

### Finish

- [ ] `npm run typecheck`, `npx vitest run src/team src/superTabs/terminal.spec.ts src/core/experiments.spec.ts`, and
  `npm run test:core` (the core file changed).
- [ ] Red/green evidence in a PR comment; mark Ready; two security review steps.
