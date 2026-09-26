# hn — tmux improved

vim is vi improved: every vi key works, and what vi users wished for is there. hn is the same
move on tmux. Every tmux key and `~/.tmux.conf` line works; what tmux users have asked for over
eighteen years is fixed; and what only a multiplexer of AI agents across machines can do is added.

The rule: **never move a key, fix the defaults invisibly.**

## What tmux users have wished for, and what hn does

| # | Wish (evidence) | hn |
|---|---|---|
| 1 | Discoverability: the prefix table must be memorised ([zellij praise](https://news.ycombinator.com/item?id=27315800), [tmux-which-key](https://github.com/alexwforsythe/tmux-which-key)) | After the prefix, a pause shows the keys you can press next — built from the live table, your binds included |
| 2 | Clipboard: OSC 52, `set-clipboard`, nesting ([wiki](https://github.com/tmux/tmux/wiki/Clipboard)) | Copy lands on the clipboard of the device you are at (OSC 52), over SSH, no config |
| 3 | A mouse copy kicks you out of copy mode ([#140](https://github.com/tmux/tmux/issues/140)) | Copying keeps copy mode and the scroll position |
| 4 | The wheel and scrollback ([#3705](https://github.com/tmux/tmux/issues/3705), [mighty-scroll](https://github.com/noscript/tmux-mighty-scroll)) | The wheel scrolls history and leaves at the bottom by itself |
| 5 | Mouse is all-or-nothing ([FAQ](https://github.com/tmux/tmux/wiki/FAQ)) | Shift-drag is always the terminal's own selection |
| 6 | Reflow mangles prompts ([#516](https://github.com/tmux/tmux/issues/516)) | Each client sees its own size; nobody's resize reflows another's |
| 7 | True colour / TERM / italics ([#34](https://github.com/tmux/tmux/issues/34), [#1246](https://github.com/tmux/tmux/issues/1246)) | Colours pass through as the program sent them; no terminal-overrides |
| 8 | Nested tmux over SSH ([toggle hacks](https://github.com/Dave-Elec/tmux-toggle-prefix)) | Other machines are in the same list: nothing to nest |
| 9 | Config breaks across versions ([#1769](https://github.com/tmux/tmux/issues/1769)) | Unknown lines are skipped with a note, never fatal |
| 11 | Persistence needs resurrect/continuum | The daemon keeps every agent running; reopen anywhere |
| 12 | Session sprawl; choose-tree is weak ([sessionizer](https://github.com/ThePrimeagen/tmux-sessionizer)) | `C-b s` is an fzf list with previews across every machine |
| 13 | Extended keys, Shift+Enter ([#2705](https://github.com/tmux/tmux/issues/2705), [claude-code #26629](https://github.com/anthropics/claude-code/issues/26629)) | Kitty keyboard protocol outside; Shift+Enter reaches the agent |
| 14 | Flicker ([claude-code #37283](https://github.com/anthropics/claude-code/issues/37283)) | Synchronized output (DEC 2026) on every frame |
| 17 | Emoji/Unicode width ([#647](https://github.com/tmux/tmux/issues/647)) | Display widths everywhere hn draws |
| 19 | Popups and floating panes ([#1842](https://github.com/tmux/tmux/issues/1842)) | fzf lists float over the window |
| 20 | Moving panes between windows | `join-pane -t :N`, `break-pane`, `swap-window` |
| 21 | Clients of different sizes shrink everyone | Each client has its own size and its own current window |
| 22 | tmux from a phone | The phone app; no prefix to type |
| 25 | Help for commands ([#5406](https://github.com/tmux/tmux/issues/5406)) | `:` completes every command, `C-b ?` searches keys |

## Defaults

| Setting | hn |
|---|---|
| `escape-time 0` | yes — no delay after Esc |
| `history-limit` | large |
| `mouse on` | yes, unless your tmux.conf says off; Shift-drag selects natively |
| `focus-events`, clipboard, RGB, extended keys | on, invisibly |
| `renumber-windows` | no — tmux's fixed indexes |
| `base-index` | 0, as tmux; your tmux.conf decides |
| prefix | `C-b`, as tmux; your tmux.conf decides |
| `\|` and `-` | extra split keys beside `%` and `"` |
| vim-tmux-navigator | only if your tmux.conf binds it |

## What competitors taught

- Zellij's key hints are its most praised feature; its Ctrl modes collided with vim and shells
  and it had to add a tmux mode. → hints, never new modes.
- iTerm2's `tmux -CC`: native UI over a remote multiplexer. → the desktop app and hn share one desk.
- mosh's local echo; its lost scrollback. → predictive echo on slow links, scrollback kept.
- herdr: agent state (blocked / working / done) with C-b kept. → `!` on windows, `[waiting]` on panes.

## Only an agent multiplexer across machines

1. "Needs input" and "finished" on whatever device you are at.
2. Reconnect anywhere, independent view per client.
3. One tree across every machine.
4. Agents that resume their conversation, not just a shell.
5. Search every agent's history.
6. Idle agents parked and woken.
7. Clipboard across devices.
8. Sharing one agent pane, read-only or not.
9. Agents that open panes and route work themselves.
10. Terminal protocols that agent TUIs need, passed through out of the box.

Research: 2026-09-25, from tmux's issues, FAQ and wiki, Hacker News, r/tmux, and the zellij,
WezTerm, kitty, iTerm2, mosh, tmate and herdr projects.
