# Command dock placement — simulated developer panel

The user requested AI reviewers roleplaying world-class developers immersed in
terminal work. These are fictional expert archetypes expressing design opinions.
They do not represent named developers. No human outreach is requested.

The user accepted the compact bottom-dock direction. The worktree now implements
it, alongside a compact tab bar and permanent Harness Store entrance.

## The panel

| Fictional reviewer | Dock | Internal ordering | Main concern |
| --- | --- | --- | --- |
| Unix/tmux veteran | Bottom | Input first, selected match immediately below | Keep pane identities visible and command mode compact. |
| Vim/fzf power user | Bottom | Anchored bottom input, best match immediately above, other matches extending upward | Keep the query next to what Enter will activate. |
| Terminal UI maintainer | Top, below tabs | Input first, matches immediately below | Make the application-wide prompt's ownership clear and preserve recent output where possible. |

The Unix/tmux reviewer wants about six content rows, stable height while
filtering, preview alongside the list, and the same location for search,
commands and creation. They reject the current tall bottom panel.

The Vim/fzf reviewer wants input anchored at the bottom, spatially consistent
arrow navigation, and preview beside results or above the result list on narrow
windows. Preview must never separate the query from its best match.

The terminal UI maintainer distinguishes a workspace prompt from the shell
prompt belonging to a particular pane. They prefer top with a roughly 40%
height ceiling, explicit captured action targets and internally scrolling
content. They acknowledge that top can obscure upper-pane identity or input.

## Where they agree

The current layout puts matches at the top of the result area and input at the
bottom. With preview enabled and few matches, a large blank gap separates the
query from selection. Narrow layouts put preview between them. This is an
internal layout problem that either dock edge can avoid.

The dock should remain shallow, keep input stable, identify machine and
destination, preserve the selected agent during updates, and return focus to
the exact originating pane on Escape. Neither edge inherently preserves useful
context in every four-pane arrangement.

## Implemented direction

Favor the bottom dock with an anchored query and best match immediately above
it. Grow remaining results upward; keep preview beside them when wide and above
them when narrow. Keep the shared destination/default context and key hints
compact. Results or preview scroll internally rather than expanding into a
large panel by default. Search and creation retain one spatial anchor.

This recommendation follows the product's terminal-first goal and addresses
the observed input/result gap. It is not established by counting reviewers.
Top remains a coherent alternative if workspace-wide scope is given priority.

The best match is at the bottom, directly above the query, with six visible
result rows at ordinary sizes. Up/Ctrl-P/Ctrl-K move away from the prompt;
Down/Ctrl-N/Ctrl-J move toward it. Docked lists stop at their ends. Page keys
scroll the preview when shown and move spatially through results otherwise.
The empty New agent row needs no redundant preview; selecting a real result
shows preview by default. Narrow windows put it above the list.

New Pane names its captured destination tab. Preview toggles and changing
Enter labels reserve their footer widths so filtering does not move the input.
Creation choices use the same ordering; multiline task arrows still edit text.
The compact native toolbar measures 40pt instead of 52pt on this Mac, and the
Flutter fallback uses the same height.

## Reference behavior checked earlier

fzf separates popup placement from internal layout. Its manual supports
bottom-up, top-down and top-down-with-bottom-prompt layouts. Its README includes
a bottom popup with top-down internal layout. [Manual](https://github.com/junegunn/fzf/blob/master/man/man1/fzf.1),
[README](https://github.com/junegunn/fzf#display-modes).

Telescope separately configures prompt position and the direction toward which
better matches sort. Its documented bottom-pane layout places the prompt at
the top. [Documentation](https://github.com/nvim-telescope/telescope.nvim/blob/master/doc/telescope.txt).

tmux's command prompt replaces its status line; its tree mode uses a different
selection-and-preview arrangement. [Command prompt](https://github.com/tmux/tmux/wiki/Getting-Started#the-command-prompt),
[tree mode](https://github.com/tmux/tmux/wiki/Getting-Started#choosing-sessions-windows-and-panes).
