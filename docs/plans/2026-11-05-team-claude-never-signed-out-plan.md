# A release never leaves Team-account Claude agents signed out: plan

> Way of working: test-driven, one Engineer, by the project instructions (Engineer role). No Execution Handoff.

**Goal:** a CLI release restarts every owner's daemon and the relay its Team account spends. A Team-account Claude
launched while the owner's grant cannot be read waits for it and starts on it, never signed out; and a Team agent
already showing Claude's signed-out or 401 screen is relaunched onto the current grant (task #3301).

**Architecture:**
- `teamRelayLaunch` (`cli/src/team/relay.ts`) answers a Claude launch in a Team daemon that has its team config, is not
  signed in itself and reads no grant with a refusal (`NO_CLAUDE_RELAY`), as it already does for a Codex Product
  Manager's own home. Both callers honour a refusal already: a relaunch (restore after a daemon restart, restart,
  resume) is held with `OWNER_RELAY_UNAVAILABLE` / `unavailable: 'native'` (`cli/src/lib/launchOverrides.ts`), and the
  held pass (`core/agents/heldLaunches.ts`) tries it again every 2–30 s, so it launches on the grant once it reads. A
  new agent (`core/agents/create.ts`) is refused with the same code instead of starting signed out, and the Swarm start
  moves on.
- The terminal watch (`cli/src/superTabs/terminal.ts`) recognizes Claude Code's own signed-out notices near the prompt
  (`Not logged in · Please run /login`, `API Error: 401 …`, `authentication_error`, `Invalid API key`, `OAuth token has
  expired`) as a model that does not answer, only where Claude draws its notice (at the margin or as its own `⎿` row),
  never in text the agent printed. That feeds the model alert and `RelayRecovery` (`cli/src/superTabs/relayRecovery.ts`)
  as a 5xx does: after a minute, with a current grant that answers, the agent is restarted once per grant onto it.

**Tech stack:** TypeScript, vitest.

**Spec:** task #3301; Guide2's diagnosis in task #3069 (main 8704f62c4). Builders on Mac 3, MacBook-Pro-8, Tony's,
Ken's MacbookPro and Gray's Team accounts stopped after 0.5.50–0.5.54; Quince showed `Not logged in · Please run /login`.

## Global constraints

- CLI only. Swarm code stays out of `cli/src/core`: no core file changes; both core callers already honour a refusal.
- No new credential path: the grant is read as every launch reads it; the token is never logged.
- Team daemon only. A Team account that signed Claude in itself, a non-Team daemon, and a Team daemon with no team
  config launch as before.
- No test signs the Mac out of the real CLI: all deps are fakes.

## Review focus

- That no Team-account Claude can be launched without a relay grant or its own sign-in (create, restore, restart).
- That a held relaunch launches on the grant once it reads (daemon restart mid-session).
- That signed-out detection cannot fire on an agent's own prose or a tool's output (no restart of a working agent).
- That recovery still restarts at most once per agent per grant.

## Tasks

### Task 1: a Team Claude with no readable grant is held, then launches when it reads

Files: `cli/src/team/relay.ts`, `cli/src/team/relay.spec.ts`, `cli/src/lib/launchOverrides.spec.ts`.

Interfaces: `export const NO_CLAUDE_RELAY: string`; `teamRelayLaunch('claude', …)` returns `{ refused: NO_CLAUDE_RELAY }`
when team, config present, not signed in, and `read(config)` is null.

- [ ] Failing test (relay.spec): Claude in a Team daemon, not signed in, no grant → `{ refused: NO_CLAUDE_RELAY }`;
      signed in, not Team, or no config → null as before.
- [ ] Failing test (launchOverrides.spec): a daemon restart mid-session. The real `teamRelayLaunch` with a grant that
      is gone while the owner's daemon restarts: the relaunch is held (`OWNER_RELAY_UNAVAILABLE`, `native`); once the
      new grant reads, the next relaunch carries the new address and token.
- [ ] Watch both fail; implement the refusal; watch them pass. Run `relay.spec`, `launchOverrides.spec`,
      `core/agents/create.spec`.

### Task 2: a 'Not logged in' or 401 screen is recovered by relaunch

Files: `cli/src/superTabs/terminal.ts`, `cli/src/superTabs/terminal.spec.ts`, `cli/src/superTabs/relayRecovery.ts`
(doc), `cli/src/superTabs/relayRecovery.spec.ts`.

Interfaces: `export function signedOut(text: string): boolean`; `modelFailing` unchanged; the watch treats
`modelFailing || signedOut` as a model that does not answer.

- [ ] Failing tests (terminal.spec): `signedOut` knows Claude's notices and not the agent's own words or a tool's
      output; the watch reports `failingSince` to the relay recovery for a signed-out screen.
- [ ] Failing test (relayRecovery.spec): an agent launched signed out after a daemon restart (no grant it was
      restarted for), showing `Not logged in`, is restarted once onto the grant that now reads, and told to carry on.
- [ ] Watch them fail; implement; watch them pass. Run `terminal.spec`, `relayRecovery.spec`.

### Task 3: evidence

- [ ] Red/green evidence (tests on main's code vs the branch) in a PR comment; CLI coverage gate for the touched area
      (`npm run test:orchestrator` if it covers superTabs), recorded in the PR.
