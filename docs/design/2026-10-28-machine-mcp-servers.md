# Machine MCP servers

Issue: #1872. From lampOS (autonomous-ai/lampOS#3997): the lamp as a tool for every agent Harness starts.

## What it helps someone do

A person attaches a local stdio MCP server to every agent Harness starts on their machine, once, instead of adding it
to each engine by hand. The first use is a paired lamp's `lamp-mcp` (lampOS `sdk/mcp`). It serves the lamp as tools
(`lamp_state`, `lamp_gesture`, `lamp_light`, `lamp_say`, `lamp_look`, `lamp_move`, `lamp_express`, `lamp_stop`) and
talks to the lamp directly over the home network. So "run the tests and light the lamp green if they pass" works for an
agent Harness started in a project folder it made.

```sh
harness mcp-servers add lamp --engine claude --engine codex -- lamp-mcp
harness mcp-servers                       # list
harness mcp-servers remove lamp
```

## How it works

- **Where it's stored:** `<data dir>/mcp-servers.json` on that machine, mode 0600, written whole (a 0600 temporary
  file renamed over it) by `harness mcp-servers` (`agentClient/mcpServers.ts`). A launch refuses a file that is group-
  or world-writable, or another user's, and logs `[agent] machine MCP servers not added · <file> is writable by others
  (mode 664): chmod 600 it`. The schema and the launch arguments are in
  `lib/machineMcp.ts`.
- **Entries:**
  - `command` and `args`.
  - `engines`: Harness engine names; empty means every engine with a path. A name the build has no path for is kept,
    and skipped at that engine's launch with one log line (`… · hermes has no machine MCP path in this Harness yet
    (lamp)`). So a later Harness's file still reads.
  - `projects`: Harness project names, matched at each launch by the launch folder being under `~/harnesses/<name>`;
    empty means every folder. A renamed project stops matching until the entry names the new one.
- **Not carried, after harness-reviewer's read of #1872:**
  - **No tool approval:** a file the agent's own user can write can't hold the person's consent. Each engine asks for
    a machine server's tools as it does for any server, and the person's "always allow" stays in that engine.
  - **No environment:** only `command` and `args` reach the agent's command line, which other users of the computer
    can read (`ps`). A server gets the agent's environment, and reads any secret from its own config.
  - An entry's other keys are left out when it's read.
- **Names:** a bare word, `[a-z][a-z0-9_]{0,31}`, so Codex's `-c` path and every engine's tool prefix (`mcp__lamp__…`)
  read the same. `harness`, the grid's server, is refused.
- **When it's read:** at every launch, where `agentLaunchArgs` already runs: create (`core/agents/create.ts`) and every
  relaunch (`lib/launchOverrides.ts`). A change reaches the next start, and a resumed agent keeps its servers.
- **Claude Code** (2.1.312, read off the binary 2026-10-28):
  - `--mcp-config=<json>` in the one-token form. `--mcp-config <configs...>` is variadic: on the binary,
    `--mcp-config <json> hello` read `hello` as a config file, and the `=` form did not.
  - A second `--mcp-config` beside a grid's is taken.
  - Never `--strict-mcp-config`, so the person's own servers stay.
  - Tried with a real `claude -p --model haiku`: the model called the test server's `add` tool through it, and the
    server logged the call.
- **Codex** (codex-cli 0.137.0, read off the binary 2026-10-28):
  - `-c mcp_servers.<name>.command|args`. `codex mcp list --json` reads these back as a stdio server, with quotes and
    spaces intact. A real turn was not run: Codex isn't signed in on the test laptop.
- **Not yet:**
  - Hermes takes servers only through the `HERMES_MANAGED_DIR` overlay, which a grid launch already owns
    (`lib/gridWebMcp.ts`). It needs the two merged into one directory, and the overlay skipped on an admin-pinned
    machine. That's a follow-up.
  - Copilot, OpenCode and Grok each have a grid path to extend the same way.
  - Other engines have no MCP path at launch.

## Who may change it

Only the person. An entry's command runs at every matching launch with no prompt (`--mcp-config` servers start without
Claude Code's project-server question), so `mcp-servers.json` is as trusted as the person's shell startup files. An agent (`model.ts` `outsideCaller`: Claude Code, Codex, `AI_AGENT`), or anyone in a pane a Harness daemon made
(`paneOwner(TMUX_PANE)`, as `harness mcp` asks; a person's own terminal pane there is refused alike and told to run it
outside Harness), is refused with exit 5, with no
`--person-said-yes` way round, because an entry runs a command inside every later agent on the machine. Listing is open
to anyone on the machine. The lamp holds its own limits: a Harness-started agent gets exactly the grants the lamp's
owner gave that computer, a body lease the person always wins back, and the lamp's rates and quiet hours.

## Design

- **Growth:** at most 8 servers and a 64 KiB file. `remove` deletes an entry. Nothing else accumulates.
- **Concurrency:** one writer at a time in practice (the person's CLI). Each write replaces the file atomically, so a
  launch reads the old file or the new one, never half of one. Two concurrent `add`s are last-writer-wins, said by
  `list`.
- **Read cost:** one small local file read per launch, no network.
- **Scale:** 10x the entries is past the cap. The cap is the limit, and it is said when reached.
- **Compatibility:** with no file, every launch is exactly as before, and the golden launch specs are unchanged. An older
  Harness ignores the file. The file has no version field: an unknown key in an entry is ignored, and a bad value
  refuses the whole file.
- **Migration and rollback:** none needed. Removing the file, or the version, restores today's launches.
- **Audience:** this machine only. The file is never synced, sent to the backend or shown to another machine, and the
  daemon reads it locally.
- **Identity:** the servers run as the agent's process, under the machine user who started Harness. No login of the
  owner is used or passed.
- **Failure:**
  - A file that doesn't parse, or that others could write, adds nothing. The daemon log says why at each launch (`[agent] machine MCP servers not
    added · …`), `harness mcp-servers` says it, and `add` and `remove` refuse until it's fixed.
  - A missing command, or a server that crashes, is reported by the engine as a failed MCP server, and the agent still
    starts.
- **Platforms:** macOS, Linux and Windows read the same file. The engine resolves the command on its own PATH.

## Tests

- `lib/machineMcp.spec.ts`: argv per engine, the choice by engine and project, refusals, and whole-or-nothing reads.
- `agentClient/mcpServers.spec.ts`: add, list and remove, and the agent refusal.
- `core/agents/create.spec.ts` and `lib/launchOverrides.spec.ts`: the servers reach create and every relaunch, beside a
  grid's, before Harness's instructions.
- The golden launch specs pass unchanged.
