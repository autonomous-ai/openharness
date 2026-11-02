# Team Relay Survives Its Owner's Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A running Team agent keeps reaching the model after its owner's daemon restarts.

**Architecture:** The owner's daemon runs the Team account's relay on a random port with a new token each start, and a running agent keeps the address and token it launched with. So every restart strands every running Team Claude agent with "Connection refused". The daemon now keeps its grant in a private file and, at its next start, binds the same port and accepts the same token. If the port is taken, it falls back to a new port and a new token, as today.

**Tech Stack:** TypeScript, Node `http`, Vitest.

**Spec:** Task #2125. The Lead confirmed the cause on Mac Pro-9: a fresh Team agent answers at once, while running ones get ECONNREFUSED on their launch port. #2550, #2558 and #2576 are not the cause; the dev build's install restarted the owner's daemons.

## Global Constraints

- Never print or log a token. It lives only in the private file, the published file and the launched engine's environment.
- The private file is the owner's: mode 0600, in the owner's Harness data folder, inside the closed home. Ignored unless it is a plain file of this user's, closed to everyone else.
- Stopping the daemon still withdraws the published file, so nothing new launches against a stopped relay.
- A Team account's removal forgets the private file too. The next account gets a new token.
- Swarm code stays out of `cli/src/core`. Two security reviews (this touches a credential): Reed and Cleo.

## Review Focus

1. The old daemon is still closing when the new one binds: it retries for 10 seconds before it gives up the port.
2. Another process holds the port: a new port and a **new** token, so whatever that process heard is dead.
3. A private file that is corrupt, a link, someone else's or open to others: ignored, with a new grant and no crash.
4. A token heard on the port while the daemon was down keeps working once it returns, because the token is reused. This is new, and stays as a named limit, ended by a 30-day rotation at a restart: see Design.
5. Revoking the Team account's token cuts a reused token as it does a minted one.

## Design

- **Growth:** one file, replaced in place, deleted with the Team account.
- **Concurrency:** one daemon owns the file. A write is a temporary file and a rename.
- **Read cost:** one read at the daemon's start.
- **Scale:** N/A because it is one grant per Mac.
- **Compatibility:** Team daemons are unchanged, as they read the same published file. The first restart onto this build still strands running agents, since the old daemon saved no grant.
- **Migration and rollback:** none. Rolling back leaves an unused file.
- **Audience:** the port still takes only the token. Reading the token needs the owner's account.
- **Identity:** N/A because no login changes.
- **Failure:** a failed save is logged, and only continuity is lost. The port taken gets a logged fallback.
- **Platforms:** the same code on macOS, Linux and Windows. Windows skips the mode check, as the folder's ACL covers it.
- **Security limit:** while the daemon is down, a local account that takes the port hears the token from running agents, and could reuse it once the daemon returns if it let the port go first. Today it could hear the old token too, but that token dies at the restart. The token only spends model calls through the relay's allowed paths (#2541), never the owner's sign-in. A restart more than 30 days after it was minted starts a new one (security review 1).

---

### Task 1: The relay takes a port and an existing token

**Files:**
- Modify: `cli/src/lib/subscriptionRelay.ts`
- Test: `cli/src/lib/subscriptionRelay.spec.ts`

**Interfaces:**
- Produces: `SubscriptionRelayDeps.port?: number`; `SubscriptionRelay.adoptToken(guestEmail: string, token: string): void`.

- [ ] **Step 1: Write the failing tests:** a relay started with a taken port rejects with `EADDRINUSE`; one started with a free port listens there; an adopted token is accepted and another refused; revoking the guest cuts the adopted token.
- [ ] **Step 2: Run them:** `npx vitest run --no-coverage src/lib/subscriptionRelay.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `deps.port ?? 0` in `listen`, and `adoptToken` by the same digest map as `mintToken`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: The publisher keeps its grant across a restart

**Files:**
- Modify: `cli/src/team/relay.ts`, `cli/src/superTabs/service.ts`
- Test: `cli/src/team/relay.spec.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `TeamRelayPublisherDeps.startRelay(port?: number)`, `remembered(): TeamRelayGrant | null`, `remember(grant): void`, `forget(): void`, `wait?(ms: number): Promise<void>`; `readRememberedGrant(file)`, `writeRememberedGrant(file, grant)`.

- [ ] **Step 1: Write the failing tests:**
  - a new publisher with a remembered grant starts on its port, adopts its token and publishes the same grant;
  - end to end with two real relays and a fake upstream: an agent's address and token work before and after a restart, on main they get refused;
  - a port still closing is retried, then taken;
  - a port held for good gets a new port and a new token, and the new grant is remembered;
  - `stop()` withdraws the published file and keeps the private one; the account's removal withdraws and forgets;
  - `readRememberedGrant` ignores a corrupt file, a link, a file open to others, and a url or token of the wrong shape.
- [ ] **Step 2: Run them:** `npx vitest run --no-coverage src/team/relay.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `pass()`, with the file `team-relay-grant.json` in the data folder, passed in from `service.ts`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Proof and notes

**Files:**
- Modify: `docs/security/2026-11-02-team-account-boundary.md`

- [ ] **Step 1: Add the limit** to the security notes, beside M4's line about the one token.
- [ ] **Step 2: Run** `npm run test:core` and the affected Team and Swarm specs. Expected: no new failures.
- [ ] **Step 3: Commit, open the pull request,** and ask Reed and Cleo.

Not in this task: machine sharing's relay for guests (`services/sharedMachines.ts`) has the same restart behaviour. It stays as a follow-up.
