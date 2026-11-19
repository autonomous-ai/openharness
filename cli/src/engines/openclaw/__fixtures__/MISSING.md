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

## Composed, not captured whole

`screen-banner.txt`, `screen-connecting.txt`, `screen-starting-up.txt`, `screen-sending.txt`, `screen-waiting.txt`,
`screen-running-quiet.txt`, `screen-history-failed.txt`, `screen-history-refused.txt`, `screen-disconnected.txt`,
`screen-startup-failed.txt` and `screen-answer-history-words.txt` are `screen-plain-start.txt`'s title, footer and
rules (session `plain`, 120 columns) around status, chat, box and banner strings a reproduction of a first task on a
slow Gateway recorded from OpenClaw 2026.11.2 on macOS 26.6 arm64 (Node 24.22.2): its panes, and the status line it
read every poll from launch to ready, through a run, and through a `chat.history` the Gateway did not answer in time.

- **banner**: the lines the TUI draws before its title, with one of its random taglines.
- **connecting, starting-up**: the status lines drawn before the Gateway answers; the footer reads `unknown` until then.
- **sending, waiting, running-quiet**: a run's busy lines (`⠋ sending • 0s | connected`,
  `⠼ flibbertigibbeting… • 0s | connected`, `⠦ running • 0s | connected`). The recording saw `0s` only:
  `running-quiet`'s `45s` is the TUI's own elapsed format (`Ns`) at a quiet tool step.
- **history-failed, history-refused**: the system lines and `gateway connected | idle` / `connected | idle` drawn when
  the first history load fails, and the message the TUI put back in its input box after refusing it.
- **disconnected**: the bare `disconnected | idle` drawn between two reconnect tries.
- **startup-failed**: `startup failed | idle` is the status the TUI sets when a connection's start fails
  (`setConnectionStatus("startup failed", …)` in its source); the recording did not see it. The chat line drawn with
  it (` startup failed: <error>`) is left out: no error was recorded.
- **answer-history-words**: a model's answer saying `history failed:` at column 0, over a ready status line.

`screen-box-scrolled.txt` is drawn line by line by OpenClaw 2026.11.2's own components (pi-tui's `Text` and `Editor`,
rendered with no terminal) at tmux's default 80x24: a 560-character message OpenClaw refused before it connected, put
back in its input box with the cursor at its end. The box shows 7 lines (30% of the rows, at least 5), so its top border
reads `↑ 1 more`. `connected | disconnected` is the status a connection leaves after such a refusal (the TUI resets only
a `starting up` activity when it connects).

`screen-narrow-starting-up.txt` and `screen-narrow-history-refused.txt` are `screen-starting-up.txt` and
`screen-history-refused.txt` drawn the same way at 40 columns, where the title, the status line, the system lines, the
footer and the box each wrap. The busy status line has the blank line pi-tui's `Loader` draws above it, which the
120-column compositions leave out.

`screen-gateway-starting.txt` and `screen-starting-up-disconnected.txt` are `screen-starting-up.txt` with the status
lines a cold Gateway drew on a slow Linux machine (arm64 Debian 12, 0.6 CPU, OpenClaw 2026.11.2) for 85–110 s:
`<spinner> starting up • Ns | gateway starting` (the Gateway's answer while it starts, `resolveGatewayDisconnectState`
in OpenClaw's tui) and `<spinner> starting up • Ns | disconnected` between its tries.
