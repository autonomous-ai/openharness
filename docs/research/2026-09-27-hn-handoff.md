# hn (harness-tui) — handoff, 2026-09-27

> **Status update, 2026-09-28:** the user authorized merging PR #365. See the
> [merge verification record](2026-09-28-hn-merge-verification.md) for the current
> revisions, completed reviews, checks and limits. Release and installation remain
> separate actions. The original handoff below is preserved as dated history;
> its draft-only instruction and open-item list are not the current status.

Where the "make hn a 10/10 terminal-native tool" work stands, and how to carry on.

## The goal (the user's words, short)

A developer SSHes to a server, runs `hn`, and feels at home as with tmux: tmux's keys (C-b …),
commands, formats and config exactly; every list feels exactly like fzf (keys, fuzzy search,
preview); the focus bar at the bottom (tmux's status line); every cell and colour right. Keep a
panel of AI reviewers (terminal nerds) using it, fix what they find, repeat.

## Where the code is

- Branch `ship-hn`, PR #365 (draft — keep it draft; never merge or release without the user's
  explicit "go"). Everything is committed and pushed; last commit `2b3a04af`.
- `tui/` is hn (Rust, ratatui, a tmux 3.5a clone over the Harness daemon); `cli/` the daemon.
- Release, only on "go": merge #365, `make release-cli`, the `release-tui.yml` workflow, then a
  fresh-machine check.

## Build and test

```
cd tui
cargo build --release --offline            # target/release/harness-tui
cargo test --release --offline             # 98 tests
E2E_PORT=19297 HN_SOCKET_NAME=e2et bash tests/e2e.sh
```

The mock daemon is `tui/tests/mock-daemon.mjs <port>` (`MOCK_DEMO=1` a demo fleet; `/test/dial`,
`/test/finish`, `/test/emit` test hooks; session_search, session_tail, external conversations).
Real references to compare with: tmux 3.5a, fzf 0.67.

## Safety rules for every test (non-negotiable)

The user's real hn and daemon run on the same machine.
- Every hn call: `-L <your prefix>…`, `--port <mock port>`, `PORT=<mock port>`,
  `HOME=<throwaway dir>`, `HN_SOCKET_NAME=<your prefix>`; `unset TMUX TMUX_PANE HN_SOCKET`.
- Never the default socket, never ports 18473 or 18907, never the default tmux server (always
  `tmux -L <prefix>…`), never type into real harnesses.
- Give each helper a guard that refuses a port outside its range.
- Kill your headless hn (`pkill -f -- "-L <prefix>.* --headless"`), mocks and tmux servers when
  done; don't overwrite a running binary in place (rm, then cp).
- No private paths or real user names in anything committed to this public repo.

## How the review rounds work

Each round freezes a binary copy, a commit id and a one-line-per-commit change list, then runs
four reviewers in parallel, each with its own socket prefix and port range, comparing hn with the
real tool side by side (capture-pane -e through an outer tmux, cell by cell; raw bytes through a
pty):
- tmux purist, fzf purist, agents (someone running many Claude/Codex sessions), terminal feel.
- Each writes a report: score, the previous round's findings re-checked, new findings by severity
  with exact repros, what feels right.
- Fix, re-run their repro scripts against the new build, commit, then the next round.

Round 18 scores (on the build before the fixes below): tmux 7.5, fzf 8.5, agents 7.5, feel 7.5.

## Done since round 18's build (all compared with tmux/fzf where it applies)

- Hooks: `if-shell` in a hook keeps the hook's harness (was the Critical); after- hooks are about
  the command's target (new window/pane, `-t`'s session); `session-closed` everywhere tmux fires it.
- tmux habits: prefix twice follows the prefix table; `new -d … \; attach` attaches;
  `resize-pane -Z -t` elsewhere zooms in place; `display -d`, `display-time 0`; `[tmux]` window
  names at once; a script's `list-keys` hides hn's own keys so plugins (tmux-sensible) bind them;
  a targetless command from a shell goes to the terminal used last.
- `C-b c` home page is type-ahead safe (typing starts a shell with your keys); under
  `@hn-look tmux`, or with commands chained after `new-window`, it is a shell.
