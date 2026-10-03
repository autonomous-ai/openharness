# Round 19: terminal feel

**Score: 8.5 / 10** (round 18: 7.5). The frozen build is substantially closer to tmux. Ordinary echo is now byte-for-byte efficient, emoji clusters survive correctly, and the new persistent local shell survives a client crash with a real terminal application still running. One new medium issue remains: the startup terminal-capability probe silently consumes type-ahead. There are no confirmed critical or high findings in this bounded review.

## Build and isolation

- Commit: `32f43bb0d541445c312b739d39c2d9265ca45c6a`.
- Frozen SHA-256: `1df2f355d7b3d5841d91f53a36d744234d93145108768a88565aeacf4cc8b3f9`.
- Reference: `/opt/homebrew/bin/tmux`, version 3.5a.
- Used a unique executable copy, throwaway HOME, private HN_TMPDIR, ports 19530–19531, and `hnr19fe` socket prefixes. Every hn invocation supplied the copied binary, matching explicit socket/port arguments and environment; no inherited TMUX, TMUX_PANE or HN_SOCKET. Every tmux invocation supplied its private `-L` name.
- Used real local PTYs, raw terminal output, ANSI `capture-pane` comparisons, and the repository's demo mock. No installed hn, real daemon, default socket or default tmux server was used. Creature/tim was excluded.
- Read the handoff, terminal-fixes, session-feel-fixes and local-shell-fixes reports and the prior feel review. Product code was read only. The full local-shell driver and unit suite were not rerun.

## Prior findings rechecked

| Round-18 finding | Round-19 result | Independent evidence |
| --- | --- | --- |
| M1: Shift+Enter leaves `3;2u` in a shell | **Fixed** | Physical `CSI 13;2u` executes a pending shell command and creates its marker file, in both hn and tmux. |
| M2: VS16, skin tones and ZWJ clusters | **Fixed in the tested cases** | Twelve rows containing ⚠️, ✔️, ❤️, ℹ️, ☀️, 👨‍👩‍👧, 👍🏽, 🏳️‍🌈, 🇬🇧, precomposed/combining accents and soft hyphen produce identical captured text and cursor coordinates. Raw hn output keeps each tested emoji cluster contiguous, including VS16. |
| M4: RGB assumed for unknown `xterm-256color` | **Fixed** | With no TERM_PROGRAM and no terminal replies, both write indexed colour 208 for RGB `(255,128,0)`. The new query introduces M1 below. |
| M5: no daemon means no usable shell | **Fixed for ordinary local-shell use** | An unused port yields an executable native shell. A real foreground terminal application remains alive through UI SIGKILL and reattachment. |
| L2: tiny pane title/status covers content | **Visible placement fixed; geometry remains imperfect** | At 60×2 the visible pane bottom remains above the status line; at 60×1 the pane retains the screen. Neither crashes. The underlying local PTY still has at least two rows/columns; see L1. |
| L4: about 49 bytes per echoed key | **Fixed** | Ten separate echo frames produce exactly `helloworld`: **10 bytes in hn and 10 in tmux**, status off. hn also emits zero bytes during a settled three-second idle interval. |
| L5: dropped SGR attributes | **Remains** | Double underline, blink and overline are absent from hn's capture; tmux retains all three. See L3. |
| L7: no host on the default screen | **Fixed** | Default status-right contains `#{host_short}`, and the short host occurs in actual terminal output. |
| L8: continuous animation while agents work | **Remains, now faster** | Default look emits 7,586 bytes and 94 synchronized frames in ten seconds. `@hn-look tmux` emits zero bytes over the next three seconds with agents still working. See L2. |
| L9: hung daemon gives no feedback | **Fixed, with a noticeable detection interval** | SIGSTOP of the isolated mock yields a reconnect banner and `#{daemon_down}=1` after 11.95 seconds. The screen is preserved. Input typed after the banner is delivered when the mock resumes. |

This was a bounded terminal-feel pass. Picker selection, all copy paths, notification counts, password prediction, and every earlier tmux-command finding were not independently rerun. In particular, the earlier `C-b s` navigation and `C-b c` launcher findings are not marked fixed merely from reading the change list.

## New medium

### M1. Startup terminal discovery silently drops typed input

**Observed:** launch hn in a PTY; after it asks DA1, type a complete shell command 100 ms later; deliver the DA1 reply another 150 ms later. hn shows an untouched shell prompt and never executes the command. tmux 3.5a executes the same command and creates its marker file.

```
                         hn          tmux 3.5a
query first observed     0.060 s     0.054 s
command marker exists    false       true
```

