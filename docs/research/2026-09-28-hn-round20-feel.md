# Round 20: terminal feel

**Score: 9 / 10 after the focused fixes below** (round 19: 8.5). Startup,
ordinary input, pane attributes and native terminal recovery are materially
closer to tmux. This bounded pass found two residuals, repaired them, and
replayed their exact cases. No unresolved high or medium finding remains in
this pass. This is not an assertion that every terminal or tmux command was
exhaustively tested.

## Builds and isolation

- Initial frozen commit: `5401458c7d6f7f59960f864731ff7bae1bd27d64`.
- Initial SHA-256: `461ecf17895c9cac9c4eb5a5924cb1483904dd0873055cdaecf716cdc3c12b97`.
- Reference: real tmux 3.5a on macOS.
- The subsequent private frozen fix build was made from `b5830ad9` plus the
  pending round 20 fixes. Its SHA-256 is
  `022a10f739a740be9c7151db27c2f36b606c7634937c79547e55ba1778f5eda6`.
  It is a working-tree build, not a separately committed revision.
- Each build was copied to a new temporary directory before use. Drivers
  checked its hash, accepted only ports 19530–19539 and `hnr20fe` socket names,
  and used ports 19530–19531. Every hn call supplied matching explicit
  `-L`/`--port`, `PORT`, `HN_SOCKET_NAME`, disposable HOME and private HN_TMPDIR.
  No TMUX, TMUX_PANE or HN_SOCKET was inherited, including inside the private
  outer tmux. Every tmux command used its own explicit `-L`.
- No installed hn, default socket, real daemon or real harness was used. The
  creature was excluded. Initial review was read only; the coordinator then
  requested the two narrow fixes described below. No commit, push, merge,
  release or installation was performed by this reviewer.

## Rechecks

| Scenario | Result and evidence |
| --- | --- |
| Startup with no capability reply | First alternate screen in 61 ms for hn versus 57 ms for tmux on the initial candidate. The fixed copy measured 61 ms versus 54 ms. The old 1.56-second pause is gone. |
| Startup typeahead | Commands sent immediately after the DA1 query and 100 ms later execute in both tools, with the DA1 response delayed another 150 ms. Both cases passed again on the fixed copy. |
| Shift+Enter | Physical `CSI 13;2u` executes the pending shell command in both tools and creates its marker. |
| Emoji and combining marks | Twelve rows containing VS16, skin tones, family ZWJ, rainbow flag, regional indicators, composed/decomposed accents and soft hyphen have identical captures and cursor positions. Tested emoji clusters remain contiguous in raw hn output. |
| Echo and idle output | Ten separate key frames produce exactly `helloworld`: ten output bytes in each tool. Settled hn with status off emits zero bytes over three seconds. |
| Double underline, blink and overline | Native ANSI capture matches tmux. A private outer tmux also sees matching rendered cells for the initial SGR21/5/53 case, underline-only change, overline-only change and reset to plain. All four comparisons passed again on the fixed copy. |
| Animation opt-out | A stationary working demo produced 2,190 bytes and 30 synchronized frames over three seconds with animation on, then zero bytes with `@hn-animations off`. The default hostname is present. This option stops animation; ordinary clock/content updates remain possible. |
| Hung mock daemon | SIGSTOP produces visible reconnect feedback and `#{daemon_down}=1` after 12.63 seconds. The screen remains, and input typed while down arrives after SIGCONT. The detector strips ANSI because style changes can split the word in the raw stream. |
| No-daemon foreground application | A real native Python application retains its PID, alternate screen and contents across UI SIGKILL and reattachment. ANSI captures before/after also match tmux. |
| Application terminal modes | Up is `ESC O A`; paste is exactly bracketed once; cursor restore, resize to 61×17, one CPR reply (`ESC[4;15R`) and return to the main screen match tmux before/after recovery. |
| Tiny PTY geometry | Actual native sizes match pane formats at client sizes 60×4, 60×2, 60×1, 1×1 and restored 80×24. Initial capture mismatch is fixed below. |

## Findings fixed in this pass