- Themes: `#{current_file}`, `set -ogq`, `set -ag` on styles; `#()` jobs stream lines, keep the
  last, are killed on exit (catppuccin v2, Dracula, Oh my tmux!).
- Colour: asks the terminal what it is (XDA + DA1) at start, as tmux does.
- fzf: section colour slots, ANSI labels/footer/separator, preview border from `--style`, lists at
  any size (no crash to 1x1); C-b s: typing goes to the best match; search sends only positive
  terms, honours `!x`, ranks conversation hits above scattered matches, no blinking.
- Agents: new-harness from scripts (rc 0, -d, -P, task), failed turns say failed, preview keeps
  failure/plan/facts and long answers' ends, one harness-needs per question across detach, hooks
  run on the attached terminal, a full server with no terminal, burst questions one bell, a typed
  answer to a closed question kept as a message.

## Still open (by reviewer)

tmux (round-18 report):
- M5: grouping with a session another terminal owns is refused; that session's group formats,
  `#{session_stack}`, `#{session_alerts}` and attach counts are wrong from the other terminal.
- M6: no hn process remains after the last `C-b d`, so tmux-sessionizer's "is a server running"
  check misfires on its second run (`duplicate session`).
- `send-keys -K` case: a window typed as `viaK` came out `viak`.
- The 31 Lows in its report (e.g. `prefix-timeout`, `message-line` accepted but ignored, the marked
  pane lost on detach).

fzf:
- Rows found by what was said show no lit cells in the list itself.
- `?` help: keys drawn in the match colour; `?C-b z` finds nothing (keys not searchable).
- Lows: hiding the input leaves its box; `--info-command` partial; `--*-label-pos` ignored; jump
  edge cases; mouse marking with `--multi`; NFD/Thai hscroll; the separator one column short with
  `--list-border` + `--header-border`; clicks on the list border select a row; `--black`/`--raw`;
  no spinner while machines are searched; ANSI prompt attributes over `--color=prompt`.

Agents:
- Enter on a conversation open elsewhere does nothing visible (say why).
- Keys typed while a machine's link is down are dropped silently.
- The home page is a zero-pane window scripts don't expect, and `C-b d` drops it.
- A resumed conversation runs with permissions bypassed (as the desktop does); say so in its
  preview.
- The `M-N` guard's wording on a list just opened ("changed" where it only appeared).
- Home page order follows the desktop (activity), as the user asked; clip names in the middle so
  "(3)" survives.

Feel:
- Emoji width: ⚠️ ✔️ (VS16) drawn one cell where tmux draws two; skin tones and ZWJ families
  split. This is in the pane emulator (alacritty_terminal), not the drawing.
- No daemon: a splash and no shell; `new-window -d` fails yet adds a window.
- Lows: a one-row pane's title row draws `┬`; ~49 bytes per echoed key; no host name on screen by
  default; spinners at 4 fps; a hung daemon shows nothing.

Known and accepted for now: a link-window across two terminals' sessions; after `new-window -a` in
a grouped session the other session's current window stays where it was (tmux keeps it by index).

## Branch `hn-polish` (after the handoff)

A few more fixes landed on `hn-polish`, branched from `ship-hn` at the handoff commit; it is a
fast-forward of `ship-hn` (merge it there first):
- `new-window` with no daemon says so and makes no window.
- A window one row tall shows its pane, with no title row over it.
- Keys typed while a machine's link is down are kept and sent when it is back.
- The answer guard says "Read the question first" on a list just opened.
- A conversation's preview says it resumes without permission prompts.
- The `?` help list: keys searchable (`?C-b z`), ranked by score, not pre-lit.
- C-b s rows found by what was said show the matched snippet as their detail (lit by fzf).

Tests: 98 unit tests and the end-to-end tests pass. (A fresh worktree needs `cli/node_modules`
for the mock daemon; a symlink to another worktree's is enough.)

## Suggested next steps

1. Fix the items above, re-running the matching reviewer repros.
2. Run round 19 with four fresh reviewers on a frozen build (new socket prefixes and port ranges).
3. Only on the user's "go": merge PR #365 and release.
