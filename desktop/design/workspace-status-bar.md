# Workspace status bar

One shared status line, using the terminal font and measured character cells.
Follow the [terminal dialog design system](terminal-dialogs.md).

```text
1:api  2:web  3:blender  +                OpenAI  M2:autonomous-harness  (main)
```

## Tabs on the left

Each tab shows its number and a compact name. A user-entered name always wins:
once renamed, keep it across pane changes, closing/reopening, and saved layout
restores. Use automatic naming only when `nameIsCustom` is false. Custom-named
tabs do not vote in the automatic-name comparison. Count independent
harness panes once per agent; dependent viewers do not vote. Consider harness
type (`code`, `blender`, etc.), project name, and machine name. Choose the most
widely shared trait in that tab. Among equally shared traits, prefer the name
least repeated in other tabs; otherwise prefer type, then project, then machine.
Ties within one trait use pane order. Focus does not affect the name.

This keeps `blender` useful beside coding tabs, uses project names when all work
is code, and uses machine names for the same project on different computers.
Tabs with identical contents can still share a name; their numbers distinguish
them. Preserve the full name for inspection when its visible label is truncated.

Center the text with one cell of padding on each side. Cap long labels at 24
cells and scroll overflow, revealing the selected tab on keyboard navigation.
There is no close button or reserved close-button space. Cmd-W closes the active
tab; preserve remapped shortcuts, native menu access, and middle-click closing.
Preserve reorder, rename, keyboard focus, and terminal sessions.

Tab labels, status text, and pane titles use the selected terminal font, point
size, and regular weight. Pane titles must not use the smaller `monoLabel` UI
style. As in the terminal renderer, do not apply a second UI text-scale factor
to pane titles.

## Pane controls

Keep three muted ASCII controls at the right of a harness pane: `-` closes only
that view, `[]` toggles zoom, and `x` stops the harness after confirmation. Each
control occupies two character columns. Use the terminal font and palette,
plain text, and a subtle hover/focus fill. Reveal these controls only while the
pointer is over that pane's top bar, or a control has keyboard focus. Hovering
the terminal body does not reveal them. Reserve their columns while hidden so
the title never shifts, and keep keyboard traversal available. Retain
descriptive tooltips and accessibility labels; never rely on the symbols alone.

Pane edges have no floating split buttons. Split Right and Split Down remain
keyboard commands (Cmd-R and Cmd-D by default), with File menu and command-search
access. Keep the resize gaps available for resizing.

Restart Harness and Share Harness belong in File. Fork remains available in
command search. Viewer and message-composer toggles belong in View and command
search. These actions apply to the focused pane; sharing and viewer visibility
follow a dependent viewer's owner.

## Focused context on the right

Show provider or selected model, `machine:project`, then `(branch)` when known.
Use the shared `AgentProject.label` rule: at a Git root, prefer the remote repo's
name, falling back to the local repo name; in a repo subfolder, use that folder's
name; outside Git, use the ordinary folder name. A worktree follows exactly the
same rule. Its generated path and `[worktree]` marker do not belong in the bar.
Keep the full actual path in the tooltip and accessibility detail.

A focused viewer shows its owning harness's context. Omit absent project or Git
metadata; detached commits say `detached:<commit>`. Clicking the context opens
the harness's existing model picker when supported. Clear it for an empty tab.

Customize Harness → Status offers five saved themes with a colored preview of
the same sample pane beneath each choice. Selection covers only the name row.
The selected theme also previews PR status. All choices inherit the terminal
font, cell size, and ANSI palette; controls keep the plain terminal design.

| Theme | Treatment |
| --- | --- |
| Standard (default) | Foreground provider, cyan `machine:project`, green `(branch)` |
| Robbyrussell | Green arrow, cyan project, blue `git:(` with red branch |
| Pure | Blue project, muted machine/branch, magenta prompt mark |
| Agnoster | Joined black context, blue project, and green branch segments |
| Powerlevel10k Rainbow | Separate light provider, yellow-on-black machine, blue project, and green branch segments |

These are one-line visual adaptations, not installed shell themes. Powerline
separators are drawn one-cell shapes and do not require patched fonts. Prompt
marks and segment colors are decorative; they never invent dirty, ahead/behind,
privilege, or exit-status readings. Standard keeps familiar host/directory
notation; Zsh's actual stock prompt is `%m%# ` (host and prompt character).

The rightmost PR label belongs to the focused harness, including when its viewer
has focus. Display `PR #298 · Merged` (or Draft/Open/Closed), with a separate link
to that PR. Plain themes leave one text cell before the label. Segmented themes
connect it directly to the preceding arrow, making one continuous bar while
retaining separate model-picker and PR click targets. The selected-theme preview
shows that same joined line. State colors come from the terminal palette:
muted for Draft, green for Open, magenta for Merged, and red for Closed. Turning
Color off applies a monochrome treatment to context and PR together.

Read PR status through the owning machine's existing `git_pull_request` RPC.
Refresh once per minute while focused, reuse recent results across focus
switches, and discard stale replies after a pane, branch, or project change.
Unknown, absent, or inaccessible PRs have no label. Never display a previous
pane's PR while waiting for the newly focused one. Compact pane headers do not
also poll or display PR status.

References: [Zsh prompt parameters](https://zsh.sourceforge.io/Doc/Release/Parameters.html),
[Oh My Zsh themes](https://github.com/ohmyzsh/ohmyzsh/wiki/Themes),
[Robbyrussell source](https://github.com/ohmyzsh/ohmyzsh/blob/master/themes/robbyrussell.zsh-theme),
[Pure](https://github.com/sindresorhus/pure),
[Agnoster](https://github.com/agnoster/agnoster-zsh-theme), and
[Powerlevel10k](https://github.com/romkatv/powerlevel10k).

Pane headers keep task identity and controls. Machines, Models, Harnesses, and
the Store remain reachable from native menus and commands. Leave a window drag
area between tabs and context and prevent overlap in narrow windows.

Data rules live in `lib/state/workspace_status.dart`; prompt formatting lives in
`lib/shared/theme/status_line_style.dart`. Flutter draws the fallback bar in
`SwarmScreen`; macOS draws `SwarmTabStrip` in `macos/Runner/SwarmTitlebar.swift`.
Both use the same names, formatted context, resolved text/color segments, and
preferences. `WorkspacePullRequest` owns focused PR state; the native and Flutter
bars receive the same validated label and URL. Checks live in
`workspace_status_test.dart`, `workspace_pull_request_test.dart`,
`status_line_test.dart`, and `tool/swarm_titlebar_checks.swift`.