### M1. Unknown 256-colour terminals regressed to assumed RGB

With `TERM=xterm-256color`, no COLORTERM/TERM_PROGRAM and no terminal replies,
emit `ESC[38;2;255;128;0mRGB`. The candidate's raw output contains
`ESC[38;2;255;128;0mRGB`; tmux emits `ESC[38;5;208mRGB`.

The asynchronous startup change no longer marks a terminal answered merely
because a blocking query times out. `colours_for` still treated the unanswered
state as evidence of truecolour support, so an unknown terminal stayed in the
24-bit path indefinitely.

**Fix:** unknown `256color` entries stay at 256 colours until a recognized
terminal reply, known terminal name, COLORTERM or explicit feature/override
establishes RGB support. The fixed raw replay uses indexed 208 in both tools;
the native pane capture correctly retains the application's original RGB.
Assertions cover unknown xterm/screen entries and existing explicit RGB cases.

### L1. The native 1×1 PTY still had a 2×2 emulator

Run an application that records `os.get_terminal_size(0)` on SIGWINCH, clears
the screen, writes `TOP` at its top and `BOTTOM>` at the last native row.
Resize the client through the sizes below. At the initial candidate, actual
PTY dimensions are correct but `Pane::new`, `resize_local` and `keyframe`
still clamp the emulated grid to two rows/columns.

| Client size | Actual PTY | Initial hn capture | tmux and fixed hn capture |
| --- | --- | --- | --- |
| 60×2, status on | 60×1 | `BOTTOM>\n\n` | `BOTTOM>\n` |
| 60×1, status on | 60×1 | `BOTTOM>\n\n` | `BOTTOM>\n` |
| 1×1 | 1×1 | `OM\n>\n` | `>\n` |

**Fix:** use exact nonzero dimensions in the emulator too. One-column wide
input clips as tmux does. A small marked Alacritty reflow patch prevents a
wide glyph from moving forever between one-cell rows and restores its spacer
when the grid grows. The vendor README records the patch.

The fixed replay matches all five tiny captures. Additional real-PTY checks
cover CJK, CJK followed by ASCII, VS16, skin tone, family ZWJ, shrink/grow and
1×1 UI crash/reattachment. At this clipped one-column margin, tmux itself
captures `🏽` for `👍🏽` and `👧` for `👨‍👩‍👧`; hn matches those results. At
ordinary widths the complete clusters remain intact. A release unit test
covers one-cell dimensions, wide input, shrink/grow and snapshot restoration.

## Rapid Escape check

Back-to-back PTY writes of Escape then C-b plus a bound key can be interpreted
as an Alt chord by both tmux and the initial hn candidate. With a deliberate
delay both dispatch the binding. That coalesced-input comparison alone is
therefore not evidence of a new tmux mismatch. The coordinator independently
found and fixed the separate-read regression through the full E2E flow;
this reviewer does not claim to have independently validated that entire flow.

## Reproduction evidence and limits

Private drivers and raw/ANSI captures are preserved in
`/tmp/hnr20fe-5qfkoumx/` for the initial candidate and
`/tmp/hnr20fe-fix-zhrgeyyn/` for the frozen fixed copy. The executable scripts
are `review.py`, `typeahead.py`, `startandstyle.py`, `tiny.py`, `attributes.py`,
`modes.py`, `mockfeel.py` and `wide-runtime.py` (the last is in the fixed
copy). Each imports the guarded `review.py` setup and cleans up in `finally`.
Run them sequentially; they intentionally share a private test environment.
For the mock scenario set `FE_PORT=19531`; other scenarios default to 19530.

The complete release unit suite passed 122 tests after these changes; the
expanded one-cell regression also passes. This reviewer did not rerun the
full repository E2E or Linux x64/ARM jobs; those belong to the coordinator's
final combined gates. Physical terminal font rendering and every shell,
notification, picker and copy-mode path were outside this bounded recheck.

Final process/listener checks found no owned hn UI, headless holder, PTY
supervisor, application, mock daemon or named tmux server remaining, and no
listener on the ports used by this review.
