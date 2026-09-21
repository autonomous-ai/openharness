# Terminal experience review

Use the worktree review build at
`build/macos/Build/Products/Debug/Harness.app`, rebuilt from `lib/main.dart`.
An already running app does not acquire a new build automatically. The installed
`/Applications/Harness.app` is a separate artifact. Keys below are the macOS
defaults; any existing keybindings override them.

Try the first twelve items without a mouse. Use a scratch agent or shell for
the Fork, Restart, and Stop items. Any action without a listed shortcut is
available by name in **Cmd-Shift-P** command search.

## PR #136: JEV direct commands and Go back

Open **Cmd-Shift-J**, type each example, and press Enter:

- `Show history`, `Open settings`, or `Show me the layout options`: immediately
  open the existing control without a provider request. Escape returns to work.
- `Open <exact tab or agent title>`: switch directly when the title is unique.
  **Go back** in the completion notice restores the original view and leaves
  the destination open. Duplicate names should remain a choice.
- `Open a new tab`: open the normal existing/new-agent chooser. Escape should
  leave no extra tab and restore terminal typing.
- `Show me the Harness Store`: open or focus the Store tab.

The review build points to the already-running JEV service on port 18478.
The initial credit error stopped appearing during user review; its latest
requests return HTTP 200. The older app instance still uses the old daemon's
missing endpoint and can show 404, so use the newly opened review build.
Try `Which sessions are ready for review?`, `Take me back to the
login bug`, and `Let me know when the tests pass`. Sending a task, creating an
agent, or starting a watch must still show an explicit action card first.
Escape or Cmd-Shift-J closes the experimental prompt.

## New: creation polish and keyboard learning

- **Cmd-Shift-P → Quick start**, or Help → Quick Start. On an empty workspace,
  open an agent with Cmd-T, add a second with Cmd-P, zoom with Cmd-Enter, and
  open command search. The guide advances as work happens; it never grabs the
  caret. Existing agents/panes count toward the guide.
- Run **Pause quick start**, relaunch, then run **Quick start** again. It should
  resume where you left off. Starting a completed guide repeats it.
- **Cmd-Shift-P → Keyboard practice**, or Help → Keyboard Practice. Search for
  `New Tab`, `panes`, or `Search & creation`. Enter opens an exercise; press the
  shown key to see a simulated result. Enter continues; Escape returns to the
  list, then closes. Your actual agents and tabs stay intact.
  At large text sizes, Page Up/Down reads the explanation without a mouse.
- Practice Close Tab, Stop Agent, or Restart Agent and verify your running work
  stays put. For commands without a shortcut, type the command name in the
  exercise. Close/reopen practice to check retained progress. Existing custom
  keybindings should appear and work here too.
- In Cmd-N, edit Agent or Project with an empty task, Escape, then reopen. Those
  defaults should return. Choose a recent folder directly from Project; it
  should retain its owning machine.
  Cancel Browse and continue typing without clicking the prompt.

## Styling and Store

- Open Rename Tab and the advanced New Harness form: the workspace behind
  either should be nearly black while the form remains at full brightness.
- The top tab bar is now 40pt, down from 52pt. Check tab labels, traffic lights,
  close controls and the new Harness Store entry at normal and narrow widths.
- Open Harness Store from the far right of the bar, then again from command
  search using `install` or `browse harnesses`. It should focus one Store tab
  while the agent tabs stay intact. Close it with Cmd-W to return to work.
- In Cmd-N, select Task with arrows/Enter to draft a task, Escape, then Agent to search for an unavailable
  harness. Enter on **Browse more harnesses…** opens the Store. Return to the
  source tab and Cmd-N; the task and defaults should still be there.
- Open Cmd-P, Cmd-T, Cmd-N and Cmd-Shift-P. Each prompt should sit on the
  workspace's bottom edge. Filter, toggle preview, resize and dismiss it; the
  terminal behind it should keep its size and scroll position.
