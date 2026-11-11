# Retire the bridge's old key, and move cloud agents' bridge calls to its socket: plan

> Written by the writing-plans skill's rules. Task #2076, the two pieces #2558's review named. Part 1 is #2566.

**Goal:** on macOS and Linux, no key the bridge accepts has ever crossed its TCP port, and Harness's own cloud calls no longer use it.

**Architecture:** the bridge's 0600 socket also answers Harness's key (`/<harness key>/connections`, `/<harness key>/<code>/api/...`, and its MCP address), and the TCP listener stops accepting that key. `cloud/bridge.ts` routes through the socket, with no fallback. Harness's key is replaced once, as it did cross the port. The agents' old key keeps working for 24 hours after its entries moved to the shim, then it is deleted.

## Design

- Growth: N/A because the only stored additions are two small fields, one a time that goes with the key it describes.
- Concurrency: the key files change under the vault's lock, at the service's start. A request reads the file as it does today.
- Read cost: N/A because each request reads the same file it read before.
- Scale: N/A because the cloud service's calls are the requests they were, on another listener.
- Compatibility: an agent still running from a URL entry keeps working for 24 hours, then answers 404 until it restarts, and its next start uses the shim. An old cloud service is restarted with the daemon. A folder too long for a socket, and Windows, keep the key and the port as they are.
- Migration + rollback: the first start after this stamps the time and replaces Harness's key. A rollback after the old key is gone makes a new one at the next `sync`, as a fresh install does.
- Audience: the filesystem for the socket, the peer check on TCP. The agents' route on the socket still reaches MCP servers only.
- Identity: the OS account; no login is read.
- Failure: with the socket gone, cloud calls say Connections is not running. A retired key answers as any unknown key does, so the answer does not confirm it.
- Platforms: macOS and Linux. Windows is unchanged.

## Decisions

- **24 hours, not at once.** A key heard already opens nothing for another account (#2550), so a day's grace costs little, while deleting it at once would cut every running agent's connections at the update.
- **The port keeps listening.** With no key it answers nothing, and while it is held by this daemon nobody else can hold it for clients still on it.

## Tasks

1. Red tests: a holder of the port hears no cloud call or key; the socket answers Harness's key; TCP refuses it where a socket can be; the old key lives 24 hours then goes; Harness's key is replaced once; no socket, nothing changes.
2. `serveBridgeSocket` takes Harness's key; `fetchOverSocket` in `lib/localTransport.ts`.
3. `cloud/bridge.ts` and `cloud/mcp.ts` route through it.
4. `retireBridgeKey` and `rotateHarnessKey` in `agents.ts`, called from `services/connectors.ts`.

## Left open

- Windows, and a data folder too long for a socket, still send keys over TCP: its own task, with a proof-checked pipe.