With no terminal reply at all, hn does not enter its alternate screen until **1.563 seconds**, versus **0.058 seconds** for tmux. This is a startup pause, not an exit or crash.

**Expected:** retain ordinary input that arrives before or alongside capability replies, and let startup proceed while discovery is pending. Type-ahead is routine over a delayed connection; silently removing the first command is an input-integrity bug.

At this commit, `tui/src/term_out.rs::ask_terminal` polls stdin synchronously for up to 1.5 seconds, accumulates all bytes in its reply buffer, extracts only the XDA answer, then drops that buffer. DA1 detection does not preserve bytes before or after the reply. `main.rs` calls it before entering the alternate screen and starting the normal input reader. This also affects attaching a client.

**Reproduce:** run the guarded portable setup and Python case below. It simulates a 250 ms capability-response delay and compares both programs. The terminal reader drains output continuously, so this is not PTY backpressure.

## Lows

### L1. A one-row local pane still has a two-row native PTY

A small application records `os.get_terminal_size(0)` on SIGWINCH, clears the screen, writes `TOP` at its top, and `BOTTOM>` at the native PTY's last row. The visible bottom row remains useful, but the application receives dimensions different from the pane geometry.

| Client size, status on | hn pane format | hn native PTY | tmux native PTY |
| --- | --- | --- | --- |
| 60×4 | 60×3 | 60×3 | 60×3 |
| 60×2 | 60×1 | **60×2** | 60×1 |
| 60×1 | 60×1 | **60×2** | 60×1 |
| 1×1 | 1×1 | **2×2** | 1×1 |
| restored to 80×24 | 80×23 | 80×23 | 80×23 |

At 60×2, hn `capture-pane -p` returns `TOP\nBOTTOM>\n`, although `#{pane_height}` is 1. tmux returns `BOTTOM>\n`. Actual hn rendering chooses the bottom row, so this is **not** a recurrence of the earlier title-row obstruction. Native applications and capture scripts nevertheless see inconsistent geometry. `local.rs::size` and `Pane::resize_local` clamp to two.

**Expected:** native PTY dimensions and pane formats agree, including one-row/one-column panes.

**Reproduce using the shell helpers below:**

```bash
# Run hn inside the explicitly named outer tmux; the child clears inherited tmux state.
outer new-session -d -s view -x 80 -y 24 \
  "env -u TMUX -u TMUX_PANE -u HN_SOCKET HOME='$FE_HOME' PORT='$FE_PORT' HN_SOCKET_NAME='$FE_NAME' HN_TMPDIR='$FE_DIR' '$FE_BIN' -L '$FE_NAME' --port '$FE_PORT' -f '$FE_CONF' new-session -s work"
sleep 2
outer resize-window -t view -x 60 -y 2
sleep .3
h display-message -p -t work:0.0 '#{pane_width}x#{pane_height}'
h send-keys -t work:0.0 'stty size > "$HOME/hn-size"' Enter
sleep .3
cat "$FE_HOME/hn-size"
# Observed: pane 60x1; native stty: 2 60.

ref new-session -d -s work -x 60 -y 2
ref display-message -p -t work:0.0 '#{pane_width}x#{pane_height}'
ref send-keys -t work:0.0 'stty size > "$HOME/tmux-size"' Enter
sleep .3
cat "$FE_HOME/tmux-size"
# Expected/reference: pane 60x1; native stty: 1 60.
```

### L2. Default animation keeps the terminal active at about ten frames per second

With a 120×32 client, the demo mock's working `Train tokenizer` harness, no typing, and a settled screen:

```
default look, 10 s:    7,586 terminal bytes; 94 ESC[?2026h frame starts
@hn-look tmux, 3 s:        0 terminal bytes;  0 frame starts
```

The smoother animation is visible improvement, but it retains the previous low-severity objection: continuous output can keep an outer terminal's activity mark lit and consumes bandwidth while the pane itself is unchanged. The previous round measured 3.6 KB over ten seconds at about four frames per second. Those runs are not a controlled same-build comparison, so the byte totals should not be treated as an exact regression ratio.

**Expected:** an independent animation-off/reduced-motion option or a quiet status representation, without requiring the whole tmux look. `@hn-look tmux` is an effective workaround already.

**Reproduce:** from the repository root, with the setup below, start the mock only after confirming the port is free:

