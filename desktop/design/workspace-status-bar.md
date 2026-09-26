# Workspace status bar

One shared status line, using compact monospace text and measured character cells.
Follow the [terminal workspace design system](terminal-workspace.md).

```text
1:api  2:web  3:blender  +          M2  autonomous-harness  (main)
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
Preserve reorder, rename, keyboard focus, and terminal sessions. Cmd-T opens a
tab. Cmd-O opens the shared picker with `#` for projects; Cmd-P opens it directly
on harnesses. Cmd-Shift-P opens commands (`>`). The projects list has
no New Project/Open Folder row. Projects with an open pane in any tab come first;
each group is alphabetical. Pane focus and navigation history do not change that
order. Cmd-Q retains its native Quit action.

Tabs, status fields/symbols, PRs, and model labels and pane close actions share `WorkspaceBarControl`
in Flutter and the same native draw metrics: 28 pt minimum click height and
bold text on hover, press, and keyboard focus, with a hand cursor. Preserve the
underlying colors, including Agnoster segment backgrounds and joins. Reserve
both text weights during layout so labels and ribbon shapes never shift.
The active tab fills the entire bar height with the workspace background color,
joining the content below. Its resting text stays regular; do not add a `*`
marker. Keep text centered, with no ripple or rounded button well.

![Agnoster PR hover and a selected tab joining the workspace, rendered with synthetic data](images/workspace-bar-hover.png)

Do not show a tooltip that repeats a visible tab name (the numeric prefix does
not make it a different name). Show a different underlying name or the full
label when it is truncated. Keep action hints on symbols and status links.

The new-tab `+` uses a plain-text control: no resting
box, with bold text on hover or keyboard
focus. Keep its New Tab tooltip and shortcut hint.

Tab labels, status text, pane titles, and model selectors use **13 pt SF Mono,
regular weight at rest** on macOS. Linux uses its platform monospace stack at the same
size. Use `workspaceBarTextStyle()` and `workspaceBarCellSizeOf(context)` from
`lib/shared/theme/workspace_bar_style.dart`; the native bar receives that same
font through `barStyle`. Keep this size independent of terminal zoom and avoid
an additional UI text-scale factor. Selection uses background color, not bold.
Terminal content and dialogs still follow the user's selected terminal font
and size.

![13 pt workspace bars with synthetic pane names](images/workspace-bars-13pt.png)

## Pane controls

The shared bar shows the focused harness's model selector before machine and
project. Pane headers keep the harness title and a hover-only ASCII `x` at their
far right. The `x` closes that pane view, keeps its harness running, and uses the
shared bold hover treatment. Its tooltip names Close Pane and the current shortcut.
Reserve its width so revealing it does not move the title.

For the model label, prefer
its local model ID or the daemon's observed subscription model (`selectedModel`),
such as `GPT-6 Astra`, `Fable`, or `Opus`. Keep versions when reported; never infer
a version from a family alias. Older daemons fall back to the provider name.
Keep this label visible without requiring hover, including while disconnected;
disable switching when the pane is read-only. Use a hand cursor, bold text on hover
and keyboard focus, and a tooltip explaining subscription/local switching.
Do not repeat the model name in that tooltip unless it is truncated or replaced
by `Switching…`. Preserve useful capability details and full truncated names
while offline, but do not advertise switching when it is disabled.
A model update must repaint the label without reopening or retargeting the pane.
The observed subscription model does not select a Local row in the picker.

Zoom and Stop remain keyboard/menu actions. Cmd-Shift-W closes the focused pane
view, Cmd-W closes the tab, and Cmd-Enter toggles pane zoom. Closing a view
keeps its harness running; Stop Harness remains a separate command with its
existing confirmation. Preserve explicit user keymap overrides.

Pane edges have no floating split buttons. Split Right and Split Down remain
keyboard commands (Cmd-R and Cmd-D by default), with File menu and command-search
access. Keep the resize gaps available for resizing.

Restart Harness and Share Harness belong in File. Fork remains available in
command search. Viewer and message-composer toggles belong in View and command
search. These actions apply to the focused pane; sharing and viewer visibility
follow a dependent viewer's owner.

## Focused context on the right