- The New Pane pill is gone from the tab bar. Try Cmd-P or File → New Pane.
- Tabs and panes have matching tighter corners; tab names use the terminal
  font. Change that font under Customize → Terminal and check the tab labels.
  The selected tab uses its background and bold label, with no underline.
  Its top corners and outward bottom joins share a subtle 3pt radius.
- Open Cmd-Shift-P, type `customize`, and press Enter. In Prompt, try Plain,
  Symbols and Powerline. Compare search rows and pane headers, then toggle
  Color, Machine, Project and Branch. Reopen customization to check retention.
- Harness names use the ASCII marker `>_` in context presets. Compare search
  and preview; Cmd-N's argument rows show plain agent names.
- Use Tab and Enter/Space to choose styles and context fields. Escape should
  return input to the original terminal. Reset prompt style should leave the
  wallpaper, palette and font choices intact.

## Search and creation

1. **New Tab — Cmd-T.** Search for an existing agent and press Enter. A new
   tab should use its name. Escape before choosing should leave no empty tab.
2. **New Pane — Cmd-P.** Choose an existing agent. It should tile into the
   current tab. Choose it again: focus should move to its existing pane.
   In the same input, try `> zoom`, `# payments`, `@ M2`, and `?`.
   Deleting the prefix returns to agents. Enter on a project/machine shows
   its agents; Escape goes back. In `?`, choose a prefix row and continue
   typing without losing focus. Cmd-Shift-P inserts `> `; deleting it also
   returns to agents, retaining the tab/pane destination.
   The input has no decorative prompt glyph; only its typed prefix appears.
   Results use a background highlight without an arrow, aligned with the input.
3. **Search quality and identity.** Search by task/name, project, machine, or
   tab. Try short, partial queries and agents with similar names. The rows
   should make the agent and machine clear without opening a preview.
4. **Search navigation.** The best match should be just above the bottom prompt.
   Up/Ctrl-P/Ctrl-K moves upward; Down/Ctrl-N/Ctrl-J moves back toward the
   prompt, with no wrapping. Ordinary j/k remain text. Selection should stay
   visible after resizing. With preview hidden, Page Up/Down page results.
5. **Preview — Ctrl-/.** It starts on for real results; New agent needs none.
   At narrow widths preview belongs above the list. Move through results and use
   Page Up/Down to read the preview. Toggle it off and continue searching, then
   toggle it back on; the query, selection and input focus should stay put.
6. **New agent.** In an empty Cmd-T or Cmd-P picker, press Enter on New agent.
   Check Agent and Project (`machine:~/path`). Enter starts directly; select
   Task with arrows/Enter to type an optional first task, then Enter.
   The result should appear in the chosen tab/pane destination.
   An empty first task is allowed.
7. **Create from a search.** Type a new task, choose the pinned New agent row,
   and verify that text becomes its proposed first task. Existing results
   should still be selected by default while searching.
8. **Edit arguments.** Use Up/Down and Enter for Agent, Machine, Project, or Task.
   Create starts highlighted, Down wraps
   to Agent, and Enter edits the highlighted row. Returning from an editor
   selects Create again. Cmd-Enter starts from any highlighted launch row.
   The footer should describe what Enter will do; the highlight is the only
   selection marker, with no `>` beside results or input labels.
   There are no letter labels or default `a/m/p/t/o` shortcuts. Up from Create
   selects Task; there is no standalone Options row. Escape returns
   to Create, preserving the draft.
   Project focuses a search input. Type a name or path to filter recent projects;
   New project, Open folder, and Clone GitHub repository stay above the input,
   in that order, with results above them. The best recent starts selected.
   Down moves from it through New, Open, and Clone. Up to nine recent rows fit;
   arrows and Page Up/Down reach the rest while the actions stay visible.
   Letters (including `n/o/g/m`) and digits type into search; there are no
   numbered shortcuts or action-letter labels. The
   list includes existing agents' folders and persisted choices on that
   machine, with the current folder first and duplicate paths collapsed. The
   actions remain visible with a long history. Arrows/Enter and clicking work
   too. Search for something with no matches: all three actions must remain,
   with Open folder selected. Choose New project with arrows/Enter and
   type `payments processing`: Create should
   preview `machine:~/harnesses/payments-processing`. Enter accepts the name;
   Enter again launches. An empty name cannot launch in the previous project.
   Choose Open folder: enter a folder path; Enter on the bottom Open folder row or
   Ctrl-O browses folders. This screen should not repeat recent projects.
   A missing match must not offer to create a new folder. Choose Clone GitHub repository: paste
   a GitHub repository URL (or `openai/codex`), check the destination, and press
   Enter to use it. The repository is cloned when the agent starts.
   Escape to launch, choose Machine, and switch to iMac: Project shows only iMac recents. Switch back
   to M2 and its previous folder returns. Machine returns to the screen where
   it was opened; Escape cancels without changing machines. Other project
   editors restore the Project search, then return to the launch menu. Tab completes text without
   committing it. Try path completion and Escape to restore its stem.
   Select Pi: the Task row remains, explaining that its task is entered
   after launch. Switch to Codex and Task opens the task editor again.
