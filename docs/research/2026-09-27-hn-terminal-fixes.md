# hn terminal rendering fixes, 2026-09-27

Baseline: `af2971ee`, frozen before editing. Reference: tmux 3.5a.

## Fixed

- The pane emulator now combines VS16, skin tones, regional indicators and ZWJ sequences using tmux's cell rules. The ANSI handler still delegates control sequences to Alacritty. VS16 is retained on output, and the following character lands at the correct column. Combining sequences work when the stream splits every UTF-8 byte.
- Soft hyphens occupy one cell, as in tmux. Emoji at the right margin preserve wrapping and cursor behavior.
- The output backend remembers the cursor after printing, including between frames. It restores changed attributes with one SGR reset and emits no reset for plain text. Synchronised updates remain enabled for multi-cell and whole-row frames; a single normal cell is flushed as one small write.

## Rechecks

All tests used throwaway homes, dedicated `hne19fix` sockets, a guarded mock port in 19440–19449, frozen binary copies and tmux servers with explicit `-L`. The mock and test servers were stopped afterward.

The same screen was emitted through hn's mock stream and a real tmux pane. It contained `⚠️`, `✔️`, `❤️`, `ℹ️`, `☀️`, `👨‍👩‍👧`, `👍🏽`, `🏳️‍🌈`, `🇬🇧`, precomposed and combining accents, and a soft hyphen, each enclosed in brackets followed by `X`.

| Check | Before | After | tmux |
| --- | --- | --- | --- |
| Cursor after `⚠️` | column 1 | column 2 | column 2 |
| VS16 in the outer terminal | removed | preserved | preserved |
| ZWJ family in the outer terminal | split, extra spaces | one cluster | one cluster |
| Skin tone in the outer terminal | extra spaces | one cluster | one cluster |
| Soft hyphen in the outer terminal | missing | preserved | preserved |
| Ten separate plain-key echo frames | 487 bytes | 10 bytes | — |

All 12 screen rows now match tmux's captured text, including surrounding brackets and the trailing marker. Individual key frames decreased from 48–50 bytes to one byte. The baseline measurement excludes a separate 60-byte status refresh; the final run disables the status line and records exactly `helloworld`, with no cursor movement, attribute reset or synchronised-update delimiter bytes.

`cargo test --release --offline`: 102 passed. Four new regression tests cover byte-split emoji, ANSI state and right-margin wrapping, plain echo output, and restoring colours before a following plain frame. `cargo build --release --offline` passed. The isolated comparison was rerun against the resulting frozen build.

## Connection follow-up

`Link::spawn` has connection and machine-selection deadlines, but no liveness deadline after selection. A WebSocket ping with a bounded pong deadline can reuse the existing closed-link path: dim the preserved screen, show the reconnect message and queue typed keys. The existing ten-second `terminal_alive` messages do not establish that the daemon is answering.

A shell when no daemon exists needs a persistent local PTY owner. Keeping a PTY only in the attached UI process would lose it when that process detaches. A local supervisor must survive detach and provide reconnection, output snapshots, resizing and lifecycle commands before this can behave like tmux.
