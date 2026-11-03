# The subscription relay forwards only the engines' calls

Audit M4 (`docs/security/2026-11-02-team-account-boundary.md`, PR #2538): `lib/subscriptionRelay.ts` forwarded any path
under `/claude/` or `/codex/`, for any method, with the owner's vendor sign-in. A guest or Team agent holding a relay
token could therefore reach account endpoints, not only model calls, and an encoded `..%2f` went to the vendor as sent.

## Change

- **Routes.** Only these are forwarded; every other path is 404, a listed path with another method is 405:

  | Provider | Method | Path (after `/claude` or `/codex`) | Who sends it |
  | --- | --- | --- | --- |
  | claude | POST | `/v1/messages` | Claude Code's model calls (`?beta=true`) |
  | claude | POST | `/v1/messages/count_tokens` | Claude Code's token counts |
  | claude | GET | `/v1/models` | Claude Code's model list |
  | codex | POST | `/responses` | Codex's Responses calls (`wire_api="responses"`) |
  | codex | GET | `/models` | `team/relay.ts` `prepareCodexHome`, Codex's model list |

  Read from Claude Code 2.1.312, Codex 0.165 and our own callers.
- **Exact match on the path as sent.** The raw request path (before `?`) must equal a listed route byte for byte, so
  `%2f`, `%2e`, `%5c`, `\`, `//`, `.` and `..` segments are all refused, before the body is read and before the owner's
  sign-in is read. The query string is still passed through (`?beta=true`, `?client_version=`): it cannot change the path.
- **Revoke ends what is in flight.** `revoke(guest)` aborts that guest's open requests: a stream stops, and a request still
  reading its body or the owner's sign-in answers 401 instead of being sent.
- **Log.** A refusal is one owner-log line with the method, the status and the guest's fingerprint; the refused path is
  not logged (it is the guest's text).

Not here: a per-launch token (M2's task; `mintToken` already gives each launch its own token).

## Design

- growth: N/A because the route list is a constant; the per-guest in-flight set deletes each entry when its request ends.
- concurrency: N/A because the relay is one Node process; the in-flight set is touched only on its event loop.
- read cost: N/A because no data is stored or read beyond one request.
- scale: N/A because the check is a constant lookup per request.
- compatibility: an engine version that calls a new path gets 404 until the route is added; the refusal is in the
  owner's log, so it shows.
- migration + rollback: N/A because nothing is stored; revert the commit.
- audience: the relay (the owner's daemon) enforces it, not the guest's engine.
- identity: unchanged: the owner's sign-in is spent only for listed engine calls.
- failure: a refused call answers 404/405 with a relay error body and an owner-log line.
- platforms: macOS and Linux, wherever the daemon runs the relay.

## Tests (each fails on main, except the first, which keeps the engines working)

- An engine path passes for each listed route.
- An account path (`/claude/v1/organizations/...`, `/codex/accounts/...`, `/claude/api/oauth/...`) is 404 and never reaches
  the vendor.
- `..%2f`, `%2e%2e`, `%5c`, `//` and dot segments are 404 and never reach the vendor.
- A listed path with another method is 405.
- A guest revoked mid-stream: the stream is cut (an error, not a clean end), and another guest is untouched.
- A guest revoked while its request waits on the owner's sign-in, on the vendor's first answer, or on the refresh after a
  401: it gets 401, and nothing more is sent upstream.
- A refusal closes the connection, so the next request on a reused socket is not reset.
