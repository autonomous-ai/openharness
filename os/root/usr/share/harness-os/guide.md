# Helping someone use Harness

Harness is a Linux operating system built by agents, for agents. The user works in the
Harness terminal interface (`hn`). Each agent has its own conversation, project
and pane. A browser is available when viewing web content or graphical work helps.
This is a full Arch-based OS, with ordinary development tools installed as needed.

## Read the computer before advising

- `/etc/harness-live` exists only while running from the USB. Installation actions
  belong to that session, never to ordinary Harness on macOS or another Linux.
- `/usr/share/harness-os/lock.json` identifies the image. `hn --version` identifies
  the running TUI, which may have received a newer update independently.
- The complete shipped TUI reference is
  `/usr/share/harness-os/guide/tui.md`. Read the relevant sections before answering
  questions about features. Its source revision is in `guide/source.json`.
- `hn list-keys` reports the actual bindings, including the user's changes.
  `hn list-commands` reports supported commands. Prefer those live results when a
  newer TUI differs from the bundled reference. Do not substitute desktop-app
  Cmd shortcuts for terminal bindings.
- OS Super bindings are in `/usr/share/harness-os/labwc/rc.xml`; they are handled
  by the compositor and will not appear in `hn list-keys`.
- Read `/usr/share/harness-os/AGENTS.md` before changing system configuration.
  Do not describe planned hardware support as physically tested support.

## First conversation and installation

Help the user accomplish something small: build a page, fix code, explore a repo,
or ask about Harness. Answer directly; offer the relevant next action. The USB
Install dock already keeps installation visible, so do not repeat a sales pitch
in every answer or interrupt useful work with installation reminders.

If the user asks to install, run `harness install` without sudo or arguments.
It opens the real installer in Harness and returns to the conversation. The user
chooses Disk, Encryption, Password and Repeat password, then selects Install.
Encryption starts enabled. The account is `me` and the computer is `harness`.
Installation erases the selected disk; the form says so beside its Install action.
Never ask for disk/password details in chat, guess a target disk, or construct an
unattended install configuration. Never type the user's password for them.
Installation works offline. Do not require a model, account or network to install.

USB work is temporary until saved elsewhere or installed. Create trial projects
under `~/Projects` so the installer can carry their files into the installed home.
This does not preserve running processes. Keep API keys in the agent's normal
credential storage, outside projects; do not put secrets in example source files.

## Multiple agents, panes and tabs

Use **New Harness** to start another agent; use **New terminal** for a shell
immediately, without an agent/project/task form. A pane shows one harness or
terminal. A tab groups panes. Different agents can work on different projects, or
on separate worktrees of the same repository. Explain file conflicts before
putting agents on the same working files. Closing a pane removes its view;
stopping a harness ends its running work. These are different actions.

OpenCode is bundled. Other supported agents can be installed when selected and
may require provider sign-in or an API key. Model availability, subscriptions and
free offerings are controlled by the provider. Keep OpenCode's default model
selection; never promise unlimited free access or pin a particular free model.

Useful terminal defaults (verify with `hn list-keys` if customized):

| Keys | Action |
| --- | --- |
| Ctrl+B, then Shift+N | New Harness |
| Ctrl+B, then Shift+T | New terminal |
| Ctrl+B, then s | Find harnesses across connected computers |
| Ctrl+B, then c | New tab |
| Ctrl+B, then n / p | Next / previous tab |
| Ctrl+B, then o / arrow | Next pane / pane in that direction |
| Ctrl+B, then z | Zoom or restore the focused pane |
| Ctrl+B, then % / " | Split right / below with a terminal |
| Ctrl+B, then a | Next harness needing attention |
| Ctrl+B, then Shift+A | All harnesses needing attention |
| Ctrl+B, then Shift+B | Broadcast a message to the tab |
| Ctrl+B, then @ | Machines |
| Ctrl+B, then Shift+S | Harness Store |
| Ctrl+B, then ? | Key reference |
| Ctrl+B, then : | Command prompt |
| Ctrl+B, then [ | Scrollback/copy mode |

Ctrl+B is a prefix: release it, then press the next key.
Each agent also owns its own keys while its pane has focus. Shift+Enter inserts a
new line in compatible agent prompts. Do not intercept agent shortcuts needlessly.

## Multiple computers

The **Connect a computer** action opens Harness's existing connection flow.
This computer works without a Harness account. Connecting other computers uses
the existing sign-in/link flow; guide the user there when needed rather than
collecting passwords in chat. The other computer needs Harness running and its
connection configured. A sleeping/offline computer cannot run a new task for us.

After linking, choose the destination computer and project in New Harness, or
open an existing harness through the machines/harnesses search. Work executes on
that computer: paths, tools, GPUs and files belong to it. The same path string on
two computers is not a shared folder. Connecting does not migrate projects.
Remote agents can sit beside local agents in one tab. Read the TUI reference's
machines, search and shared-session sections for exact interaction details.

## More of the TUI

The reference covers project/worktree choices, model selection, provider setup,
the Harness Store and viewers, search/filtering, questions and approvals, agent
states and activity, pause/resume/restart/clone, broadcasting, copy/clipboard,
layouts, appearance, key customization, session persistence and multiple clients.
Consult the relevant section and current command help instead of inventing a
shortcut. Do not assume several agent panes automatically collaborate or share
conversation history. Describe only collaboration controls present in this TUI.

## OS keys and essentials

- Super+i opens Install on the live USB. The persistent Install button does too.
  F10 focuses the USB dock; Tab moves between its buttons and Enter activates one.
- Super+w opens Wi-Fi. Ethernet connects automatically when available.
- Super+n opens New Harness; Super+t opens a terminal; Super+m connects a computer.
- Super+b switches between Harness and the browser. Super+Enter focuses Harness.
- Super+l locks the screen. Brightness and volume keys operate supported hardware.
- Super+u opens Updates after installation. Updates keep projects and running
  work; flashing another USB is not the everyday update workflow.

These shortcuts require no Shift and no Ctrl+b prefix. Super is the Windows-logo key on a PC keyboard and the Command key on a Mac
keyboard running this OS. These are OS bindings, not ordinary macOS bindings.
Use `hn-browser URL` to inspect a website. Agents remain the primary work surface.
For Wi-Fi, use `hn-os wifi`; passwords stay in its masked system form. For
hardware, drivers, packages, updates and recovery, follow the system guide above.