Show the focused model, then `machine  project`, then `(branch)` when known.
The model is a separate plain text control so switching themes preserves its
click target. A focus change closes its picker; stale native actions and delayed
model selections cannot retarget a different harness.
Use the shared `AgentProject.label` rule: at a Git root, prefer the remote repo's
name, falling back to the local repo name; in a repo subfolder, use that folder's
name; outside Git, use the ordinary folder name. A worktree follows exactly the
same rule. Its generated path and `[worktree]` marker do not belong in the bar.
Keep the full actual path in the tooltip and accessibility detail.

A focused viewer shows its owning harness's context. Show only named branches;
omit detached commit hashes and absent project or Git metadata. Clear it for an
empty tab.

![Detached checkout showing its model, machine, and project, rendered with synthetic data](images/workspace-detached-status.png)

Each field is independently clickable, with the same bold hover/keyboard-focus
text and hand cursor as the status symbols. Machine opens the shared picker scoped by machine
identity; project opens its harnesses across matching remote checkouts; branch
opens that project filtered by its exact branch. Escape returns
from branch to project, then to project search. Names never establish identity.
Branch navigation does not check out or create a branch.

Customize Harness → Status offers twelve saved themes, grouped into Minimal
and Powerline, with a preview of the same sample pane beneath each choice.
Selection covers only the name row. Tab and Shift-Tab move between choices;
Enter or Space selects, scrolls the choice into view, and saves it. The selected
theme also previews PR status. Previews inherit the terminal font and cell size;
the workspace bar uses the fixed 13 pt bar font. Controls keep the plain terminal design.

| Theme | Treatment |
| --- | --- |
| Plain (default) | Monochrome `machine  project  (branch)`, including the PR |
| Robbyrussell | Green arrow, cyan project, blue `git:(` with red branch |
| Pure | Blue project, muted machine/branch, magenta prompt mark |
| Powerlevel10k Lean | Unboxed yellow machine, blue project, green branch symbol and ASCII `>` |
| Spaceship | Cyan project and magenta branch symbol, with `in` / `on` separators |
| Starship | Muted machine, cyan project, `on` and a magenta branch symbol, green prompt mark |
| Agnoster | Joined black context, blue project, and green branch segments |
| Powerlevel10k Rainbow | Light context, blue project, green branch, angular joins |
| Pastel Powerline | Plum, rose, and peach segments, rounded leading cap and angular joins |
| Catppuccin Powerline | Mocha red, peach, and yellow segments, rounded outside caps |
| Tokyo Night | Cool gray, blue, and indigo segments, rounded joins and outside caps |
| Gruvbox Rainbow | Warm orange, gold, and moss segments, rounded outside caps |

![Twelve status presets, rendered by AppKit with synthetic data](images/terminal-status-presets.png)

These are one-line visual adaptations, not installed shell themes or a ranking.
The catalog covers established Oh My Zsh themes plus Pure, Spaceship,
Powerlevel10k, and Starship's official presets. Starship is a separate prompt
engine that works with Zsh. Its named color presets are useful here because
they offer distinct palettes beyond changes to separators and spacing.

Powerline separators and branch symbols are drawn one-cell shapes and do not
require patched fonts. The branch symbol appears only with a real named branch;
it does not alter the branch's accessible name, tooltip, search, or click target.
At tight widths, segmented fields drop the decorative symbol and can fall back
to plain text. Prompt
marks and segment colors never invent dirty, ahead/behind, privilege, runtime,
clock, or exit-status readings. Plain retains familiar parenthesized branch
notation; Zsh's actual stock prompt is `%m%# ` (host and prompt character).

Minimal themes, Agnoster, and Powerlevel10k Rainbow use the terminal ANSI ramp.
Pastel Powerline, Catppuccin Powerline, Tokyo Night, and Gruvbox Rainbow carry
status-only palettes adapted from the linked Starship presets below. They do
not recolor terminal output or change the workspace palette. Keep these tokens
in the shared formatter, never duplicated in native code. Choose a readable
ink from the named palette (or black/white where necessary) so small text on
these filled segments has at least 4.5:1 contrast. Preserve the terminal font,
the existing bold-only hover cue, and stable field widths.

