# Store agents and companions reach the daemon over its socket: plan

> Written by the writing-plans skill's rules. Task #2076, the second follow-up of audit H1 (#2550, task #2016).

**Goal:** no Store agent, Store tool or companion sends the daemon's local credential, or anything else, to whoever holds its
loopback port on macOS or Linux.

**Architecture:** one small file, `localDaemon.mjs`, copied into each Store package (a package stands alone and has no
dependencies) and pinned identical by a test. It finds the daemon's socket, checks it is private, and gives the package a
WebSocket and a `fetch` over it. Node's own WebSocket cannot dial a Unix socket, so the file has a minimal client. With the socket
gone the daemon is down, and the client says so. Nothing falls back to the port.

**Tech:** Node 22 built-ins only in Store packages; `ws` (already a dependency) in companions and the Store tools that use it.

## What moves

| Client | Today | After |
| --- | --- | --- |
| `autonomous-grid`, `harness-monitor`, `memories` | WebSocket on 18473 with the credential | Socket, no credential |
| `machine-monitor` | The same, plus REST on 18473 with the credential | Socket for both |
| `store/tools` (`dsh-*`, experience tests) | WebSocket on 18473 with the credential | Socket |
| `companions` `pairRequest` | WebSocket on the port with the credential | Socket when its caller names one |
| `tui` | Already socket only | Unchanged |

## Design

- Growth: N/A because nothing is stored.
- Concurrency: N/A because each client still holds its own connection; no shared state is added.
- Read cost: N/A because each message is the frame it was. A `stat` of the folder and socket per connection.
- Scale: 10x clients are 10x connections on a socket the daemon already serves. First warning: the daemon's connection count.
- Compatibility: old packages keep working on TCP from this account, and keep their own "credential refused" text. A new package
  on an older daemon uses the socket every released daemon on macOS and Linux has. The socket missing reads as the daemon being down.
- Migration + rollback: no data. Reverting returns the packages to TCP. The catalog ships packages apart from the CLI.
- Audience: the filesystem enforces it: a socket of this account's, owner only, in a folder only this account can write.
- Identity: the socket's owner is the OS account; no login is read.
- Failure: daemon down, a socket that is not private and a dropped connection each reach the package's existing sentence.
- Platforms: macOS and Linux. Windows, and a data folder too long for a socket, stay on TCP with the credential, as #2550 leaves them.

## Tasks

1. **Red test.** `store/tools/port-holder.test.mjs`: a listener on the port with a real credential in the data folder, each client
   run against it, the holder hears nothing, and each client works over a fake daemon on the socket. Fails on main.
2. **`localDaemon.mjs`.** Route, privacy check, WebSocket, fetch. Its own spec: frames split across chunks, ping, close, oversized.
3. **Move the four packages.** `localCredentialHeaders` gives nothing where a socket can exist, as the CLI's does.
4. **Move the tools and companions.**
5. **Real check.** A read-only `agents_list` against this Mac's own daemon through a package, from a scratch copy.

## Left open

- Rotating the old bridge key and moving cloud agents' bridge calls off the port belong to this task too (Lead, 11-02), and build on
  #2558 once it merges: a second pull request with its own plan.

- Windows clients still send the credential to the port; moving them needs a proof-checked pipe client: its own task.
- Packages already installed keep sending the credential until the catalog updates them; a daemon with #2550 refuses it from another account.
- The samples in `samples/hackathon-fo` are out of this task's scope.