9. **Multiline and line editing.** Option-Enter adds a task line. Try Ctrl-W
   to erase a word, Ctrl-U to erase back to the current line's start, Ctrl-Y to
   restore it, and Ctrl-H/D around emoji or accented text. Task editing should
   preserve other lines.
10. **Draft restoration.** Edit the task and defaults, Escape, and reopen an
    empty chooser from the same source. The draft should return. Switch to a
    different source agent/project and check that its draft is independent.
    Drafts last for the current app window; they do not survive app restart.
11. **Agent settings.** Open Agent and highlight Codex with a different agent
    saved. Permissions and Codex profile should appear directly underneath it.
    Down moves into those settings without changing their target. Escape
    without choosing must preserve the saved agent and profile. Choose a mode
    or profile with typing, arrows, and Enter to commit it with Codex. It returns
    to Agent; Escape returns to launch, summarizing nondefault permissions
    beside the agent name. For Codex, choose Codex profile: it lists profiles
    on the selected machine, plus Default profile, Refresh, and Link profile
    folder. Discovery must not change the account. Switch machines and verify
    the old profile is cleared. Escape leaves an uncommitted choice unchanged.
    Agent and Machine pickers should have no repeated Agent/Machine/Project
    summary; that summary remains on the main launch screen.
    Cmd-period retains the full creation form; its nested agent picker must
    choose an agent on Enter/Cmd-Enter before creating anything.
12. **Commands — Cmd-Shift-P.** Search for commands after the editable `> `, read
    their key hints, run one, and Escape out of another. After dismissal,
    ordinary typing should immediately go to the original terminal.

## Workspace and terminal

13. **One agent in several tabs.** Open the same existing agent through
    Cmd-T in two tabs. These should show the same session. Closing a view
    should leave the agent and its other views running.
14. **Mixed machines.** Put local and remote agents in one tab through Cmd-P.
    Check that machine identity remains readable and each pane receives its
    own input. This needs linked machines with existing agents.
15. **Tab navigation.** Try Cmd-1 through Cmd-9 and Cmd-Shift-[ / ]. With many
    tabs, the selected one should remain visible. A manually renamed tab
    should keep its name when panes are added.
16. **Arrange panes.** Use Cmd-H/J/K/L to focus directionally,
    Cmd-Shift-arrows to move a pane, Cmd-Enter to zoom/restore, and Cmd-; to
    return to the previous pane. Moves should preserve the other panes and
    the running sessions.
17. **Resize panes.** Run Resize panes. Use arrows, Shift-arrows for larger
    changes, Tab to change divider, and Escape to finish. The temporary key
    guide should explain the mode and disappear afterward.
18. **Close and reopen.** Run Close Pane or Close Tab, then Reopen closed tab
    or pane. The prior running work should return. Closing a view and stopping
    its agent should feel clearly different.
19. **Output Find — Cmd-F.** Search existing output; Enter/Shift-Enter move
    through hits. Escape should return to the earlier scroll position and
    terminal input. Try the compact match-options menu in a narrow pane.
