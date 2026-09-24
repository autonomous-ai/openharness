# Keyboard

Every action has a key or a palette entry, and every key can be remapped.

The defaults, in the workspace:

| Keys | Action |
|---|---|
| ⌘T | New Tab — opens the same quiet welcome page shown at startup. Use ⌘N to create a harness, ⌘P to open one, or ⌘S for the store |
| ⌘P / Ctrl+P (Linux) | Open Harness — the unified picker for harnesses, machines (`@`), projects (`#`), models (`:`), and Store (`*`). Opens in the current tab and tiles its panes, or focuses the harness if already here |
| ⇧⌘P / Ctrl+Shift+P (Linux) | Search commands; from a selected picker result, search actions for that item |
| ⌘R / ⌘D | Split right / down — open the New Pane picker with the requested direction, then choose an existing harness or create one |
| ⌘N | New Harness directly — the box opens on the task: type what it should do and press Return, and it starts as another of the pane you were in (labeled agent, machine, project, and mode defaults stay visible above `task >`). Tab and ⇧Tab step out to those answers; each is a list you filter by typing, with a ✓ on the current one. One verb per field: in a list Return **chooses** and comes back to the task, on the task Return **makes it**, and ⌘↵ makes it from anywhere with the highlighted row. In the project field a word names a new project, `owner/repo` clones it, a path completes the way zsh's does (Tab: common prefix, then walk the candidates, ⇧Tab back; `/` goes in) and Browse… opens the folder chooser. ⌥↵ breaks the line in the task; ⌥1–⌥9 pick a row; ⌘. opens the full form. Escape keeps what you typed for the next ⌘N |
| ⌘B | Boss mode: describe a task, it picks the agent |
| ⌘W · ⇧⌘R | Close tab · rename tab |
| ⇧⌘T | New terminal in the current project |
| ⇧⌘N | Clone Harness — another harness like the focused pane's (same machine, project, harness, Codex profile, permission mode, named agent) with a fresh conversation. No dialog; fork minus the context |
| ⇧⌘E | Restart Harness — the focused pane's harness starts again in place, resuming its conversation where the engine can. Asks first; the pane, its folder and its settings stay. (Not ⇧⌘R: that renames the tab) |
| ⌘1 … ⌘9 | Select tab by position |
| ⇧⌘] · ⇧⌘[ · ⌃Tab · ⌃⇧Tab | Next · previous tab |
| ⌘] · ⌘[ · ⌘Y | Forward · back through visited agents · full history |
| ⌘H ⌘J ⌘K ⌘L · ⌘arrows | Focus the pane left · below · above · right |
| ⇧⌘arrows | Move the focused pane |
| ⌘⏎ · ⌘; · ⇧⌘W | Zoom or restore · last pane · close pane |
| ⌘S | Harness Store |
| ⌘M | Machines — connect another computer or set this computer's password |
| ⌘I | Models — subscriptions, local models, shared models, and APIs |
| ⇧⌘L | Layout palette |
| ⌘F · ⌘G · ⇧⌘G | Find in terminal · next · previous match |
| ⇧⌘I | Agents needing input |
| ⌘, · ⌘/ | Settings · keyboard shortcuts |

New Tab starts with three clickable shortcuts: ⌘N to start your first harness,
⌘M to manage it from another computer, and ⌘I to power it with a local model.
Checkmarks record actual use and persist per account on this device. After all
three are complete, the next New Tab shows the everyday ⌘N, ⌘P, and ⌘S shortcuts.

In the harness picker, New agent is selected when the query is empty. Typing selects the best matching existing harness; the creation row stays pinned above it and carries the query into the first task. Projects and machines filter individual harnesses rather than opening whole groups. The destination is shown in the picker and carried into creation. A harness can have views in several tabs, with one view per tab; closing a pane only removes that view.

Hover near a pane’s right or bottom edge to reveal its **+** button, or use **File → Split Right… / Split Down…**. The picker shows **New Pane to the Right** or **New Pane Below**. The split is applied after choosing or creating a harness; Escape leaves the layout unchanged.

When a split needs more room, the workspace expands and scrolls to keep both panes readable. Keyboard focus brings the selected pane into view. Splitting remains available up to the tab’s 64-pane limit.

In a picker: ↓ ⌃N ⌃J and ↑ ⌃P ⌃K move, and ⏎ opens. In the unified picker, Return opens the highlighted harness; a paused harness resumes and opens. Machines and projects open their session lists inside the picker. Model management opens the existing Model Manager terminal; API connections open the existing edit dialog. Cmd-Shift-P (Ctrl-Shift-P on Linux) searches named actions for the selected item. Commands name their target, and cancelling or completing an action returns to the same search. Filters and sorting are explicit commands. The preview has no action strip or keyboard footer. Existing remappable Ctrl-S lifecycle shortcuts remain available. Escape returns from a scoped list or closes the picker. ⌘⏎ accepts into the same requested destination. ⌃/ toggles the preview and Page Up/Down scroll it without leaving the search input.
The terminal keeps ⌘C, ⌘V, ⌘A, Esc, ⌥⏎ and ⌃C for itself. `pane.pin`, `pane.focus_1…9`,
`pane.resize`, `pane.reset_sizes`, `machine.link` and a few others ship unbound and are in the palette.

Remap anything in `~/.config/harness/keybindings.jsonc` (`$XDG_CONFIG_HOME` respected). The file is
JSONC: `{ "version": 1, "bindings": [{ "keys": "cmd+k cmd+l", "command": "pane.focus_right",
"when": "workspace" }] }`. Sequences are one to four strokes; `"command": null` unbinds a key or a
whole prefix; `when` is `workspace`, `terminal` or `picker`. The file is watched and reloaded on save;
a bad edit keeps the last good keymap and says what was wrong. **Keyboard shortcuts (⌘/)** lists the
effective bindings in searchable groups. Select a row and press Return to practice it without
executing the action. The popup follows Customize Harness ▸ Terminal for its font and size.
**Edit keyboard shortcuts** opens a commented config template with every command id.

In both modes of the box the line is a readline: ⌃A ⌃E ⌃F ⌃B and ⌥←/→ move, ⌃W kills a word (stopping at `/`), ⌃U kills to the start, ⌃H and ⌃D delete a character each way, ⌃Y puts the last kill back. ⌃N/⌃J and ⌃P/⌃K move the highlight — ⌃K is "previous", as in fzf, not kill-line — ⌃M is Return and ⌃[ or ⌃G is Escape. Every entry of the box's bottom line is also a button.