```bash
MOCK_DEMO=1 node tui/tests/mock-daemon.mjs "$FE_PORT" > "$FE_DIR/mock.log" 2>&1 &
FE_MOCK=$!
# Use a second config for the default appearance, without @hn-look tmux.
printf 'set -g default-shell /bin/sh\n' > "$FE_DIR/default.conf"
FE_CONF="$FE_DIR/default.conf"
outer new-session -d -s view -x 120 -y 32 \
  "env -u TMUX -u TMUX_PANE -u HN_SOCKET HOME='$FE_HOME' PORT='$FE_PORT' HN_SOCKET_NAME='$FE_NAME' HN_TMPDIR='$FE_DIR' '$FE_BIN' -L '$FE_NAME' --port '$FE_PORT' -f '$FE_CONF' new-session -s work"
sleep 2
h open-harness -s 'Train tokenizer'
sleep 3
outer pipe-pane -t view "cat > '$FE_DIR/animation.raw'"
sleep 10
outer pipe-pane -t view
wc -c "$FE_DIR/animation.raw"
h set-option -g @hn-look tmux
# Repeating the pipe capture now produces no animation traffic.
```

This shell recipe uses outer tmux, so exact byte totals can differ from the query-less PTY measurement above; continuous default animation versus quiet tmux look is the expected observable result.

### L3. Double underline, blink and overline are still dropped

This is a confirmed residual from earlier rounds, not caused by local persistence. Emit SGR 21, 5 and 53 from either a local shell or a pane application. hn renders/captures plain text for all three. tmux's ANSI capture retains the attributes:

```
input               hn capture       tmux capture
SGR 21 + DOUBLE     DOUBLE           ESC[4:2mDOUBLE ESC[0m
SGR 5  + BLINK      BLINK            ESC[5mBLINK ESC[0m
SGR 53 + OVERLINE   OVERLINE         ESC[5:3mOVERLINE ESC[0m
```

**Reproduce in either isolated shell:**

```bash
h send-keys -t work:0.0 "printf '\033[2J\033[H\033[21mDOUBLE\033[0m\r\n\033[5mBLINK\033[0m\r\n\033[53mOVERLINE\033[0m\r\n'" Enter
sleep .3
h capture-pane -ep -t work:0.0
# Run the same send-keys/capture-pane pair through ref for the comparison.
```

**Expected:** preserve these pane attributes as tmux does. Whether a physical terminal actually animates blink is separate from retaining the attribute in the pane model.

## Persistent local-shell checks that passed

A real Python terminal application, with no daemon, was compared against the same application in tmux. It wrote normal-screen history, entered the alternate screen, drew coloured text and emoji, saved its cursor, and enabled application cursor keys and bracketed paste. The test killed only the attached client with SIGKILL, then attached a fresh client.

- The foreground application kept the original PID.
- Before-crash and after-attach ANSI captures were identical. The captures also matched tmux, including colour and emoji.
- Up arrived as `ESC O A` before and after, in both tools.
- A paste arrived as exactly `ESC[200~pastedESC[201~` before and after, in both tools.
- DECRC restored the saved cursor identically.
- Resizing to 61×17 reached the application's native PTY as 61×17.
- A subsequent CPR query received one `ESC[4;15R` reply, in both tools.
- Leaving the alternate screen restored the same main-screen content and colour in both tools.
- Normal shutdown removed the test UI, supervisor and foreground application.

The completed independent pass exercised UI crash/reattach. Normal detach and headless-holder crash are covered by the existing full driver and earlier fix report, **not independently rerun here**. An additional application-mode detach probe was prepared but not launched after an automatic approval review hit the account usage limit; after access recovered, the review was closed from completed evidence rather than expanded.

## Guarded portable setup

Run each repro in a fresh Bash shell and fresh directory. The setup requires the frozen artifact at the supplied path, Python 3 and tmux 3.5a. It makes its own executable copy and never overwrites a running executable. Check that the chosen port is unused; do not repurpose a port occupied by another reviewer.

