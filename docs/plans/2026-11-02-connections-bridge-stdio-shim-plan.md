# Connections bridge: MCP clients through a stdio shim: plan

**Goal:** MCP clients reach the connections bridge without a port another account can hold. Whoever holds the bridge's fixed
port can otherwise read tool calls and feed false answers to the owner's running agents. Task #2066, the follow-up that task #2016's
security review made a condition of #2550.

## Design

- **The shim.** A client's entry runs Harness's node on `mcp-shim.mjs --socket <path> <code>`, a small script written into the vault's
  private folder, as the Buddy guard is written. An entry naming the running script would name the lean bundle from the daemon, which has
  no CLI, or a worktree; naming cli.js would load all of it per connection per agent; the updater ships only cli.js and notify.mjs. It speaks MCP's stdio transport to the client
  and MCP's HTTP transport to the bridge over the socket. It streams answers, tracks the session, and sends one POST per message.
- **The socket.** The bridge's handler gets a second listener at `<vault>/bridge.sock`, 0600, through `listenLocalSocket`. It sits
  in the vault's private folder because a daemon and a `harness connections sync` from anywhere agree on that path, and the entry
  names it. It is not the daemon's own socket: the bridge is its own service, and this needs no new route in the hook server.
- **No key.** Reaching a 0600 socket is the credential, so the entry and the shim hold none. The socket answers MCP servers only: no
  list of connections and no key-only API, as an agent's key does.
- **No fallback.** With the socket gone the daemon is down, and the client is told so. Nothing goes to a port.
- **What stays on the port:** clients running from an old entry until they restart, Windows, a vault path too long for a socket, and
  Harness's own cloud agents. Moving Store agents, companions and old clients is the second follow-up, out of this task.

## Design rules

- Growth: N/A because nothing grows: one socket file and one script, replaced at each start and removed with the folder.
- Concurrency: requests run side by side as they do over HTTP; `initialize` and notifications go first and in order. The vault's
  own lock still guards its files. A second daemon on the vault finds a live socket and retries, as the port's listener does.
- Read cost: N/A because each message is the one request it was before. Each client now holds one shim process open.
- Scale: one node process per MCP server per running agent: 18 MB of memory footprint each (12 for a bare node; 50 and 39 MiB resident),
  measured on an idle Mac 2026-11-02. Process count warns first. 3 connections on 43 agent sessions is about 130 processes, about 2.3 GB of
  footprint; 10x that is too much for one Mac, so review this at 300 shim processes.
- Compatibility: entries are rewritten at each daemon start. A running client keeps its old address until it restarts, and the port
  still answers it. A server's own unprompted stream (GET) is not relayed, so `*_changed` notifications are lost.
- Migration and rollback: no data migration. A rollback writes URL entries again at the next start, and the key is still in
  `bridge.json` or made on demand.
- Audience: the filesystem enforces it: 0700 folder, 0600 socket, this account only.
- Identity: the socket's owner is the OS account running the daemon; no login is read.
- Failure: each failure answers the request by its id, so a client never waits for ever: daemon down, service refusal, an unreadable
  answer, or a socket not private. A forgotten session is reopened once. A socket that cannot bind is logged once.
- Platforms: macOS and Linux. Windows keeps the address until it has its own way.

## Steps

1. Spec: a holder of the old port hears nothing while a tool call works through the entry's shim; daemon down; socket boundaries.
2. `mcpShimSource.ts`, written by `sync`, `serveBridgeSocket`, entries in `agents.ts`, the listener in `services/connectors.ts`.
3. A real process check with a built CLI, Claude Code and Codex, in a throwaway home.
