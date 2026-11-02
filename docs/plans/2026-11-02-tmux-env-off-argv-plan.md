# Session variables never on tmux's command line (audit M2)

Task #2017, from the Team account audit (`docs/security/2026-11-02-team-account-boundary.md`, M2, on PR #2538).

## Problem

`TmuxBackend.create` passed a session's variables as `new-session -e KEY=VALUE`, and `respawn` as
`respawn-pane -e KEY=VALUE`. Every account on a Mac can read every process's command line (`ps -axww`).

- When `new-session` starts the tmux server, the server keeps that command line as its title for its whole
  life. On the Mac Studio the Team account's tmux server showed its `ANTHROPIC_AUTH_TOKEN` to every account.
- Even with a server already running, the client lives for milliseconds with the value on its command line:
  a loop of `ps` catches it.

## Change

When a create or respawn carries variables, the backend runs `tmux start-server ; source-file -` and writes
the same command list on the client's standard input. The command line holds no value, so neither the client
nor a server it starts shows one. Nothing is written to disk, so a crash leaves no file behind.

- The list is written in tmux's command syntax: each word single-quoted, a `'` closed and given in double
  quotes, and a newline or carriage return given as `"\n"`/`"\r"`. Measured on tmux 3.7: a raw newline in a
  single-quoted word lost a following line that started with `#`. Quotes, `$`, `~`, `#{…}`, `%if`, `;`,
  braces, control characters and a 200 KB value all came back unchanged.
- `start-server` first, because `source-file` alone does not start a server ("no server running").
- A create or respawn with no variables keeps today's command line exactly.
- `source-file -` is tmux 3.1. `create` with variables already needs 3.2. A respawn with variables needed 3.0;
  it now needs 3.1 and is refused by name below it (`respawnRefusal`), never sent with the value in argv.
- The `-P` pane id prints from inside `source-file`. A server that `start-server` just started prints its
  `~/.tmux.conf` errors to the client after it, so `create` reads the first line only.
- From `source-file`, tmux does not give the options chained after `new-session` to the new session, as it does
  on a command line: they went to another session's pane (found in review). On this path each option names the
  new session exactly (`-t =NAME:`), so a create with variables needs a name without `:` or `.`; every caller
  gives one, and one without is refused.

Not changed: the engine's own command line (the launch script carries what it needs), and `clearEnv`, which
sends names only.

## Tests (each fails on main)

- Unit, fake tmux: a create and a respawn with a token send no value in any argument; the value arrives on
  stdin and parses back to the same `-e` words. Tricky values round-trip through the quoting.
- Unit: a respawn with variables on tmux 3.0 is refused and asks tmux nothing.
- Real tmux, private server: a create with a token, on a machine with no server running, leaves the token in
  no process's command line (`ps -axww`), and the session's environment has the exact value. A respawn the same.

## Design

- growth: N/A because nothing is stored; the input pipe closes with the call.
- concurrency: N/A because each call is one tmux client, as before.
- read cost: N/A because no reads are added.
- scale: N/A; one extra pipe write per create or respawn that has variables.
- compatibility: tmux 3.1 or newer for a respawn with variables (was 3.0); refused by name below.
- migration + rollback: none; a server started before this keeps its title until it restarts, so the Mac
  Studio's Team tmux server needs one restart, and its token should be rotated.
- audience: N/A; local processes only.
- identity: N/A.
- failure: a tmux error still answers with tmux's first stderr line, as before.
- platforms: macOS and Linux (tmux only).