```bash
export FE_PORT=19530 FE_NAME="hnr19fe$$"
export FE_DIR="$(mktemp -d /tmp/hnr19fe.XXXXXX)"
export FE_HOME="$FE_DIR/home" FE_BIN="$FE_DIR/hn" FE_CONF="$FE_DIR/tmux.conf"
mkdir "$FE_HOME"
cp /tmp/hn-round19/32f43bb0/hn "$FE_BIN"
printf 'set -g default-shell /bin/sh\nset -g @hn-look tmux\nset -g pane-border-status off\nset -g status on\n' > "$FE_CONF"
unset TMUX TMUX_PANE HN_SOCKET
export HOME="$FE_HOME" PORT="$FE_PORT" HN_SOCKET_NAME="$FE_NAME" HN_TMPDIR="$FE_DIR"
guard() {
  [[ "$FE_PORT" =~ ^1953[0-9]$ && "$FE_NAME" =~ ^hnr19fe[A-Za-z0-9_-]+$ ]] || return 2
}
guard || exit 2
python3 - <<'PY'
import os, socket
p = int(os.environ['FE_PORT'])
assert 19530 <= p <= 19539
with socket.socket() as s:
    s.bind(('127.0.0.1', p))
PY
h() { guard && env -u TMUX -u TMUX_PANE -u HN_SOCKET HOME="$FE_HOME" PORT="$FE_PORT" HN_SOCKET_NAME="$FE_NAME" HN_TMPDIR="$FE_DIR" "$FE_BIN" -L "$FE_NAME" --port "$FE_PORT" -f "$FE_CONF" "$@"; }
outer() { guard && /opt/homebrew/bin/tmux -L "${FE_NAME}outer" -f /dev/null "$@"; }
ref() { guard && /opt/homebrew/bin/tmux -L "${FE_NAME}ref" -f "$FE_CONF" "$@"; }
finish() {
  if [[ -n ${FE_MOCK:-} ]]; then kill -CONT "$FE_MOCK" 2>/dev/null || true; fi
  h kill-server 2>/dev/null || true
  outer kill-server 2>/dev/null || true
  ref kill-server 2>/dev/null || true
  if [[ -n ${FE_MOCK:-} ]]; then kill "$FE_MOCK" 2>/dev/null || true; wait "$FE_MOCK" 2>/dev/null || true; fi
}
trap finish EXIT
```

For M1, run this immediately after that setup, with neither server already started:

```bash
python3 - <<'PY'
import fcntl, os, pty, re, select, shlex, signal, struct, subprocess, termios, threading, time
from pathlib import Path
p, name = int(os.environ['FE_PORT']), os.environ['FE_NAME']
assert 19530 <= p <= 19539 and re.fullmatch(r'hnr19fe[A-Za-z0-9_-]+', name)
base = Path(os.environ['FE_DIR'])
env = {'PATH': os.environ['PATH'], 'HOME': os.environ['FE_HOME'],
       'SHELL': '/bin/sh', 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
       'PORT': str(p), 'HN_SOCKET_NAME': name, 'HN_TMPDIR': str(base)}
programs = [
    ('hn', [os.environ['FE_BIN'], '-L', name, '--port', str(p), '-f', os.environ['FE_CONF']]),
    ('tmux', ['/opt/homebrew/bin/tmux', '-L', name + 'ref', '-f', os.environ['FE_CONF']]),
]
for label, command in programs:
    marker = base / (label + '-typed')
    marker.unlink(missing_ok=True)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    def control():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    ui = subprocess.Popen(command + ['new-session', '-s', 'work'], env=env,
                          stdin=slave, stdout=slave, stderr=slave, preexec_fn=control)
    os.close(slave)
    output = bytearray()
    def drain():
        while True:
            try:
                b = os.read(master, 65536)
            except OSError:
                return
            if not b:
                return
            output.extend(b)
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        deadline = time.monotonic() + 5
        while b'\x1b[c' not in output and b'\x1b[0c' not in output:
            assert time.monotonic() < deadline, 'no DA1 query'
            time.sleep(.005)
        time.sleep(.10)
        os.write(master, ('printf TYPEAHEAD > ' + shlex.quote(str(marker)) + '\r').encode())
        time.sleep(.15)
        os.write(master, b'\x1b[?1;2c')
        time.sleep(2)
        print(label, 'typed command executed:', marker.exists())
    finally:
        subprocess.run(command + ['kill-server'], env=env, capture_output=True, timeout=10)
        if ui.poll() is None:
            ui.terminate()
        ui.wait(timeout=5)
        reader.join(timeout=1)
        os.close(master)
PY
# Observed: hn false; tmux true. Expected: both true.
```

## Evidence and cleanup

Private repro scripts and captures are preserved under `/tmp/hnr19fe-zun_oc1v/`: `review.py`, `typeahead.py`, `modes.py`, `modeapp.py`, `tiny.py`, `tinyapp.py`, `mockfeel.py`, `startandstyle.py`, and `results/`. These contain the actual raw/ANSI evidence; the public instructions above avoid machine-specific home paths and usernames.

Each completed driver cleaned its own processes in `finally`. Final process and listener checks found no review hn clients, headless holders, PTY supervisors, applications, mock daemon, or tmux server left running, and no listener on 19530 or 19531. The refused extra probe launched nothing. No source edits, commit, push, merge, release or installed-binary change was made by this review.
