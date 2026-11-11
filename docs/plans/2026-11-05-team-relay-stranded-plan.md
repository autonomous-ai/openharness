# Team agents follow the owner's relay grant: plan

> Way of working: test-driven, one Engineer, by the project instructions (Engineer role). No Execution Handoff.

**Goal:** a Harness Team agent that was running when its owner's daemon restarted, and holds a relay address or token
that the relay no longer answers, gets the current grant without anyone restarting it by hand (task #3106).

**Architecture:** the Team daemon's terminal watch (`cli/src/superTabs/terminal.ts`) already reads each agent's screen
every 15 s and knows when its model is failing. A new `RelayRecovery` (`cli/src/superTabs/relayRecovery.ts`) is
consulted on each read. Once an agent's model has failed for a minute, it reads the grant published now. If the relay
answers a model call with that grant (a GET of the model list, which spends nothing), the agent is restarted in its
pane with the same session (`agent_restart`). Its relaunch reads the owner's relay again
(`lib/launchOverrides.ts` `ownerRelay`), so it comes back on the current address and token. A short continue is
then typed, as limit resume does. Each agent is restarted at most once per grant. If the grant does not answer,
nothing is restarted: a relaunch would not help.

**Tech stack:** TypeScript, vitest.

**Spec:** task #3106. Evidence: on daniel-pc, Team agents started after the 11:33 update work, and the ones running
through it lost Claude.

## Global constraints

- Swarm code stays out of `cli/src/core`. The token is never logged; a grant is compared only by a digest held in
  memory.
- Team daemon only. On any other daemon `grant()` is null and nothing changes.
- No new credential path. The relay, its tokens and what the Team account reads are as before. The probe uses the
  grant the Team account already reads at every launch.

## Review focus

- That a restart cannot loop: one per agent per grant digest.
- That nothing is restarted when the current grant does not answer (relay down, token refused, owner not signed in).
- That the continue is never typed into an open prompt.

## Tasks

### Task 1: a stranded agent is restarted once onto the current grant

Files: `cli/src/superTabs/relayRecovery.ts`, `cli/src/superTabs/relayRecovery.spec.ts`, `cli/src/superTabs/terminal.ts`,
`cli/src/superTabs/host.ts`.

- [ ] Failing spec: an agent whose model has failed for a minute, with a grant that answers, is restarted once and then
  gets a continue. The same grant never restarts it again. A grant that does not answer restarts nothing. A new grant
  allows one more restart.
- [ ] Failing spec on the real relay (`startSubscriptionRelay`): the old address is refused, the current grant answers
  the probe, and the restarted launch's environment names the current address and token.
- [ ] Implement `RelayRecovery` and wire it into `TerminalHost.watch` and the host's real dependencies.
