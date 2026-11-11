# Local credential reaches only the real daemon (audit H1)

**Goal:** a process of another account that takes the daemon's port (18473) or the bridge's (51793) while they
restart learns nothing it can use. Requested by Scholes, task #2016; finding H1 in
docs/security/2026-11-02-team-account-boundary.md (PR #2538).

## Decisions

1. **Unix socket only on macOS and Linux.** Hooks and CLI clients reach the daemon over `daemon-<port>.sock` (0600
   in a 0700 folder). When the path fits and the socket is gone, the daemon is down: the client reports that and
   never tries TCP, because the body (prompts, files) would reach the holder too. TCP stays only where a socket
   cannot exist: a data folder too long for one. Windows is unchanged.
2. **Hooks get their own token.** A new 0600 `hook-token` opens `/api/hook/*` and nothing else. Engine plugins
   (OpenCode, Kilo, Pi, Amp) cannot use a socket from every runtime, so they send it over TCP. Copies already
   loaded keep sending the credential, which hook routes still accept.
3. **A credential or key heard is useless.** MCP clients only speak HTTP to the address in their config, and old
   clients, Store agents and Desktop's fallback still send the credential, so hearing alone must open nothing.
   The daemon and the bridge accept a credential or key over TCP only from a connection this OS account owns:
   `/proc/net/tcp` on Linux, `lsof -u` on macOS (88 ms measured, once per connection, and only after the secret
   matched, so a stranger cannot make it spawn anything). A lookup that fails refuses.

## Steps (test first)

1. `lib/peerAccount.ts`, with real same-account and absent-peer tests.
2. `hook-token` in `lib/hookAuth.ts`; hookServer, localWsServer and bridge use both.
3. `lib/localTransport.ts`: socket lookup, fetch over the socket, WebSocket target. `localCredentialHeaders` gives
   nothing when a socket can exist, so no sender can leak by mistake.
4. notify.mjs posts over the socket; plugins read `hook-token`.
5. Convert every CLI sender of the credential.
6. Invert "H1, still open" once #2538 lands; until then the same test is in `src/team/localCredential.spec.ts`.

## Design

- **Growth:** one 43-byte file per data folder; the peer cache is a WeakMap on the socket, gone with it.
- **Concurrency:** token creation uses O_EXCL, and a loser reads the winner's. Lookups are one per connection.
- **Read cost:** one lookup per TCP connection carrying a valid secret; none on the socket.
- **Scale:** at 10x CLI TCP calls lookups cost CPU, but converted clients use the socket. First warning: the
  `[peer]` refusal log line.
- **Compatibility:** an old daemon accepts the new hook over its socket, which still carries the credential. Old
  clients over TCP work from this account. A new CLI with an old daemon uses the socket, which old daemons have.
- **Migration + rollback:** `hook-token` is made at start. Rolling back leaves an unused file; plugins are
  reinstalled at start.
- **Audience:** the server enforces it, by the peer's OS account.
- **Identity:** the peer's OS uid, never a login.
- **Failure:** a failed lookup refuses with a logged reason; a taken bridge port is logged.
- **Platforms:** macOS and Linux change. Windows keeps its proven pipe and has no peer lookup.

## Left open, on purpose

- An MCP client still sends its key and tool calls to whoever holds 51793. The key opens nothing for them, but
  they can read those calls and answer them falsely. Closing that needs a stdio shim: its own task.
- A plugin's session-start body and `hook-token` reach a holder of 18473, as does any hook in a data folder too
  long for a socket. The holder hears them, but the daemon refuses the token from another account.
- Store agents, companions and Desktop's fallback still send the credential over TCP. It opens nothing for another
  account, but they should move to the socket: follow-up task.
