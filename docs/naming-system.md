# Naming System

The source of truth for names and meanings across Harness: the operating system,
terminal, desktop, web, mobile, device, documentation, and product pages. These
decisions were approved on October 3, 2026. Use this system when naming a feature,
writing interface copy, or explaining how the products fit together.

Harness is the software product. Autonomous is the company. Agents are the primary
way to do work: conversation directs them; terminal output, diffs, and optional
viewers make their work inspectable. Programmers are the first audience.

This document defines the vocabulary. Component documentation and release evidence
establish which capabilities are available. Visual presentation follows the
applicable design system, including the [desktop Design System](../desktop/design/desktop-design-system.md).

## Product names

| Thing | Name | Usage |
| --- | --- | --- |
| Company | **Autonomous** | Autonomous builds Harness and the hardware. |
| Software product | **Harness** | The shared name across its interfaces. |
| Full Linux installation | **Harness** | Write “the Harness operating system” when the distinction matters. |
| Terminal interface | **Harness** | “Open Harness in your terminal.” Its command is `hn`. |
| Desktop, web, and mobile interfaces | **Harness** | Use descriptors such as “the Harness desktop app” or “Harness on your phone.” |
| Compute hardware | **Autonomous Computer** | The physical computer. “Personal AI computer” can describe it. |
| Optional companion controller | **Harness device** | The input and status device connected to the computer. |
| Optional inference network | **Grid** | Routes model requests to the computers serving them. |
| Open source project and repository | **OpenHarness** | Use for the source project and repository identity; the product interface says Harness. |

Use **Harness** in prose. Wordmarks and ASCII artwork may use their established
lettering. `hn` and `harness` are commands, and `harnessd` is the name of the
daemon's process (the way `dockerd` is Docker's); none of them is an additional
product brand. Prose says "the Harness daemon".
Keep vendor names intact: **Claude Code**, **Codex**, **OpenCode**, and **pi**.

The roadmap can be explained in one sentence:

> Use Harness on your own computer, or get an Autonomous Computer with Harness
> preinstalled and an optional Harness device.

Owning Autonomous hardware is optional. Describe the round and square devices as
form factors until model names are chosen; a concept image does not establish that
a variant or integration has shipped. The square device's two modes are **Harness**
and **Browser**. Technical documentation may still call the terminal interface a TUI.

## Work and interface terms

| Term | Meaning | Example |
| --- | --- | --- |
| **Agent** | The agent software chosen, or the AI doing the work. | Choose Codex; the agent is running tests. |
| **Model** | The model an agent uses. | Change the model while keeping the agent and project. |
| **Harness** in product copy | The software product. | Open Harness. |
| **A harness** in the workspace | A running agent session with its own conversation and working context. | Start three Codex harnesses. |
| **A harness** in the Store | A reusable setup containing agent instructions, tools, and an optional viewer. | Install the Blender harness. |
| **Tab** | A workspace group of harnesses. | Frontend and Backend tabs. |
| **Pane** | A visible view of a harness, terminal, or viewer. | Split right; close pane. |
| **Terminal** | A shell for entering commands. | New terminal. |
| **Project** | The files and working context for the work, on a particular computer. | Choose the website project. |
| **Task** | The work requested. | Add a search field. |
| **Browser** | The optional browser for web content and visual review. | Open the browser. |
| **Viewer** | A surface for inspecting or interacting with work. | The game viewer; the HTML preview. |
| **This computer** | The local execution machine. | Run on This computer. |
| **Store** | The catalog of reusable harnesses and viewers. | Install a harness from the Store. |
| **Conversation** | An agent's conversation history, including histories started outside Harness. | Provider usage counts native conversations. |
| **Recorded run** | A saved demonstration of a harness doing work. | Watch the recorded run in the Store. |

Use lowercase *harness* and *tab* in ordinary sentences. The action and context
distinguish the two uses of *harness*: install or update a package in the Store;
start, pause, or stop a running harness in the workspace. Keep **agent** for choosing
the agent software and describing the AI's actions. Preserve **New Harness** as the
existing action name.

A pane is a view, so closing a pane or tab closes views. **Stop Harness** ends the
running harness. Adding harnesses to a tab groups them without a separate team
setup. **Settings → Experimental → Tab collaboration** lets their agents consult
peers; it is off by default. The word *tab* can also name the keyboard key or a
browser tab; context distinguishes them.

A project belongs to a computer; identical paths on different computers do not
identify the same project. Use the actual project or computer name when that
context matters. A plain terminal opens directly without an agent, project, or
task form.

## Action names