The rightmost PR label belongs to the focused harness, including when its viewer
has focus. Display `#298 Merged` (or Draft/Open/Closed), with a separate link
to that PR. Plain themes leave one text cell before the label. Segmented themes
connect it directly to the preceding arrow, making one continuous bar while
retaining the PR click target. The selected-theme preview
shows that same joined line. State colors come from the selected status palette:
muted for Draft, green for Open, magenta for Merged, and red for Closed. Turning
Color off applies a monochrome treatment to context and PR together. Plain always
uses the terminal foreground even when Color is enabled. Existing `standard`
settings resolve to Plain; existing `powerlevel10k` settings resolve to Lean.

References: [Oh My Zsh themes](https://github.com/ohmyzsh/ohmyzsh/wiki/Themes),
[Pure](https://github.com/sindresorhus/pure),
[Powerlevel10k Lean](https://github.com/romkatv/powerlevel10k/blob/master/config/p10k-lean-8colors.zsh),
[Powerlevel10k Rainbow](https://github.com/romkatv/powerlevel10k/blob/master/config/p10k-rainbow.zsh),
[Spaceship](https://github.com/spaceship-prompt/spaceship-prompt),
[Starship](https://starship.rs/),
[Pastel Powerline](https://starship.rs/presets/pastel-powerline),
[Catppuccin Powerline](https://starship.rs/presets/catppuccin-powerline),
[Tokyo Night](https://starship.rs/presets/tokyo-night), and
[Gruvbox Rainbow](https://starship.rs/presets/gruvbox-rainbow).
These are compact adaptations; machine/project/branch/PR remain real Harness data.

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

Pane headers keep task identity and the hover-only close action. The top bar
contains tabs, New Tab, and focused model/machine/project/branch/PR context.
Do not add a standalone Search label or category icons at the right edge.
Context links open the corresponding scope in the unified picker. Global
search remains available through Cmd-P and the app menu.

The picker's empty preview contains clickable `@ machines`, `# projects`,
`: models`, `* store`, and `> commands` hints. Each inserts its editable prefix
and returns typing focus to the search input. Machine and model management,
including API forms, stays inside the right pane. Store results open their
Store page. Cmd-O, Cmd-M, Cmd-I, and Cmd-Shift-P remain shortcuts into the same
picker; focused context links keep their scope.

Leave a window drag area between tabs and context and prevent overlap in
narrow windows. Native menus and commands remain available.

The companion sits at the far right, directly after the focused context and PR.
Its one-cell inner gutters provide separation; add no extra gap or divider.
Before hatching, show the ASCII egg `\_O_/` in
warm terminal colors. Each discovery reveals a little more life, ending in
`\_o.o_/` when ready. Brief gestures react to discoveries, completed turns,
returning after a break, or direct interaction; no repeating animation loop.
After hatching, show only the
one-line ASCII creature. Its name and progress belong in the tooltip and companion panel, never
beside the symbol. Use the same 13 pt workspace font as the status line, and
reserve eight character cells plus one-cell gutters from egg through creature
so expressions do not move nearby text. Clicking a ready egg hatches it directly; otherwise it opens the compact
onboarding or companion panel. A brief first-arrival hint explains the egg without
taking focus, and hover retains its meaning and progress. Escape returns
focus to the workspace. Mood updates repaint only the companion control.
The complete lifecycle and interaction rules are in [Terminal companion](terminal-companion.md).

Data rules live in `lib/state/workspace_status.dart`; prompt formatting lives in
`lib/shared/theme/status_line_style.dart`. Flutter draws the fallback bar in
`SwarmScreen`; macOS draws `SwarmTabStrip` in `macos/Runner/SwarmTitlebar.swift`.
Both use the same names, formatted context, resolved text/color segments, and
preferences. `WorkspacePullRequest` owns focused PR state; the native and Flutter
bars receive the same validated label and URL. Checks live in
`workspace_status_test.dart`, `workspace_pull_request_test.dart`,
`status_line_test.dart`, and `tool/swarm_titlebar_checks.swift`.

To regenerate the synthetic native catalog image, set
`HARNESS_NATIVE_STATUS_CAPTURE_DIR` to a temporary directory when running
`flutter test test/workspace_status_test.dart`. With the same variable, run
`bash tool/check_swarm_titlebar.sh /path/to/flutter --status-preview`;
`native-themes.png` is drawn by the production AppKit controls from the real
Dart payloads. No live window, account data, or saved appearance is used.
