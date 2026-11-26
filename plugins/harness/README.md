# Harness plugin for Claude Code, Codex and Cursor

Lets a coding agent use [Harness](https://harness.autonomous.ai/agents): start Claude Code, Codex and other agents
as harnesses the person can watch, wait for them, read their answers and close them.

It holds two things:

- `skills/harness/SKILL.md`: the `harness` skill, in the [Agent Skills](https://agentskills.io) format. When to use
  Harness instead of your own sub-agents, the commands, and the rules.
- `.mcp.json` (Claude Code) and `mcp.json` (Cursor): Harness's MCP server, `harness mcp` over stdio. The two
  say the same.
- `.codex-plugin/plugin.json` (Codex, which reads it before `.claude-plugin/plugin.json`): the same plugin and server,
  with `default_tools_approval_mode = "approve"`, so Codex runs Harness's MCP tools without asking. What an agent may
  do with them is Harness's to decide; a setting the person makes for the server in Codex's `config.toml`
  (`[plugins."harness@openharness".mcp_servers.harness]`) still wins.

Both need the Harness CLI on the agent's `PATH`:

```
curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
harness start
```

## Install

Claude Code:

```
claude plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins
claude plugin install harness@openharness
```

Where Harness Device already set up Claude Code, `openharness` is there: run only
`claude plugin install harness@openharness`.

Codex:

```
codex plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin --sparse plugins
codex plugin add harness@openharness
```

In a Codex home with this marketplace, Harness sets up no
[Harness Device plugin](../harness-device/README.md#codex): the marketplace is yours, so Codex's waits outside a
Harness pane do not reach the dial there.

The marketplace is [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json) at the root of this
repository; Codex reads the same file. `--sparse` checks out only the marketplace and this folder: on October 11,
2026 that took 4 seconds and 3 MB for Claude Code, against 70 seconds and 670 MB for the whole repository, and
7 against 135 seconds for Codex. Inside a Claude Code session, `/plugin marketplace add autonomous-ai/openharness`
and `/plugin install harness@openharness` do the same, cloning the whole repository. Any other agent that reads `SKILL.md` can take the skill alone: copy
`skills/harness/` into its skills folder (`~/.agents/skills/` for Codex, `~/.claude/skills/` for Claude Code).

Cursor reads this folder through [`.cursor-plugin/marketplace.json`](../../.cursor-plugin/marketplace.json) and
`.cursor-plugin/plugin.json` here. It is not in Cursor's marketplace yet. To load it locally, copy this folder to
`~/.cursor/plugins/local/harness` (Cursor skips a symbolic link to a folder elsewhere), then run **Developer: Reload
Window**.

## Changing it

The skill describes commands agents run as written, so change it with the CLI (`cli/src/agentClient/`,
`cli/src/lib/newCommand.ts`) and with the pages that say the same: `website/public/agents/index.html` and
`website/public/llms.txt`. Check the plugin with `claude plugin validate .` from the repository root;
`website/scripts/agents-site.spec.ts` and `website/scripts/listings.spec.ts` check the rest, including that the two
MCP files agree. Where Harness is listed, and what each directory reads, is in
[docs/research/2026-10-11-listing-submissions.md](../../docs/research/2026-10-11-listing-submissions.md).

The plugin here has no `version`, so an install from GitHub tracks the commit it came from and `claude plugin update`
picks up changes on `main`. Harness stamps a version on the copy it carries for its own marketplace folder (its CLI's
version and a hash of the plugin's files), so that copy updates with Harness.
