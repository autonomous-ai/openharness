# @autonomous-ai/harness-mcp

[Harness](https://harness.autonomous.ai/agents) as an MCP server, for clients that install servers from npm.

Harness runs coding agents (Claude Code, Codex) in sessions of their own, on this computer or the person's other
machines, and the person can watch and join every one in the Harness app. With this server an agent can start
harnesses, wait for them, read their answers and close them:

| Tool | What it does |
|---|---|
| `harness_list` | the harnesses here: state, who started each, what each is about |
| `harness_start` | start an agent on a task in a folder, by name |
| `harness_wait` | wait until harnesses stop working |
| `harness_read` | a harness's last ask and its answer |
| `harness_close` | close a harness you started |

An agent may give work to, and close, only the harnesses it started.

## Install

Harness itself (macOS or Linux; no account needed for harnesses on this computer):

```
curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
harness start
```

Then add the server to your client, for example:

```
claude mcp add harness -- npx -y @autonomous-ai/harness-mcp
```

```json
{ "mcpServers": { "harness": { "command": "npx", "args": ["-y", "@autonomous-ai/harness-mcp"] } } }
```

This package runs `harness mcp` from the installed CLI (or `HARNESS_BIN`). Where Harness is not installed, the
server offers one tool, `harness_setup`, that says how to install it.

Claude Code and Codex can also install the Harness plugin, which brings a skill with it: see
[harness.autonomous.ai/agents](https://harness.autonomous.ai/agents).

MIT licensed. Source: [autonomous-ai/openharness](https://github.com/autonomous-ai/openharness/tree/main/cli/packages/harness-mcp).
