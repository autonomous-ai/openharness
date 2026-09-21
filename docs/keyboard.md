# Keyboard

Every action has a key or a palette entry, and every key can be remapped.

The defaults, in the workspace:

| Keys | Action |
|---|---|
| ⌘T | New Tab — choose an existing harness or select the pinned New agent row. The tab is allocated only after selection or successful creation; Escape leaves the layout unchanged |
| ⌘P | New Pane — the same picker, adding to the current tab and automatically tiling its panes. Search by harness name, project, machine, or session content. Selecting a harness already here focuses its pane |
| ⌘R / ⌘D | Split right / down — open the New Pane picker with the requested direction, then choose an existing harness or create one |
| ⌘N | New Harness directly — the box opens on the task: type what it should do and press Return, and it starts as another of the pane you were in (labeled agent, machine, project, and mode defaults stay visible above `task >`). Tab and ⇧Tab step out to those answers; each is a list you filter by typing, with a ✓ on the current one. One verb per field: in a list Return **chooses** and comes back to the task, on the task Return **makes it**, and ⌘↵ makes it from anywhere with the highlighted row. In the project field a word names a new project, `owner/repo` clones it, a path completes the way zsh's does (Tab: common prefix, then walk the candidates, ⇧Tab back; `/` goes in) and Browse… opens the folder chooser. ⌥↵ breaks the line in the task; ⌥1–⌥9 pick a row; ⌘. opens the full form. Escape keeps what you typed for the next ⌘N |
| ⇧⌘P | Command palette — a `:` prompt with an empty input; includes the orchestrator, directional splits, and settings. Recent commands appear first; typing `usage` opens Settings ▸ Usage |
| ⌘B | Boss mode: describe a task, it picks the agent |
| ⌘W · ⇧⌘R | Close tab · rename tab |
| ⇧⌘T | New terminal in the current project |
| ⇧⌘N | Clone Agent — another agent like the focused pane's (same machine, project, harness, Codex profile, permission mode, named agent) with a fresh conversation. No dialog; fork minus the context |
| ⌘1 … ⌘9 | Select tab by position |
| ⇧⌘] · ⇧⌘[ · ⌃Tab · ⌃⇧Tab | Next · previous tab |
| ⌘] · ⌘[ · ⌘Y | Forward · back through visited agents · full history |
| ⌘H ⌘J ⌘K ⌘L · ⌘arrows | Focus the pane left · below · above · right |
| ⇧⌘arrows | Move the focused pane |
| ⌘⏎ · ⌘; · ⇧⌘W | Zoom or restore · last pane · close pane |
| ⌘S | Layout palette |
| ⌘F · ⌘G · ⇧⌘G | Find in terminal · next · previous match |
| ⇧⌘I | Agents needing input |
| ⌘, · ⌘/ | Settings · keyboard shortcuts |

In the New Tab and New Pane pickers, New agent is selected when the query is empty. Typing selects the best matching existing harness; the creation row stays pinned above it and carries the query into the first task. Projects and machines filter individual harnesses rather than opening whole groups. The destination is shown in the picker and carried into creation. A harness can have views in several tabs, with one view per tab; closing a pane only removes that view.

Hover near a pane’s right or bottom edge to reveal its **+** button, or use **File → Split Right… / Split Down…**. The picker shows **New Pane to the Right** or **New Pane Below**. The split is applied after choosing or creating a harness; Escape leaves the layout unchanged.

When a split needs more room, the workspace expands and scrolls to keep both panes readable. Keyboard focus brings the selected pane into view. Splitting remains available up to the tab’s 64-pane limit.

In a picker: ↓ ⌃N ⌃J and ↑ ⌃P ⌃K move, ⏎ accepts, and Esc, ⌃C, or ⌃G closes. In the New Tab and New Pane pickers, ⌘⏎ accepts into the same requested destination. Preview starts hidden; ⌃/ toggles it and Page Up/Down scroll it without leaving the search input.
The terminal keeps ⌘C, ⌘V, ⌘A, Esc, ⌥⏎ and ⌃C for itself. `pane.pin`, `pane.focus_1…9`,
`pane.resize`, `pane.reset_sizes`, `machine.link` and a few others ship unbound and are in the palette.

Remap anything in `~/.config/harness/keybindings.jsonc` (`$XDG_CONFIG_HOME` respected). The file is
JSONC: `{ "version": 1, "bindings": [{ "keys": "cmd+k cmd+l", "command": "pane.focus_right",
"when": "workspace" }] }`. Sequences are one to four strokes; `"command": null` unbinds a key or a
whole prefix; `when` is `workspace`, `terminal` or `picker`. The file is watched and reloaded on save;
a bad edit keeps the last good keymap and says what was wrong. **Keyboard shortcuts (⌘/)** lists the
effective bindings and **Open keyboard config** writes a commented template with every command id.

In both modes of the box the line is a readline: ⌃A ⌃E ⌃F ⌃B and ⌥←/→ move, ⌃W kills a word (stopping at `/`), ⌃U kills to the start, ⌃H and ⌃D delete a character each way, ⌃Y puts the last kill back. ⌃N/⌃J and ⌃P/⌃K move the highlight — ⌃K is "previous", as in fzf, not kill-line — ⌃M is Return and ⌃[ or ⌃G is Escape. Every entry of the box's bottom line is also a button.
