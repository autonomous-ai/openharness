# Keyboard

Use **Swarm** for a workspace group and **Harness** for a running agent session.
See [product terminology](terminology.md).

Every action has a key or a palette entry, and every key can be remapped.

The defaults, in the workspace:

| Keys | Action |
|---|---|
| ⌘T | New Swarm — opens the same quiet welcome page shown at startup. Use ⌘N to create a harness, ⌘P to open one, or ⌘S for the store |
| ⌘O / Ctrl+O (Linux) | Open Project — the unified picker starts in projects (`#`), with projects containing open panes first and alphabetical order within each group |
| ⌘P / Ctrl+P (Linux) | Open Harness — the unified picker for harnesses, machines (`@`), projects (`#`), agents (`&`), models (`:`), and Store (`*`). Opens in the current tab and tiles its panes, or focuses the harness if already here |
| ⇧⌘P / Ctrl+Shift+P (Linux) | Search commands; from a selected picker result, search actions for that item |
| ⌘R / ⌘D | Split right / down — open the New Pane picker with the requested direction, then choose an existing harness or create one |
| ⌘N | New Harness — choose an Agent or Harness, Project, and Options, then activate New Harness. Lists filter as you type; Return chooses and Escape returns to the form. Project accepts a folder, a new project name, or a repository. Options include model, permissions, agent profile, branch, and worktree |
| ⌘B | Boss mode: describe a task, it picks the harness |
| ⌘W · ⇧⌘R | Close swarm · rename swarm |
| ⇧⌘T | New terminal in the current project |
| ⇧⌘N | Clone Harness — another harness like the focused pane's (same machine, project, harness, Codex profile, permission mode, named agent) with a fresh conversation. No dialog; fork minus the context |
| ⇧⌘E | Restart Harness — the focused pane's harness starts again in place, resuming its conversation where the engine can. Asks first; the pane, its folder and its settings stay. (Not ⇧⌘R: that renames the swarm) |
| ⌘1 … ⌘9 | Select swarm by position |
| ⇧⌘] · ⇧⌘[ · ⌃Tab · ⌃⇧Tab | Next · previous swarm |
| ⌘] · ⌘[ · ⌘Y | Forward · back through visited harnesses · full history |
| ⌘H ⌘J ⌘K ⌘L · ⌘arrows | Focus the pane left · below · above · right |
| ⇧⌘arrows | Move the focused pane |
| ⌘⏎ · ⌘; · ⇧⌘W | Zoom or restore · last pane · close pane |
| ⌘S | Harness Store |
| ⌘M | Machines — connect another computer or set this computer's password |
| ⌘I | Models — subscriptions, local models, shared models, and APIs |
| ⇧⌘L | Layout palette |
| ⌘F · ⌘G · ⇧⌘G | Find in terminal · next · previous match |
| ⇧⌘I | Harnesses needing input |
| ⌘, · ⌘/ | Settings · keyboard shortcuts |

First launch and every New Swarm show the same “Follow your curiosity.” page with
three clickable shortcuts: ⌘N to start a new harness, ⌘P to open a harness, and
⌘S to browse the harness store. The hints follow the current keyboard bindings.

A harness can have views in several swarms, with one view per swarm; closing a pane only removes that view.
The view closes immediately, without a minimize animation.

Cmd-P opens an empty search field. Cmd-O inserts an editable `#` for projects.
Type `&` to choose a different agent for the focused harness. The pane header's agent name opens the same picker. Switching saves the old session, keeps the project and pane in place, and passes recent requests and saved answers to agents that accept an initial message (OpenCode, Codex, Claude Code and Hermes). This is a bounded handoff, not the full original transcript; the original session remains saved.
Delete the prefix to return to harness search. These fields use a thin caret and
no separate prompt character.

Use **⌘R / ⌘D** or **File → Split Right / Split Down** to open the pane picker. The split is applied after choosing or creating a harness; Escape leaves the layout unchanged. A pane header reveals its `x` close action on hover; **⇧⌘W** closes the focused pane and **⌘W** closes the swarm.

When a split needs more room, the workspace expands and scrolls to keep both panes readable. Keyboard focus brings the selected pane into view. Splitting remains available up to the swarm’s 64-pane limit.

In a picker: ↓ ⌃N ⌃J and ↑ ⌃P ⌃K move, and ⏎ opens. In the unified picker, Return opens the highlighted harness; a paused harness resumes and opens. Machines and projects open their harness lists inside the picker. Model management opens the existing Model Manager terminal; API connections open the existing edit dialog. Cmd-Shift-P (Ctrl-Shift-P on Linux) searches named actions for the selected item. Commands name their target, and cancelling or completing an action returns to the same search. Filters and sorting are explicit commands. The preview has no action strip or keyboard footer. Existing remappable Ctrl-S lifecycle shortcuts remain available. Escape returns from a scoped list or closes the picker. ⌘⏎ accepts into the same requested destination. ⌃/ toggles the preview. Page Up/Down pages the result list; Shift-↑/↓ scrolls the preview by one line without leaving the search input. Cmd-P starts without a selected row and shows the resource type hints in the preview area. Typing selects the first match; arrows or Tab can select a row without typing. Enter does nothing until a row is selected.
Cmd-P has no New Harness row; use Cmd-N to create a harness, including when no harnesses match.
All Cmd-P results use one line each, with the name and activity age when available. Machine, project, model, API connection, and Store details appear in the preview. For harnesses, the preview shows the machine, project, and branch directly beneath the name; these fields remain searchable.
Unavailable harnesses are dimmed, with a short reason replacing the age. You can select them to read the saved preview, but Enter and click do not open them. Reconnecting the machine makes its harnesses available in the same picker.
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
