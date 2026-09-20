# Prompt themes and workspace styling

The user's reference is an Agnoster-style shell prompt. The goal is familiar,
compact context and fast keyboard interaction, with appearance choices that
can be previewed before returning to work.

## References studied

| Reference | Lesson applied |
| --- | --- |
| [Pure](https://github.com/sindresorhus/pure) | Keep the context short, with minimal chrome and selective information. Its configurable symbols and colors support a quiet plain-text option. |
| [Agnoster](https://github.com/agnoster/agnoster-zsh-theme) | Use visually distinct segments for machine, directory and branch. Its patched-font requirement is a reason to draw separators and use bundled symbols in the GUI. |
| [Powerlevel10k](https://github.com/romkatv/powerlevel10k#configuration-wizard) | Make appearance a set of understandable choices with previews. Its configuration wizard demonstrates presenting different styles over the same information. |
| [Starship presets](https://starship.rs/presets/) | Offer both symbol-rich and plain-text presentations. Its no-Nerd-Font and plain-text presets demonstrate the value of a reliable fallback. |

These are design lessons, not installed shell themes or copied theme code.

## Implemented choices

The ASCII marker `>_` identifies the harness in every preset: `>_ Codex`,
`>_ Claude`, and other harness names. It also appears in new-agent defaults
and the agent preview. No special font is needed for this marker.

**Symbols** is the default: a small monitor mark for machine, folder mark for
project, and branch mark for branch. They use the app's existing bundled Lucide
font independently of the user's text font.

**Plain** uses only ASCII markers: `>_ Codex`, `@ devbox`, `/ openharness`,
`git: main`.
The slash identifies a project; the UI does not fabricate a home-directory path.

**Powerline** uses the same context with chevron segments and subdued fills.
The separators are drawn shapes, so their rendering is independent of the
selected terminal font. Color can be disabled for any preset. Each of Machine,
Project and Branch can be shown or hidden, and reset affects only these prompt
preferences.

Context reads machine first, followed by project and branch. Search also names
the agent type. Narrow search rows put context below the task; narrow pane
headers prioritize the machine and keep full identity in the tooltip. Missing
project or branch metadata produces no placeholder segment. Branch color is
decorative: no dirty/clean, ahead/behind or other unreported Git state is implied.

The same shared renderer serves search, pane headers and customization preview.
Matching and ranking use unchanged catalog fields, including hidden context.
No shell process or Git probe is launched to draw a prompt.

## Workspace application

Cmd-T, Cmd-P, Cmd-N and command search share the bottom command dock. It overlays
the pane area, preserving terminal geometry. Input stays above the key guide;
results and default choices expand upward. Panels, tabs and pane borders use
the same restrained geometry. Native macOS window corners remain OS-managed.

The New Pane titlebar pill is removed. Keyboard commands, File → New Pane and
command search remain available. The start page still presents New Tab and New
Pane as entry points. Guided onboarding and the optional full keyboard practice
remain separate, unfinished work.
