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
| **A harness** in a tab | A running agent session with its own conversation and working context. | Start three Codex harnesses. |
| **A harness** in the Store | A reusable setup containing agent instructions, tools, and an optional viewer. | Install the Blender harness. |
| **Tab** | A group of harnesses in the window. | Frontend and Backend tabs. |
| **Swarm** | A collaborative tab containing projects, people, agents and contributed machines. Invite-only by default; its owner can enable joining by email domain or a shared link. | Open your company Swarm beside your regular tabs. |
| **Workspace** | The level above Swarms: several Swarms on one account and the people who may be in them, each with a role (owner, admin, member or guest). A person can belong to several Workspaces. Not the Harness **Team account**, a Mac's privacy-checked account for teammates' work. System name: workspace. | Create the Swarm in your company Workspace. |
| **Project in a Swarm** | An initiative with its own product manager, repository, sharing and workgroups. | Discuss Lamp OS with its product manager; expand it to follow a workgroup. |
| **Instructions** | The visible name for a project's skill set and each role's text. System name: skill. | Open Instructions; edit Product Manager instructions. |
| **Product Manager** | The agent coordinating a Swarm project. Use **PM** in a compact role badge. System name: lead. | Message Product Manager. |
| **Engineer** | An agent carrying out project work. Use **Dev** in a compact role badge. System name: builder. | Atlas is an engineer on Lamp OS. |
| **Reviewer** | An agent that reviews project work. Use **Rev** in a compact role badge. System name: reviewer. | Atlas is a reviewer on Lamp OS. |
| **Workgroup** | A numbered conversation for an independently assignable outcome within a project. | Follow #12 Offline editing. |
| **Pane** | A visible view of a harness, terminal, or viewer. | Split right; close pane. |
| **Terminal** | A shell for entering commands. | New terminal. |
| **Project** | The files and working context for the work, on a particular computer. | Choose the website project. |
| **Task** | The work requested. | Add a search field. |
| **Browser** | The optional browser for web content and visual review. | Open the browser. |
| **Connections** | Service accounts available to agents running as the same local user on a Harness computer. | Open Connections; connect GitHub. |
| **Viewer** | A surface for inspecting or interacting with work. | The game viewer; the HTML preview. |
| **This computer** | The local execution machine. | Run on This computer. |
| **Cloud** | An agent maker's own servers, as a place a harness runs beside the computers. A **cloud agent** runs there, reached through its maker's API rather than as a terminal program. | Devin Cloud runs in Devin's cloud; Fo runs only in Fo's cloud. |
| **Store** | The catalog of reusable harnesses and viewers. | Install a harness from the Store. |
| **Conversation** | An agent's conversation history, including histories started outside Harness. | Provider usage counts native conversations. |
| **Recorded run** | A saved demonstration of a harness doing work. | Watch the recorded run in the Store. |

The three Swarm roles, on screen and inside the system:

| Role | On screen | Short label | System name | Skill |
| --- | --- | --- | --- | --- |
| Coordinates | Product Manager | PM | lead | swarm-lead |
| Builds | Engineer | Dev | builder | swarm-dev |
| Reviews | Reviewer | Rev | reviewer | swarm-review |

People see the on-screen name and short label. Agent-facing text (prompts, skills,
CLI help) may use the system names Lead, Builder and Reviewer. The Lead does only
answers, lookups and work under 15 minutes itself, and routes the rest.

Use lowercase *harness* and *tab* in ordinary sentences. The action and context
distinguish the two uses of *harness*: install or update a package in the Store;
start, pause, or stop a running harness in a tab. Keep **agent** for choosing
the agent software and describing the AI's actions. Preserve **New Harness** as the
existing action name.

A CLI agent keeps its name, and the same maker's cloud coding agent is that name
plus **Cloud**: Codex and Codex Cloud, Devin and Devin Cloud. A personal agent with
no CLI keeps its maker's name (Fo).