| Intent | Label |
| --- | --- |
| Start a running harness | **New Harness** |
| Create a workspace group | **New Tab** |
| Open a shell | **New terminal** |
| Manage a workspace group | **Rename Tab**, **Close Tab**, **Next Tab**, **Previous Tab** |
| Manage a running harness | **Rename Harness**, **Pause Harness**, **Resume Harness**, **Restart Harness**, **Stop Harness** |
| Author a reusable Store package | **Create Harness** |
| Start the bundled agent from the installed OS home | **Start OpenCode** |
| Set up wireless networking | **Connect to Wi-Fi** |

Use the object's own name where possible: **Blender**, **Web Viewer**, or the
person's project name. Keep task instructions in the conversation and technical
configuration where it affects a decision.

## Operating system copy

| Surface | Wording |
| --- | --- |
| Boot and unlock branding | **Harness** |
| First-use description | **The operating system built by agents, for agents.** |
| Disk unlock prompt | **Enter your password** |
| USB install action | **Install Harness** |
| USB startup | Open **Install Harness** directly; no trial choice or network step. |
| First installed boot | **Connect to Wi-Fi to get started** when disconnected, then the agent workspace. |
| USB session label | Omit from the single installation footer. |
| Connect another execution machine | **Connect a computer** |
| Installer title | Omit the redundant heading; label the action. |
| Installer fields | **Disk**, **Encryption**, **Password**, **Repeat password** |
| Installer action | **Install Harness** |
| Installation completion | **Harness is installed.** |
| Completion actions | **Shut down**, **Back to Harness** |
| Default account | `me` |
| Default computer name | `harness` |
| Default shell identity | `me@harness` |
| Open installation from a conversation or shell | `harness install` |
| Direct administrative installation command | `sudo harness install` |
| OS page description | **A Linux operating system built by agents, for agents.** |
| Audience description | **Built for programmers first.** |

The USB opens the installer directly and works offline. There is no trial option.
After rebooting the installed disk, the existing Wi-Fi page appears when needed;
a working connection advances to the agent and two terminal panes. Ordinary hn
on macOS or another Linux distribution never shows OS installation actions.
The `harness install` system command belongs to the OS integration.

Write OS shortcuts with lowercase letters: **Super+n**, **Super+t**, **Super+m**,
**Super+i**, **Super+w**, **Super+b**, **Super+u**, **Super+l**. They require no Shift
and no prefix. The existing shared TUI prefix shortcuts remain available; write
**Ctrl+b, then Shift+n** when that binding requires Shift. Super means the Windows
key on PC keyboards and the Command key on Mac keyboards running Harness OS.

The terminal and optional browser are the OS's working surfaces. This does not
replace the desktop app's design system or require every Harness interface to
adopt the OS welcome screen.

## Technical names and compatibility

**DSH** means domain-specific harness in authoring documentation, code, and the
package protocol. Users choose the harness by its name. Keep `harness dsh …`,
package identifiers, manifests, and existing API names compatible.

Internal names such as `Swarm`, `swarm.new`, `swarms`, `Agent`, `sessionId`, `tabId`,
`DeskTab`, `channel`, and `--tab` are not renamed by this system. Authentication,
encryption, tmux, native engine sessions, daemons, and model providers retain their
technical meanings. Use those terms where they help explain or diagnose behavior.

| Older visible wording | Canonical wording |
| --- | --- |
| Programmer OS | **Harness** |
| programmer or programmer-live as a default identity | **me**, **harness**, or **me@harness**, according to the field |
| hn or hn TUI as a product name | **Harness**; retain `hn` in command examples |
| New Swarm or Untitled Tab as an automatic group name | **New Tab** |
| Swarm as a workspace group | **Tab** |
| TUI as the square device's mode label | **Harness** |
| DSH as a user-facing package name | The harness's actual name |

Search can accept older terms as aliases. Preserve explicit custom names, stored
keys, existing commands, historical evidence, and published artifact URLs. Update
current visible copy and examples without breaking those references.

## Maintaining the system

Define a new term here before introducing it across interfaces. Give it one clear
role, an example, and its relationship to the existing terms. Update affected
labels, documentation, accessibility text, shortcuts, and tests together.

Product claims must describe the tested configuration. In particular, say local
models work out of the box only after the drivers, inference runtime, model
provisioning, and agent connection have been verified for that configuration.
See the [OS coverage](../os/README.md) for current evidence and limitations.

The hardware context lives in [Autonomous Computer](https://github.com/autonomous-ai/autonomous-computer),
the [Harness device guide](../devices/harness-device/firmware/README.md), and
[Grid](https://github.com/autonomous-ai/autonomous-grid). These names connect the
roadmap; they do not make every component a required dependency.