20. **Read while output arrives.** Scroll upward in a busy terminal. New output
    should not pull you back to the bottom. Return to the bottom and check
    that following output feels natural again.
21. **Clipboard and shell muscle memory.** Copy/paste text and multiline
    commands. Try your usual shell Ctrl-A/E/R/W/U and tmux Ctrl-B in a scratch
    shell. Prompt-only shortcuts should stop intercepting input once dismissed.
    On Linux, copy/paste/select-all are Ctrl-Shift-C/V/A; native Linux runtime
    still needs review.
22. **Small windows, fonts, and menus.** Make a four-pane tab, narrow the
    window, and increase the terminal font. Check names, machine identity,
    compact action/model menus, search rows, and key guides for clipping.
    Arrows/Enter/Escape should work in those menus and restore terminal focus.

## Names and agent actions

23. **Rename Tab / Rename Agent.** Rename Tab also has Cmd-Shift-R; an agent
    title can be double-clicked. The old name should be selected once, typing
    should replace it immediately, Enter should save, and Escape should cancel.
    Renaming an agent should update its pane titles without restarting it.
24. **Fork Agent.** On a supported scratch agent, edit name and task. Escape
    and reopen to check its draft, then fork. The source should stay intact;
    the new agent should open at the original destination. The prompt explains
    conversation continuation versus a handoff when supported by the engine.
25. **Clone Agent (⇧⌘N).** On an owned agent in Plan or Read-only mode, with a
    Codex profile or a named agent if one is at hand. A new tile opens beside
    it at once, named `<source> - clone`, in the same folder with the same mode
    (check the launch argv) and an empty conversation; the source is untouched
    and the tab count does not change. Works the same on a linked remote
    machine; a remote CLI too old to report modes clones in auto mode. A
    terminal pane clones to a terminal; a grid agent is refused with a message.
26. **Restart Agent / Restart Terminal.** This starts immediately. Check the
    compact pending prompt; close/reopen it while pending if timing permits.
    Existing views should remain. A fresh agent conversation should be clearly
    reported; a shell restart simply starts a fresh shell.
27. **Stop Agent / Stop Terminal.** The confirmation names the target and
    initially focuses Cancel. Enter should cancel; Tab then Enter should stop.
    A confirmed stop should close that agent's views across tabs and leave
    unrelated terminals usable.

## Machines and keyboard customization

28. **Open Machines Manager.** Filter by name or status, Enter into actions,
    and Escape back twice. Queries and selection should survive nested
    prompts and refresh. Try keyboard-only machine renaming if desired.
29. **Link machine.** Search existing machines or open desktop/SSH setup.
    Copy controls, links, refresh, and back navigation should work without a
    mouse. A machine's password prompt should accept typing immediately.
30. **This computer's password / Links from this computer.** Open these via
    Machines Manager. Review the wording and keyboard navigation; setting or
    clearing a password and unlinking make real changes. Clear/unlink
    confirmations start on Cancel and explain their scope.
31. **Keyboard shortcuts and Edit keybindings.** Find both through command
    search. Try a custom binding in `~/.config/harness/keybindings.jsonc`
    (or the shown XDG config path). Live hints and prompt behavior should follow
    the change; invalid config should keep the last working bindings.

## Review limits and feedback

Timeout, pending-reopen, stale-response, and duplicate-request cases are covered
by isolated fixtures; there is no need to manufacture network failures during
UI review. The newer durable Fork/Restart status recovery requires the updated
CLI. It is compiled locally, but the running daemon has not been updated or
restarted. Legacy successful operations remain supported.

Settings, remaining first-run onboarding, physical keyboard/IME, VoiceOver,
and native Linux behavior still need a broader pass. They are not finished by
the terminal prompt work.

For each item, useful feedback is: **item number · what felt confusing or slow
· what you expected · what you would prefer**. The main question is whether the
interface feels natural at terminal speed without remembering a separate app's
rules.