A pane is a view, so closing a pane or tab closes views. **Stop Harness** ends the
running harness. Adding harnesses to a tab groups them without a separate team
setup. A **Swarm** occupies one tab in that same tab bar. A person can belong to several Swarms.
Its sidebar reads like a chat app's. It starts with **New project**, **Your devices** and
**Your models** (and **Notifications** where no menu-bar list carries it: on a Mac, what needs
the person is in the menu bar's Harness menu and on the Dock's badge), then three sections in this
order: **Projects**,
**Direct messages** and **Machines**. Projects and Machines have section headings with disclosure
after the label and an add action at the right. Project rows read as channels, from A to Z:
**#** at the left, then their name and status, with no chevron. The Product Managers'
conversation is one of them, **# product-managers**, with no workgroups. A click on a project row
opens its product manager chat and reveals its workgroups; a second click on the open project
hides them. Workgroups are shown by their number in grey with no **#**
and then their title (`12  Offline editing`), aligned with the project name. An expanded project
without workgroups says **No workgroups yet**. An open channel's heading reads as its row
(`# openharness`). **Direct messages** holds the person's **Chat with PM** for each project,
listed by the product manager's name and avatar; opening one highlights only that row and leaves
the projects as they were. The project's name is in grey brackets when
the Swarm has several (`Finn (web-2)`) and a count of new messages. Hovering says
**Chat with PM**, and ⇧⌘K opens the current project's.
**Your devices** opens the Devices dashboard and its existing agent conversation inside the
current Swarm, preserving project drafts and the selected workgroup. Ordinary tabs retain
their standalone Devices view. The navigation, conversation and people panes have
draggable dividers; their default side widths are 300 and 280 pixels, respecting saved resizes.
The right pane is a stable directory of all humans and agents in the current Swarm that the
viewer can access. Selecting a project, workgroup or Devices does not filter that directory;
local machine inventory does not add people or agents to it.
Agents have individual display names and the same avatar treatment as people. Their role badges
are **PM**, **Dev** and **Rev**. The name, role badge and compact project tag share the first line;
the existing status icon and activity or assigned task appear underneath. Shortened names and
tags retain their full text on hover. Reuse observed status and assignment data; do not generate
activity summaries or infer a work timer from the session's age. Engine names belong in details.
Chat headings and quoted replies use the same current agent identity as the roster, including
older messages. When an agent has left, its recorded author name remains available in history.
Machine rows show **~** at the left, then the name the person gave the machine (else the
Swarm's name for it), owner avatar and status, with no chevron.
In the Swarm's views, a Mac and its Harness Team account are one row, and agents in that account
read as on the Mac. App-wide machine lists still show the team account as its own machine.
When teammates' agents cannot run on a machine, its row adds one line, such as
**Teammates' agents paused: privacy check failed**. There is no badge.
A click on the row expands it, and its labeled details are in the right-click menu (a long press
on a touch screen). Expanded, it shows agents with their names, role badges
and status, followed by known resources and model allowances. Offline machines stay in the
same list and omit stale readings. Rows share the projects' alignment and full-width highlight.
The stored `lead` and `builder` routing roles and native harness names remain compatible.
People, agents and machines belong to the Swarm. A project's **Public** visibility means everyone
in that Swarm; **Private** means its owner and explicitly invited project members. Swarms are
invite-only by default. Their owner can allow signed-in people with a chosen email domain or a
shared link to join as viewers or collaborators. Joining a Swarm does not grant access to its
private projects. Public discovery and a compute marketplace are outside this version.
Cmd-S opens the existing lead creation form for a new Swarm and its first project; **+ Project**
reuses that form inside the current Swarm. Store uses Cmd-Control-S. Existing ordinary tabs keep
their behavior. The internal `superTab` identifiers, `harness super-tab` protocol and stored account
settings remain compatible; the older internal `Swarm` layout class still represents an ordinary
tab. The word *tab* can also name the keyboard key or a browser tab; context
distinguishes them.

A project belongs to a computer; identical paths on different computers do not
identify the same project. Use the actual project or computer name when that
context matters. A plain terminal opens directly without an agent, project, or
task form.

## Action names

| Intent | Label |
| --- | --- |
| Start a running harness | **New Harness** |
| Create a group of harnesses | **New Tab** |
| Open a shell | **New terminal** |
| Manage a group of harnesses | **Rename Tab**, **Close Tab**, **Next Tab**, **Previous Tab** |
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
| First installed boot | **Connect to Wi-Fi** when disconnected, then the agent window. |
| USB session label | Omit from the single installation footer. |
| Connect another execution machine | **Connect a computer** |
| Installer title | Omit the redundant heading; label the action. |
| Installer fields | **Disk**, **Encryption**, **Password**, **Repeat password** |
| Installer action | **Install Harness** |
| Installation completion | **Harness is installed.** |
| Completion actions | **Shut down**, **Back to Harness** |
| Work offline during Wi-Fi setup | **Super+t** opens a terminal; no separate skip action. |
| Apply available OS/runtime releases | **Update** |
| Update needs a reboot | **Updated. Restart when ready.** |
| Update completion actions | **Done**, **Restart** |
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
| Swarm as a group of harnesses | **Tab** |
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
