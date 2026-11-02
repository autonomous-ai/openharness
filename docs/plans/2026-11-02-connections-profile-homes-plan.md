# Connections reach an agent running under a profile home: plan

**Goal:** An agent started under a Claude profile (`CLAUDE_CONFIG_DIR`) or a Codex profile (`CODEX_HOME`), such as a switched PM
(#2527-#2529), gets the connection entries the default homes get. Today `sync` writes only `<HOME>/.claude.json` and
`~/.codex/config.toml` (or the daemon's own moved homes), so such an agent has no connections. Task #2088.

## Design

- **Profile agents.** `agents.ts` gets a profile variant of the Claude (`<home>/.claude.json`, `mcpServers`) and Codex
  (`<home>/config.toml`) agents, named `claude:<home>` / `codex:<home>`. Their entries are the default ones: same shim, same code.
- **At launch.** `core/agents/create.ts` calls `syncProfileHome` for the agent's `claudeHome` / `codexHome` (already validated
  by `claudeHomeOffered` / the Codex profile check in `launches.ts`), after the home is final and before the engine starts.
  A failure is logged, never refuses the launch. The default homes are untouched; a profile that is the default's file is skipped.
- **Kept current.** `projections.json` records the names Harness wrote per agent name, so the profile agents are recorded under
  their own names. `sync` (daemon start, connect, disconnect, renewal, `harness connections sync`) also applies every recorded
  profile home, so a later connection reaches and a disconnected one leaves a running profile's config.
- **Only the profile's own home.** A Claude folder is validated by `claudeHomeOffered` where the launch is asked for; a Codex folder
  must be one of this machine's Codex profiles (`listCodexProfiles`, read at most every 30 s), so the folder a native launch picks
  for itself is not one. The default home is recognised by real path. A config that is a link leaving the folder is not written.
- **One bad home.** Each agent is updated on its own: a failure is logged and the others, and the record of what was written, go on.
  A launch waits 3 s for the vault's lock, not 35 s; a timeout is logged and the launch goes on.
- **Removed with the profile.** A recorded home whose folder is gone, or is no longer a Codex profile (its entries are taken out first), is dropped from `projections.json`; a home with no wanted
  connections has Harness's entries removed, like the default homes. Only recorded names are changed or removed.

## Design rules

- Growth: one record per profile home used; dropped when the folder is gone.
- Concurrency: the vault lock already covers `projections.json`; the engine's own config is replaced atomically as before.
- Read cost: `sync` reads each recorded home's config, once per change; the number of profile homes on a machine is small (<= 256 linked).
- Scale: 10x profiles is 2,560 config reads per connection change; review if a machine records more than 100 homes.
- Compatibility: an old daemon ignores `claude:/...` keys it does not know; a new one reads old files unchanged.
- Migration and rollback: none; a rollback leaves the entries in the profile homes, still working.
- Audience: the same user's files, in a home the daemon already validated and writes hooks into.
- Identity: N/A because no login is read.
- Failure: an unreadable config is left as it is; a failed write is logged and the launch goes on.
- Platforms: macOS, Linux, Windows (paths via `node:path`).

## Steps

1. Specs: an agent started under a Claude profile and one under a Codex profile get the entries (fail on main); a later
   connection reaches them, a disconnect and a gone folder remove them; the default homes are as before.
2. `agents.ts`, then `create.ts`.
