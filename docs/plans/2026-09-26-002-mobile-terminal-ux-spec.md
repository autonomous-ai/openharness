# Mobile: the terminal-native UX spec (the room, round 1)

September 26, 2026. Four expert seats reviewed renders of the phone app — a mobile UI/UX designer
(the Jony Ive seat), a terminal/TUI purist (the Woz seat, checking against real tmux 3.5a, fzf 0.67
and zsh), a visual designer, and a heavy Claude Code/Codex user — each scored it 6/10, then argued
the conflicts; a product lead (the Jobs seat) made the calls. Owner decisions that stand: full-screen
terminal, the floating mic, Snapchat swipes (right = Find, left = New), voice first. Owner calls on
the two open questions: the terminal ends at the bottom bar (the home-indicator strip stays plain),
and the mic floats clear of the bar (centre ~96pt from the bottom).

## Owner override (after Batch 1)
No status bar. The owner rejected the tmux window list at the foot: it costs the terminal two rows
all day and lists agents nobody needs listed. Agents are vim buffers — one on screen, the rest a
search away (Find). In its place: the title at the top (agent name; `machine:folder` and branch;
`N!` for agents elsewhere asking; `…`), shown at the end of the output and slid away while reading
back. The foot is the terminal's; answer keys, the recording row and the echo are vim's last line,
laid over the bottom rows only while they have something to say. The mic stays centred 4R above
the home strip; prompt mode lifts the terminal 6R. Where the sections below say "the bar", read
"the command line" for those three modes; the window list, flags and `esc` are gone.

## Units
SF Mono 13pt; cell C ≈ 7.8pt, row R ≈ 15.6pt (line height 1.2, the terminal's). Column n at
x = 10 + n·C; ~47 columns; nothing past the last whole cell. Gutter: col 0 = `▌` cursor, col 1 =
mark, text from col 2. A tappable row is ceil(44/R) rows (3R); a read-only line 2R. Every tap target
is grown to ≥ 44pt high and ≥ 6 cells wide; the selection ground shows on the visible part only.

## Colour roles
green: tmux bar, fzf matches, `*` current, ` ⏎ run `. yellow: asking (`!`, the prompt bar,
`asking`), counts (`3/3`, `+N!`), the scroll-back position. cyan: tappable actions on the dark ground.
red: recording, errors, stop. blue: prompts (`>`, `M2%`). faint (#878787): secondary text.
brightBlack: rules and frames. Selection: `▌` + text at 12% behind the row + bold.

## Focus (from the bottom edge up)
0–34 home-indicator strip, plain (only the bar's tap slop reaches in). 34–65.2 the status line, 2R,
tmux green. 65.2–127.6 the mic band: a 56pt disc centred at 96.4pt, 64pt hit circle, floating over
the terminal; filled when it is your turn, a 2pt ring while the agent works. Above the bar: the
terminal, a whole number of rows, leftover space at the top.

Status line: `[M2] hn*# api-fix@mini! docs~    +1!  esc  …` — `[M2]` opens Find; windows are the
current agent, pinned asking agents, the last, then recents; each wears `*`/`-` and one flag,
`!` asking (whole word black on yellow) > `#` working > `~` done and unread; `@mini` only for another
machine; no window numbers; `+N!` for asking agents that do not fit; `esc` only while the current
agent works (sends ESC, no confirm); `…` the actions menu. Bar modes, highest first: recording,
prompt, message (2s), normal. Scroll-back: `[42/1380]` black on yellow on terminal row 0, right
aligned; a tap goes back to the end.

Recording (replaces the bar): ` ✕    ● 0:04  ▁▃▅▇▆▃▁▃▅▂          → hn` — `●` and the timer red;
`✕` cancels; the mic shows `↑` to send.

Prompt mode (a Claude/Codex dialog is open): the terminal lifts 4R so the dialog sits above the mic;
the bar turns yellow with equal answer keys ` 1 yes │ 2 always │ 3 no ` (labels from the rows,
lowercased, cut at `,`/`(`; "don't ask again"/"allow all" → `always`; >4 options → three keys +
` more `; multi-select toggles `[x]` with ` ⏎ submit `; Codex enterSubmits: digit then a chosen
Return; partly readable → `answer on screen`, no keys).

Voice: a take is bound at touch-down to the agent it started on (`→ hn`) and never retargets. With a
dialog open it never sends the paste-and-Return message: "one"/"yes"/label words press their key;
"no, …" presses 3 then sends the rest once the dialog closes; anything else shows red
`✗ no match — tap an answer` and sends nothing. The echo appears only after the send is
acknowledged: `✓ hn  fix the login te··` (2s); failure `✗ not sent  retry`.

## Find (fzf)
Rows bottom-up: asking (newest first), the last agent, the rest by last use, the current agent last;
the cursor on the first row. Name at col 2 (≤14 chars then `··`), place at col 16, state word right
aligned (`asking` yellow, `working` faint, `done 12m`, an idle age faint, `exited` red). An asking
agent gets a faint second line with the question at col 4. Rows 3R (4R with the second line);
header and info lines 2R; the prompt 3R. Typing filters without reordering; a new asking agent
re-ranks at once (after the finger lifts). The header shows only on an empty query; the query is
bold with a block cursor. `+new` → New, `esc` → Focus.

## New
Labels faint at col 2, values at col 11, rows 3R: agent, project, options, task (a voice take).
`new ──── esc` above the prompt; the prompt `M2% harness new claude @M2 ~/code/x -- "task"`
hard-wrapped by column, with a reverse-green ` ⏎ run ` at the right. Choosers use Find's layout,
open instantly with the cursor on the current value (`*`); actions (`+ new folder`, `+ open folder`,
`+ clone repo`) with a cyan `+` at the far end from the prompt.

## Menus and Settings
tmux display-menu: a brightBlack `┌─┐ ├┤` frame, centred title, rows 3R, `stop` red, opened above
the bar right-aligned to `…`; selection like fzf (not yellow); `stop` confirms in the bar
(`stop hn?  y │ n`). Settings uses New's grammar with `── terminal ──` section rules, values right
aligned, `-  13  +` words 6 cells wide.

## Motion and latency
Selection ground in the same frame as touch-down; selection haptic on a committed tap, light impact
on mic start and on the `✓` echo. Only horizontal pages move: 1:1 with the finger, settle 200ms
ease-out or cancel 160ms, no spring. Everything else is instant (bar modes, keys, the lift, menus,
choosers, re-ranking, mic states). A fling ends on a whole row. Switching agents paints the cached
screen in the first frame.

## Build order
Batch 1: line height 1.2 + faint; the bar at the bottom and the terminal in whole rows; bar grammar
and esc; mic 56/64 at 96.4 with the ring, no search orb; the recording row, no capsule; prompt mode
and the lift; voice binding, answer matching and the echo; slop and haptics.
Batch 2: fzf rows/cursor/`n/m ─`/`··`; Find order, state words, second line, header, block cursor;
New; choosers.
Batch 3: the actions menu and the bar confirm; Settings; motion timings and row-snapped scrolling;
the scroll-back position on row 0; the render fixture.
