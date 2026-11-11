# Fixtures not recorded, or recorded differently

Recorded from OpenClaw 2026.11.2 on Linux (`node:24-bookworm`) and macOS 26.6 arm64 (Node 24.22.2).

## Not recorded

- **Windows** (`*-win32.txt`, `ps-win32.txt`): not run here; it is measured separately on the Windows VM.
- **macOS beyond `plain`**: only `screen-plain-start-darwin.txt`, `screen-plain-darwin.txt` and `ps-darwin.txt`.
  The database rows of the other scenarios are the Linux ones.
- **An exec approval prompt on screen**: the TUI never shows one. OpenClaw's docs say "The TUI does not render
  exec approval cards", and with no approval client connected the Gateway denies the command at once
  (`exec denied: Headless runs cannot wait for interactive exec approval.`). `approval.sql` and
  `screen-approval.txt` record that denial, asked for with `/exec security=allowlist ask=always` on the message.

## Recorded differently

- **rewind**: the TUI has no rewind command, and `openclaw sessions` has no rewind subcommand. Rewind is the
  Control UI's `sessions.rewind` Gateway method, called here with
  `openclaw gateway call sessions.rewind --params '{"sessionKey":"agent:main:rewind","entryId":"<user message id>"}'`
  while the TUI stayed attached.
- **reset**: `/reset` resets the key in place (same window, a `reset` event appended). `/new` moves the pane to
  a new key, `agent:main:tui-<uuid>`. `reset.sql` holds both keys; `screen-reset-new.txt` is the pane after `/new`.
- **main-heartbeat**: scheduled heartbeats skip without an owner channel (`reason=no-route`); the poll in
  `main-heartbeat.sql` is the event-driven one the Gateway ran after a session was created.
- **approval.sql** has a second turn ("Reply with exactly: both panes"): a bare `openclaw tui` reopens the last
  session the TUI used, which was `approval`, not `main`.
- **two-panes-main**: both panes were opened with `openclaw tui --session main`, for that reason.
- **remote**: the second host is the same container reached by its bridge address through a TCP forwarder; the
  Gateway logs it as remote ("Loopback connection with non-local Host header. Treating it as remote.").
- **version-old-node-darwin.txt, version-node20-darwin.txt**: `openclaw --version` on Node 22.23.2 and 20.19.5
  (macOS, 2026.11.2), run with `OPENCLAW_NODE_UPDATE_RESPAWNED=1` and a PATH without another Node. Without it,
  OpenClaw finds a supported Node by itself (Homebrew's node@26 on this Mac) and runs on that one. `--version` is a
  diagnostic: it never installs a Node, and on Node 22 it answers with a warning rather than refusing.
