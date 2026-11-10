# Agent Browser: a sandboxed Chrome beside a Swarm agent

**Status:** design, not built. Reviewed independently nine times on 2026-11-10; rewritten after the fifth and
corrected after each later one.
**Date:** 2026-11-10
**Scope of v1:** Desktop (macOS, Windows, Linux). The web and the phone come later; see the last section.

## Intent

A team wants Swarm agents to do work that lives in web apps, such as customer support in a shared Gmail inbox. The
Swarm v4 PM writes a skill for each area of the work, and each agent takes one area. For that, an agent needs a real
browser with four properties:

- it is logged in to the team's web accounts;
- it is kept apart from the person's own machine and browser;
- the agent can drive it on its own;
- a person can open it by hand to log in (password, 2FA), or to watch and take over.

The agent keeps running on the host as it does today, so it uses its person's own Claude or Codex subscription. Only
the browser runs in a container beside it.

This feature only builds the environment. What the agent does in the browser comes from its skill and
instructions: whether it reads, drafts or sends mail, and whether a person approves first.

## Goals

- **A checkbox.** The Swarm New agent form gets a **Browser** checkbox. When it is on, the agent gets its own
  container on the same machine. The container runs a browser, a VNC server, and Harness's own browser tool server on
  `playwright-core`, which the agent uses to drive the browser.
- **Set up in the product.** The container runtime is Podman, and only Podman. When the machine has none, Harness
  installs it after the person agrees once. The person never opens a terminal for it.
- **A button.** A **Browser** button sits next to Terminal in the agent's Swarm chat on Desktop. It opens the
  container's screen with noVNC. There the person logs in to Gmail or takes over by hand.
- **From any of the person's Desktops.** The screen travels over the same end-to-end encrypted transport as terminals:
  on a direct link when there is one, and through the relay when there is not. The container publishes no port.
- **The login lasts.** Restarting the container, the agent or the machine keeps the browser profile.
- **The agent asks for a person.** When a page wants a captcha, a 2FA code or a login, the agent asks its person
  and waits. The person opens Browser, does it by hand, and the agent goes on.
- **Its own network and look.** Each browser can have its own proxy, time zone, language, screen size and device,
  and it types and moves the mouse like a person.

## Non-goals

- The web client and the phone app in v1. Their design is kept in the last section.
- Running the agent (Claude Code or Codex) inside the container.
- Docker. Harness calls `podman` and nothing else, so there is one runtime and one code path.
- Installing Podman without the person's consent, at Harness setup, or on a machine the person is not sitting at.
- Removing or replacing a Podman the person already has.
- Gmail-specific code, customer-support logic, or the skills themselves. The PM writes those.
- Tools in the container beyond the browser, VNC and the browser tool server. One image serves every area of work.
- Playwright MCP (`@playwright/mcp`): the tools are Harness's own, on `playwright-core`.
- Sharing one browser between agents, or giving one agent several browsers.
- Browser agents started by the PM or the router. Only a person starts one, through New agent. That is how Swarm v4
  agents are created today.
- Solving captchas by itself or through a captcha service. A person solves them.
- A WireGuard or VPN exit for a browser. A proxy is the only network setting.
- Switches for WebGL, fonts, audio, the warning bar or a fake taskbar. They are fixed.
- The terminal interface (TUI), which is maintenance only.

## Anti-goals (a failure even if it works)

- A port on the host that a web page, another OS user or another container can reach.
- The person's own Chrome profile, files or keychain reaching the container.
- A browser that keeps running after its agent is deleted, or a login volume left behind forever.
- A Gmail login lost because the agent stopped or crashed, because another daemon cleaned up, or because the service
  started without a clear answer about which agents exist.
- A failure that leaves the button doing nothing, with no reason shown.
- Any change to agents that did not ask for a browser. Product rule: agents start as plain Claude Code or Codex.
- A slower terminal. Browser traffic must not delay terminal output or input on the same transport.
- Anyone but the machine's own person opening a browser: not Swarm teammates, and not a guest the machine is shared
  with.
- A changed Podman setup the person already had.
- A browser with a proxy set that ever connects from the machine's own address.
- A proxy password in a log, an agent frame, a process list or telemetry.
- An agent that waits for a person forever.

## What exists today (read 2026-11-10)

- **New agent form.**
  - `desktop/lib/super_tabs/new_agent.dart:20` `swarmNewAgent` offers Claude and Codex, on own machines only, using
    the generic `desktop/lib/widgets/new_harness_form.dart`.
  - The form's only checkbox is the Worktree `DesktopPill` (`:2457-2479`).
- **Agent chat header (Desktop).** `desktop/lib/super_tabs/view.dart:3896-3955` `_agentHeader` holds Instructions
  (`swarm-instructions-button`) and Terminal (`swarm-terminal-button`). Each opens a side panel, and they close each
  other.
- **Transport.**
  - Native Desktop carries no crypto. It talks plaintext to its own daemon over loopback
    (`cli/src/localWsServer.ts`), and that daemon terminates the end-to-end encryption for remote machines.
  - Terminals use JSON control frames plus binary frames. These go on a P2P direct link when one exists, otherwise
    through the relay. Only the types listed in `cli/src/lib/terminalP2p.ts:49-70` may cross the direct link.
  - The backend relay passes only known types and binary kinds (`backend/src/lib/terminalRelay.ts:4-15`,
    `backend/src/lib/terminalBinary.ts:34,58-61`, `backend/src/lib/adapterWs.ts:455-478`, `webWs.ts:664-675`).
    - It cannot read a stream id: that sits inside the ciphertext (`cli/src/lib/terminalBinary.ts:139-156`).
    - A frame over its rate budget is dropped without a word (`adapterWs.ts:457-466`).
    - The output budget is 8 MiB per busy stream per minute (`terminalRelay.ts:63-68`).
    - Its rate guard is one per machine socket (`adapterWs.ts:276`), not one per stream.
    - It writes one frame of its own, `terminal_transport_error`, to a client whose binary it refuses
      (`webWs.ts:675`). It tells a machine nothing when it drops that machine's output.
  - On the agent's machine, the choice between the direct link and the relay is made in the gateway
    (`cli/src/gateway/gateway.ts:427, 663, 908, 935, 1006`), in maps keyed on terminal frame names. The core does not
    know which route a stream took.
  - A frame the backend writes itself reaches a machine in plaintext, and the gateway accepts it only when its type
    is in `BACKEND_ONLY_DOWN_TYPES` (`cli/src/lib/relayFrames.ts:41`, checked at `gateway.ts:610`). The backend keeps
    the matching list so a client cannot forge one (`backend/src/lib/backendOnlyFrames.ts`).
  - The frame log leaves out a hand-written list of types (`cli/src/backendSocket.ts:1009`).
  - The frame lists that can change live in `cli/src/lib/e2ee/applicationFrames.ts` ("ONE place for every
    extension"). `lib/e2ee/core.ts` is pinned by hash and shared with other clients (`core.test.ts:234-246`), so it
    must not change.
  - The core-to-gateway link drops what would pile up (`cli/src/core/gatewayLink.ts:59,130-138`).
  - The existing `viewer_*` frames are an HTTP-shaped protocol that a viewing Desktop's daemon consumes
    (`remoteViewerProxy.ts:43-50`). They are not reused here.
- **Who is asking.** `Asker` in `cli/src/core/api.ts:620-632`.
  - `local` is a process on this machine.
  - `owner` is true for a local process, a paired app, or a verified machine share.
  - `accountOwner` is authority over the host account. The gateway sets it for a peer that is not shared
    (`cli/src/gateway/gateway.ts:202`, `role === 'web' && !!peer && !peer.shared`). Roles are only `web` and
    `device`, and the person's other machines are stored as `web` peers (`lib/e2ee/manager.ts:213, 812`). So
    another of the person's Desktops already has it, and a shared machine does not.
  - A guest arrives as a remote client and is refused by default, before any routing
    (`cli/src/backendSocket.ts:1046-1053`, `guestVerdict`).
  - `guest` is a share guest's account.
  - The `Asker` for a connection is built inline at `cli/src/backendSocket.ts:1118`.
- **Service answers** get about 30 seconds, unless the request is on `LONG_ANSWERS`
  (`cli/src/core/api.ts:773-793`, a map of service → request → milliseconds).
- **Webviews.** Desktop hosts pages with JavaScript channels (`web_pane_panel.dart:268` `addJavaScriptChannel`,
  `runJavaScript`), on `webview_flutter_wkwebview` (macOS), `webview_win_floating` 2.3.2 (Windows) and
  `webview_all_linux` (Linux). `webview_win_floating` has `loadRequest` and `loadHtmlString` only.
- **MCP at launch.** `cli/src/lib/machineMcp.ts:162-176` emits `--mcp-config=<json>` (Claude, one token) and
  `-c mcp_servers.*` (Codex) at create and at every relaunch (`create.ts:393-395`, `launchOverrides.ts:319`).
  - These servers carry no tool approval (`machineMcp.ts:10`).
  - At `create.ts:395` the agent has no id yet; it gets one at `:425`.
  - A pane's helper finds its agent by pane (`cli/src/agentClient/openUrl.ts:20`).
- **Agent end.** `core/agents/forget.ts:126` runs on every stop and crash. The real delete is the purge's `deleted`
  callback (`core/agents/lifecycle.ts:107`).
- **CLI shape.**
  - A new feature is a service, `cli/src/services/<name>.ts`, that reaches the core only through ports
    (`cli/AGENTS.md`, `src/services/AGENTS.md`). `src/architecture.spec.ts` enforces this.
  - Each user flow gets a real-daemon end-to-end test (`cli/AGENTS.md` rule 5).
  - The released CLI is one bundled file; extra files are embedded in it.
  - On Windows, processes start with `ownProcessGroup()`.
  - A tool's binary is found through the person's login-shell PATH (`lib/tmuxOnPath.ts:110`
    `resolveViaLoginShell`). Under launchd, `TZ` and `LANG` are unset.
- **Naming.** "Browser" already means "the optional browser for web content and visual review"
  (`docs/naming-system.md:69`), which today is the web pane.
- **Prior art:** `0x4123dev/ai-assitant-sanbox`, read 2026-11-10. Its container browser is close to this feature, for
  OpenClaw agents.
  - It runs Chromium or Chrome with Xvfb, x11vnc and noVNC under Podman, with one container and one named profile
    volume per agent, and installs Podman itself (`electron/sandbox-runtime/installer.ts`).
  - The agent drives the browser with `playwright-core` over CDP.
  - Around the browser it has settings per agent (`gateway-source/src/agents/sandbox/browser-settings.ts`), a proxy
    per agent with a relay that adds the proxy's login (`electron/browser/proxy-relay.ts`), human-like input
    (`gateway-source/src/browser/human-input.ts`), a device script
    (`gateway-source/scripts/sandbox-browser-inject.py`), and a hand-off to a person on a captcha
    (`docs/superpowers/specs/2026-11-01-captcha-handoff-design.md`).
  - Its remote noVNC path is not end-to-end encrypted. It publishes CDP on the host, and has no cleanup on delete,
    no orphan sweep and no health check.
  - Items taken from it are marked *(prior art)* below, with paths in that repo.

## Decided (in the 2026-11-10 brainstorm)

- A checkbox in New agent turns it on. The container runs on the same machine as the agent.
- The agent runs outside the container, so it uses its person's Claude or Codex subscription.
- The agent drives the browser with `playwright-core` and Harness's own tools, not Playwright MCP.
- The person logs in by hand through noVNC, opened from a button next to Terminal. The noVNC client is bundled in the
  app, not served by the container.
- Only the machine's own person can open a browser.
- The skill or instructions decide the behaviour (read, draft, send, approval), not this feature.
- The runtime is Podman only, because it is lighter. Harness installs it in v1, with the setup flow in Mockup 2.
- The product word stays **Browser**.
- Where the prior art has an answer, this design follows it as closely as it can: the settings per agent, the proxy
  and its exit-zone lookup, human-like input, the device script, and asking a person.
- Desktop first. The web and the phone come after it.

## Mockups

**1. Swarm New agent: a Browser pill next to Worktree, off by default**

```
┌──────────────────────────────────────────────────────┐
│  New agent                                           │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ Claude Code                              Agent │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │ support-inbox                          Project │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │ Ken Mac                                Machine │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ( ☐ Worktree )  ( ☑ Browser )                       │
│                    Needs setup · about 5 min         │
│                                         ( Start )    │
└──────────────────────────────────────────────────────┘
Tooltip on the pill: "A sandboxed Chrome the agent drives".
"Needs setup · about 5 min" shows only when this computer has no Podman.

The agent's machine is another of the person's computers, and it has no Podman:
   ( ☐ Browser )  dimmed, tooltip "Set up Browser on Ken Mac first"
```

**2. Setup: asked once, on Start, only at the computer being set up**

```
┌──────────────────────────────────────────────┐
│  Set up Browser                              │
│                                              │
│  Installs Podman on this computer to run     │
│  the agent's Chrome. Asks for your password  │
│  once. About 5 minutes, 1.5 GB.              │
│  Windows restarts once.     ← only when WSL 2 is missing
│                                              │
│                    ( Cancel )  ( Install )   │
└──────────────────────────────────────────────┘

After Install the agent is created at once, and the Browser panel shows progress:
┌─────────────────────────────────────┐
│ Browser                          ✕  │
│─────────────────────────────────────│
│   ✓ Podman installed                │
│   ◌ Starting Podman…                │
│   · Building browser                │
│   · Starting browser                │
└─────────────────────────────────────┘

Windows after WSL 2 is enabled:        Install failed or was cancelled:
┌───────────────────────────────┐     ┌───────────────────────────────┐
│  Restart Windows to finish    │     │  Podman didn't install        │
│  ( Later )  ( Restart )       │     │  ( Retry )                    │
└───────────────────────────────┘     └───────────────────────────────┘
```

**3. Desktop agent chat: Browser after Terminal; the screen in a side panel**

```
┌───────────────────────────────────────┬───────────────────────────────────────┐
│ [S] Support Mail  Ken Mac · Claude    │ Browser                 [⚙] [⎘]  ✕   │
│                        [≡]  [>_] [◉]  │───────────────────────────────────────│
│                        Instr Term Brw │ ┌───────────────────────────────────┐ │
│───────────────────────────────────────│ │ accounts.google.com/signin        │ │
│     ┌───────────────────────────────┐ │ │───────────────────────────────────│ │
│     │ Check the support inbox and   │ │ │   Google                          │ │
│     │ draft replies for today.      │ │ │   Sign in                         │ │
│     └───────────────────────────────┘ │ │   to continue to Gmail            │ │
│ ┌───────────────────────────────────┐ │ │  ┌─────────────────────────────┐  │ │
│ │ The browser isn't signed in to    │ │ │  │ Email or phone              │  │ │
│ │ Gmail. Please sign in from        │ │ │  └─────────────────────────────┘  │ │
│ │ Browser, then I'll start.         │ │ │                         [ Next ]  │ │
│ └───────────────────────────────────┘ │ │                                   │ │
│                      ┌─────────────┐  │ │   (noVNC: the person types here,  │ │
│                      │ Done.       │  │ │    the agent drives it too)       │ │
│                      └─────────────┘  │ └───────────────────────────────────┘ │
│ ┌───────────────────────────────────┐ │                                       │
│ │ Message Support Mail              │ │                                       │
│ └───────────────────────────────────┘ │                                       │
└───────────────────────────────────────┴───────────────────────────────────────┘
[◉] = globe icon, tooltip "Browser", selected while the panel is open. Only browser agents show it.
Browser, Terminal and Instructions close each other.
[⚙] = Browser settings.  [⎘] = Paste (sends the clipboard's text).  The screen is scaled to fit the panel.
```

**4. Panel states**

```
┌─────────────────────────────┐   ┌─────────────────────────────┐
│ Browser                  ✕  │   │ Browser                  ✕  │
│─────────────────────────────│   │─────────────────────────────│
│                             │   │                             │
│             ◌               │   │    Podman is not running    │
│     Starting browser…       │   │          ( Retry )          │
│                             │   │                             │
└─────────────────────────────┘   └─────────────────────────────┘
Other lines: see the Failures table.
```

**5. Browser settings: the gear in the panel's header**

```
┌─────────────────────────────────────────┐
│ Browser                    [⚙] [⎘]  ✕  │
│─────────────────────────────────────────│
│ ‹  Browser settings                     │
│                                         │
│ Proxy                                   │
│ ┌────────┐ ┌───────────────┐ ┌───────┐  │
│ │ SOCKS5▾│ │ host          │ │ port  │  │
│ └────────┘ └───────────────┘ └───────┘  │
│ ┌───────────────┐ ┌─────────────────┐   │
│ │ username      │ │ password        │   │
│ └───────────────┘ └─────────────────┘   │
│             ( Remove ) ( Test ) ( Save )│
│                                         │
│ Time zone        ( Auto            ▾ )  │
│ Language         ( vi-VN, en-US    ▾ )  │
│ Screen           ( 1920 × 1080     ▾ )  │
│ Human input      ( ☑ ) ( Normal    ▾ )  │
│                                         │
│ ▸ Advanced                              │
│   Device         ( ☐ ) GPU, CPU, memory │
└─────────────────────────────────────────┘
Test shows "Proxy works · 203.0.113.7 · Asia/Ho_Chi_Minh" or "Proxy is not reachable".
A saved password shows as dots and is never sent back to the app.
Saving a change that needs it restarts the browser; the login stays.
```

**6. The agent asks for a person**

```
Agent header, panel closed:            Panel open:
┌──────────────────────────────┐      ┌─────────────────────────────────────┐
│ … Ken Mac · Claude [≡][>_][◉•]│      │ Browser                 [⚙] [⎘]  ✕ │
└──────────────────────────────┘      │─────────────────────────────────────│
 • = a dot on the Browser button       │ Needs you: Google asks for a code   │
                                       │                           ( Done )  │
                                       │─────────────────────────────────────│
                                       │ ┌─────────────────────────────────┐ │
                                       │ │ (the screen)                    │ │
                                       │ └─────────────────────────────────┘ │
                                       └─────────────────────────────────────┘
The banner goes away when the person presses Done, when the page no longer asks, or when the wait runs out.
```

## Design (builder's calls, marked)

### Where the code lives

- **CLI** *(call)*: a new service, `cli/src/services/agentBrowser.ts`, with its parts in
  `cli/src/services/agentBrowser/`. It reaches the core only through a port, `AgentBrowserPort`:
  - the core tells it when an agent is attached, stopped or deleted;
  - it answers the app's `agent_browser_*` requests;
  - it supplies the agent frame's `browser` field.
  - It starts on demand, and also at daemon start when its state file exists.
- **Core** *(call)*: one small generic piece, `BrowserStreamManager`, beside `TerminalStreamManager`. Only the core and
  the gateway carry binary frames; a service link carries JSON only. All Podman logic stays in the service.
- **Desktop**: one Dart browser client in `desktop/lib/browser/`.

### Podman

- **One runtime** *(decided)*: Harness runs the `podman` command. It never runs `docker`.
- **Finding it** *(call)*: `resolveViaLoginShell('podman')`, then the installers' fixed locations:
  `/opt/podman/bin/podman` (macOS pkg), and `%ProgramFiles%\RedHat\Podman\podman.exe` (Windows MSI).
- **Version** *(call)*: Podman 4.6 or newer. An older one gives the state `podman_old`. Setup never replaces a Podman
  the person installed.
- **Memory** *(call)*: read from `podman info` on every OS. Less than 3 GB gives the state `podman_memory`: one
  browser is capped at 2 GB, and Podman needs room beside it.
  - This happens only with a machine the person made themselves, since Podman's own default is 2 GB. Harness does
    not change that machine. The message names what to do, and the person does it in Podman.
- **The Podman machine** (macOS and Windows, where Podman runs a Linux VM):
  - If the person already has a machine, Harness uses it as it is and changes none of its settings.
  - If there is none, setup creates one (see Setup).
  - A stopped machine is started by Harness (`podman machine start`) when a browser starts. If it will not start,
    the state is `podman_down`.
- **Availability request** *(call)*: `agent_browser_available` replies with one of:
  - `{state: 'ready'}`: `podman info` succeeds (5 s timeout, cached 60 s), and the version and memory are enough.
  - `{state: 'stopped'}`: Podman is installed and its machine is stopped. The form treats it as ready.
  - `{state: 'needs_setup', restart: boolean}`: there is no Podman. `restart` is true on Windows without WSL 2.
  - `{state: 'podman_old'}` or `{state: 'podman_memory'}`. The form treats these as ready too: the agent is created,
    and its Browser panel shows the failure with what to do.
  - An older CLI does not know the request. The client reads that as "not available".
  - The service may also be down or slow to start. The client then shows the pill disabled, with "Browser isn't
    available on <machine name> right now".

### Setup: Harness installs Podman

- **When** *(decided)*: only after the person presses **Install** in the dialog of Mockup 2, at the computer being set
  up. The daemon refuses `agent_browser_setup` unless `asker.local` is true.
- **From where** *(call)*: the official Podman release files, at one pinned version, with the SHA-256 of each file
  pinned in the CLI. A file that fails its checksum is deleted and setup fails. Downloads have a timeout.
- **Steps** *(call; prior art: `electron/sandbox-runtime/installer.ts`)*. The service records the current step in its
  state file, so setup resumes after a daemon restart or a Windows restart.
  1. **Install Podman** (step `installing`).
     - **macOS:** run the `.pkg` with `installer`, through `osascript … with administrator privileges`. That shows
       the system password dialog once (`installer.ts:846`).
     - **Windows:** one elevated script, behind one UAC prompt, does both things: it enables WSL 2 when it is missing
       (`wsl --install --no-distribution`), and installs the Podman MSI with `msiexec /qn /norestart`
       (`installer.ts:253-320, 853-856`). Both happen before any restart, so nothing asks for elevation afterwards.
       Every process starts hidden; the UAC prompt is the only window, and the person asked for it.
     - **Linux:** the distro's package through `pkexec` (`apt-get install -y podman uidmap slirp4netns`, or `dnf`,
       `pacman`, `zypper`; `installer.ts:863-886`). No VM is needed.
  2. **Start Podman** (step `starting_podman`; macOS and Windows): `podman machine init`, then `podman machine start`.
     - macOS: memory is half the host's RAM, at most 16 GB; CPUs are half the host's cores, at least 2.
     - Windows: no size is given, because a WSL machine ignores it. The machine is created `--rootful`, because a
       rootless machine on current WSL cannot apply memory, CPU or process limits (`installer.ts:938-973`).
  3. **Build the browser image** (step `building`; see The container).
  4. **Start the browser** (state `starting`).
  - **A first start on a machine that already has Podman** runs no setup, but it still has to build the image, which
    takes minutes. That browser shows `setup` with the step `building` until the image exists.
  - **The service resumes setup by itself**, but only where no password is needed: from `starting_podman` on, and
    from `restart_needed` once the machine has restarted. If it starts and finds the step `installing`, the install
    was cut off. It does not raise the password dialog on its own; the state becomes `podman_install_failed`, and the
    person presses Retry.
- **Windows restart.** Enabling WSL 2 may need a restart. The step becomes `restart_needed`. It is a step of setup,
  not a failure.
  - The service records the machine's boot time with the step. It goes on to step 2 only once the boot time has
    changed, so a daemon restart alone does not resume early.
  - **Restart** asks the daemon (`agent_browser_restart`, local askers only) to run `shutdown /r /t 10`, with the
    comment "Harness is restarting Windows to finish setting up Browser". **Later** leaves the step as it is.
  - After the restart, the daemon continues by itself. Nothing asks for elevation again.
- **The agent does not wait.** It is created as soon as the person presses Install. Its browser tools answer "Browser
  is being set up" until the browser is ready.
- **A browser agent on a machine with no Podman and no setup running** (the person cancelled, or the agent was
  created before Podman was removed) is in the failed state `needs_setup`. On that computer the panel offers
  **Install**, which opens the same dialog. On another Desktop it only says where to set it up.
- **No way to ask for the password:** the state is `podman_manual`. This covers Linux without `pkexec` or a known
  package manager, and a daemon with no desktop session (started over SSH), where the dialog cannot show.
- **Cancelled or failed:** the state is `podman_install_failed`. **Retry** is offered on that computer only, and
  starts from the recorded step.
- **Capacity promise.** Contributed capacity should work within 5 minutes. Setup runs only for a person who ticked
  Browser, and a machine without it keeps working for every other agent.

### The container

- **Image** *(call)*: one image, `harness-browser`, built locally. There is no registry, so no new hosted service
  (standard 9).
  - The Containerfile and its files are embedded in the CLI bundle. The build writes them to a temporary context dir
    and runs `podman build`.
  - Build rules *(prior art: `gateway-source/src/agents/sandbox/browser-image.ts:532-612`)*: a real context dir,
    never stdin; no cache mounts; one build at a time per daemon; a test that keeps the embedded copies equal to the
    files.
  - **Tag** *(call)*: `harness-browser:<hash of the embedded files>-<ISO year and week>`.
    - The tag is checked each time a browser starts. There is no timer.
    - A new CLI that changes the files, or a new week, builds a new image in the background. The browser that
      triggered it starts on the image that exists. A failed background build is logged and does not fail a browser.
    - A container moves to the newest image at its next start: it is created again, and the volume stays.
    - After a successful build, older `harness-browser` tags that no container uses are removed. So at most two images
      exist at a time.
    - The weekly rebuild keeps Chrome current. A stale Chrome is a sign Google checks.
  - **Base:** Debian trixie, pinned by digest. The build runs `apt-get upgrade`.
  - **Browser** *(prior art: `Dockerfile.sandbox-browser:31-42`)*: Google Chrome stable on amd64. On arm64, Google
    Chrome if a Linux arm64 build exists when this is built, otherwise Debian's `chromium`. The spike records which.
  - **Also installed:**
    - TigerVNC's `Xvnc`: the X server and the VNC server in one process. Its extended clipboard carries UTF-8, which
      noVNC supports, so pasting Vietnamese and emoji works.
    - openbox.
    - `socat`.
    - A PulseAudio null sink, so the browser has a speaker.
    - Fonts: DejaVu, Liberation, Noto, Noto CJK, Noto Color Emoji.
    - Node, a pinned `playwright-core` (no bundled browsers: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`), and Harness's
      files in `/opt/harness-browser/`: the tool server, the proxy relay and the device script.
  - **Baked in:** the managed browser policy `CommandLineFlagSecurityWarningsEnabled: false`, because the root
    filesystem is read-only at run time. It goes in both policy folders: `/etc/opt/chrome/policies/managed` for
    Chrome and `/etc/chromium/policies/managed` for Chromium.
  - The browser runs as a non-root user. The profile mount point has mode 1777, so rootless Podman's user mapping can
    still write it *(prior art: `Dockerfile.sandbox-browser:51-52`)*.
  - **No noVNC or websockify in the image.** The prior art serves them on port 6080. Here the noVNC client is
    bundled in the app, and `podman exec … socat` carries the VNC stream.
- **Entrypoint** *(prior art: `gateway-source/scripts/sandbox-browser-entrypoint.sh`)*:
  - Delete `SingletonLock`, `SingletonSocket` and `SingletonCookie` from the profile on every start. A lock left by an
    earlier container makes the browser refuse the profile.
  - `Xvnc :1 -geometry <screen> -depth 24 -localhost -rfbport 5900 -SecurityTypes None -AlwaysShared`. There is no
    VNC password: nothing outside the container can reach port 5900.
  - Browser flags (the prior art's set at `:103-159`, minus its options):
    - `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222`. Nothing forwards it.
    - `--user-data-dir=<profile>`
    - `--window-position=0,0 --window-size=<screen>`
    - `--no-first-run --no-default-browser-check`
    - `--no-sandbox --disable-setuid-sandbox --no-zygote`: the browser's own sandbox cannot run in an unprivileged
      container.
    - `--renderer-process-limit=2`
    - `--use-angle=swiftshader --enable-unsafe-swiftshader`: a browser without WebGL looks automated.
    - `--disable-breakpad --disable-crash-reporter --metrics-recording-only --disable-features=TranslateUI`
    - `--disable-extensions`
    - `--disk-cache-size=524288000`
  - Never `--headless` or `--enable-automation`, so `navigator.webdriver` stays false.
  - The screen size, `TZ`, `LANG`, `--lang` and `--accept-lang` come from the agent's settings.
  - openbox runs as the window manager *(call)*, detached so its exit does not end the container. Without one, a
    sign-in popup opens undecorated at 0,0 and cannot be moved or closed by hand. PulseAudio is detached too.
  - **Ready** means CDP answers `/json/version` and port 5900 accepts a connection. The entrypoint checks both, with
    a bound, then writes a ready marker. When the service starts a browser it looks for the marker once a second for
    at most 60 s. After that nothing polls.
  - The entrypoint ends with `wait -n` on the browser and Xvnc *(prior art: `:215`)*. The container exits when either
    exits, including when a person closes the browser's last window. The service then restarts it.
  - Named exit codes: 3 when the profile dir is not writable (`profile_unwritable`), 4 when the proxy cannot be
    used at start (`proxy_failed`). These two go straight to Failed; the service does not restart the container for
    them. The prior art falls back to a throwaway profile, which would silently lose the login.
- **Names and labels** *(call)*: one container per agent, named `harness-browser-<agentId>`, with the labels
  `harness.agent=<agentId>`, `harness.daemon=<this daemon's data-dir id>` and `harness.settings=<settings hash>`. A
  dev or test daemon beside the installed one never touches containers that are not its own.
- **Profile** *(call)*: a named volume `harness-browser-<agentId>`, with the first two labels, mounted at the profile
  dir.
- **No published ports** *(call)*: the container publishes nothing on the host. The daemon reaches VNC, and the
  agent's relay reaches the tool server, only through `podman exec`.
- **Network** *(call)*: one bridge network per running container, so one browser cannot reach another container.
  - The network is created when the browser starts and removed when it stops. Podman's default pool holds about 256
    networks, and stopped browsers must not use them up.
  - A page can reach the host's address. This is accepted and stated. The daemon's loopback socket refuses any
    request that carries an `Origin` (`cli/src/localWsServer.ts:343-353`).
  - The browser can reach the internet and the local network, as any browser on that network can. Also accepted.
- **Hardening** *(call)*: `--cap-drop ALL --security-opt no-new-privileges --read-only`. No host folder is mounted.
  - tmpfs mounts, each with a size, all counted inside the memory cap: `/tmp` 256 MB, the user's `HOME` 256 MB,
    `/var/tmp` and `/run` 16 MB each.
- **Limits** *(call)*: `--memory 2g --cpus 2 --pids-limit 512 --shm-size 1g`.
  - *(prior art: `docker.ts:736-800`)* If Podman refuses a limit (rootless on cgroup v1, or a rootless machine the
    person already had on WSL), the container is created again without that limit. A warning is logged and
    `browser.limit_dropped` is emitted.
- **How many** *(call)*: a daemon runs at most `min(8, floor((Podman's memory − 1 GB) / 2 GB))` browsers at once, and
  at least 1. Stopped browsers do not count.

### Lifecycle

- **State file.** The service keeps `<data dir>/agent-browser.json` (mode 0600). It lists every browser this daemon
  created with its settings, any delete in progress, and the setup step.
  - A missing file is an empty one.
  - A file that exists and cannot be read is a failure with a name, `state_unreadable`. The service removes nothing
    and starts no browser, and every browser agent's frame shows that state, until a person fixes or removes the
    file. It never treats a broken file as empty.
- **Agent starts:** the service starts Podman's machine if it is stopped, then creates the container or starts the one
  that exists.
- **Agent stops or crashes:** the container stops and its network is removed. The volume stays, so the login survives
  a resume.
- **Container exits unexpectedly** (seen on the event stream below):
  - the service restarts it, at most 3 times in a row with backoff;
  - the count resets after 10 minutes in Ready, so a person closing the browser's window now and then never reaches
    the limit;
  - after 3 in a row the state is `browser_stopped` until the person presses Retry;
  - an exit the service itself asked for (stop, delete, a settings change, a move to a new image) is not counted.
- **Agent deleted** (the purge's `deleted`): the delete is written to the state file first. Then the container, volume,
  network and proxy secret are removed, and the entry is cleared.
- **Service starts** (daemon start, or first use):
  - it finishes any delete in progress;
  - it asks the core for its live and stopped agents. Only when the core answers does it delete, for every browser in
    the state file whose agent is not in that answer, the container, volume and network. This covers an agent deleted
    while the service was down.
  - No answer, or a failed one, deletes nothing. An empty list is believed only when the core gave it.
  - Containers labelled with this daemon that are not in the state file are removed. Their volumes are not.
- **Health** *(call)*: one `podman events` stream per daemon, filtered by `label=harness.daemon=<id>` and the
  container-exit event, restarted with backoff if it drops. Each time it reconnects, the service runs one
  `podman ps` to catch exits it missed. Nothing polls on a timer.

### How the agent drives it

- **No Playwright MCP** *(decided)*. The tools are Harness's own small tool server, built on `playwright-core`
  *(prior art: OpenClaw's browser tool, `gateway-source/src/browser/pw-session.ts`, `pw-role-snapshot.ts`,
  `pw-tools-core.interactions.ts`, on `playwright-core` 1.58.2)*. Claude Code and Codex take tools only through MCP,
  so the agent still reaches it as an MCP server.
- **Tool server** *(call)*: `browser-tools.mjs`, a stdio MCP server in the CLI's assets, copied into the image.
  - It runs inside the container as `node /opt/harness-browser/browser-tools.mjs`, and exits when its stdin closes.
  - It connects with `chromium.connectOverCDP('http://127.0.0.1:9222')` and keeps the current tab.
  - Connection handling, copied from the prior art (`pw-session.ts:368-426, 641-705`):
    - at most 3 connect attempts, with timeouts of 5 s, 7 s and 9 s and a backoff of 250 ms plus 250 ms per attempt;
    - one shared pending connect, so concurrent calls never open two connections;
    - on `disconnected`, the cached connection is dropped and the next call reconnects;
    - every CDP command has its own timeout.
  - **Tools:**
    - `browser_navigate {url}`
    - `browser_back`
    - `browser_snapshot`: the page's role snapshot (`ariaSnapshot`), with refs like `e12`
    - `browser_click {ref}`
    - `browser_type {ref, text, submit?}`
    - `browser_press {key}`
    - `browser_select {ref, values}`
    - `browser_scroll {dy}`
    - `browser_screenshot`: a JPEG image
    - `browser_tabs {action: list|new|select|close, index?}`
    - `browser_wait {text? | ms ≤ 30000}`
    - `browser_ask_person {reason, minutes?}` (see Asking a person)
  - **Refs** are role refs: they come from `ariaSnapshot()` and resolve through `getByRole(role, {name})` plus an
    index (the prior art's "role" mode). Only public `playwright-core` API is used, never `_snapshotForAI`.
  - **Timeouts:** every tool call has one (20 s default, navigation 60 s). A stale ref returns "Element not found;
    take a new snapshot".
  - **One source of truth:** the tool definitions live in `browser-tools.json`, embedded both in the relay and in the
    image.
- **MCP server** *(call)*: each browser agent gets an MCP server named `browser`. Its command is
  `harness browser-mcp`, a stdio relay inside the CLI, with no arguments.
  - It finds its agent by its pane, as `openUrl.ts:20` does. So the launch arguments are the same for every agent.
  - It answers `initialize` and `tools/list` itself, from `browser-tools.json`. The agent always starts with its
    browser tools, and nothing waits on Podman.
  - For a call, it asks its daemon for the browser's state (`agent_browser_state`, local askers only). The reply
    carries the agent id, the state, the `podman` path and the human-input setting.
  - When the state is ready, it runs `podman exec -i harness-browser-<agentId> node
    /opt/harness-browser/browser-tools.mjs`. The exec starts on first use, and starts again after a container
    restart. The relay passes the human-input setting with each call, so a change applies to the next call.
  - While the browser is not ready, a call returns the named reason ("Browser is being set up", "Browser is
    starting", "Podman is not running"…), so the agent can tell its person.
  - The tools are `mcp__browser__…`.
- **Why CDP into the running browser:** the person logs in to the same browser the agent uses; Google's sign-in is
  less likely to refuse a browser that was not launched as automated; and CDP stays inside the container.
- **Who gets it** *(call)*: the agent's registry row carries `browser: true`. The MCP arguments are added at create
  and at every relaunch, the way machine MCP servers are, only for those agents.
- **Approval** *(call)*: the agent's browser tools must run without a prompt, or the agent cannot work on its own.
  - The plan checks what a Swarm agent's default approval mode (`auto`) does for MCP tools, in Claude and in Codex.
  - If a mode would prompt, the launch adds an allow rule for the `browser` server only: Claude
    `--allowedTools=mcp__browser` as one token, and Codex's equivalent.
- **Tool timeouts** *(call)*: asking a person can take 30 minutes, so the engine must not cut the call short.
  - Codex gets `-c mcp_servers.browser.tool_timeout_sec=1900`; its default is far shorter.
  - The spike measures both engines' limits for a stdio tool call of 30 minutes, and the launch sets what each
    needs, as an argument or as an environment variable.

### Human-like input *(prior art: `gateway-source/src/browser/human-input.ts`)*

- The tool server moves the mouse along a curved path to a random point inside the target, and types with a short,
  uneven pause between keys. Every duration is drawn from a log-normal range, never a fixed or uniform one.
- It is on by default. The setting has three speeds: Slow, Normal, Fast.
- The randomness goes through one injectable source, so tests are exact.
- It lives in `human-input.mjs`, in the container. Nothing outside the tool server changes.

### Asking a person *(prior art: `2026-11-01-captcha-handoff-design.md`)*

- **The tool** *(call)*: `browser_ask_person {reason, minutes?}`. `reason` is one short line the agent writes, such
  as "Google asks for a code". `minutes` defaults to 15 and is at most 30.
  - It returns when one of three things happens: the person presses **Done** (`done`); a challenge that was detected
    is gone (`cleared`); or the time runs out (`timeout`).
  - The agent decides what to do after a timeout. It never waits past 30 minutes.
- **Who ends the wait:**
  - The relay asks its daemon with `agent_browser_ask {agentId, reason, minutes}`. That request is on the core's
    long-answer list for 31 minutes, and the relay waits as long. The daemon answers `done` or `timeout`, or `ended`
    when the relay itself ended the ask.
  - When the last tool reply carried a challenge, the relay also asks the tool server to watch it. The tool server
    looks every 3 seconds and answers `cleared` when it is gone.
  - The relay returns whichever comes first, and tells the daemon the ask has ended
    (`agent_browser_ask_end {agentId}`), so the banner goes away.
  - If the daemon restarts while an ask is open, the relay's request fails. The tool then returns `timeout`, with the
    line "Browser lost its connection; ask again".
- **Detection** *(call)*: after `browser_navigate`, `browser_click`, `browser_type` and `browser_snapshot`, the tool
  server checks the page for a visible challenge and adds `challenge: <kind>` to the tool's reply, with the line
  "This page asks for a person. Call browser_ask_person and do not act on the challenge."
  - The signs are the prior art's: a visible frame or element of reCAPTCHA, hCaptcha, Cloudflare Turnstile, DataDome,
    PerimeterX, Arkose or AWS WAF.
  - Only visible elements with a size count. The word "captcha" in a page's text does not.
  - For reCAPTCHA, only the challenge frame counts (its `bframe`). The badge of an invisible reCAPTCHA is on the page
    all the time and is not a challenge.
- **Telling the person** *(call)*:
  - The agent frame's `browser` field gains `asking: {reason}`. Desktop shows a dot on the Browser button, and a
    banner with **Done** in the panel (Mockup 6).
  - Desktop posts its usual local notice, "<agent> needs you in Browser".
  - A person away from their Desktop hears about it through the agent's own Swarm message, which reaches the phone
    like any other. The tool's description tells the agent to tell its person in chat when it asks. This one rule is
    in the tool's text, not in code, because delivery and push belong to Swarm, and this feature must not post as the
    agent.
  - One ask per agent at a time. A second call while one is open joins it.
- **Done** sends `agent_browser_done {agentId}`. The same people who may open the browser may press it.
- **The reason** is the agent's own text. It is shown as plain text, at most 120 characters, and is never logged or
  measured.

### Settings per agent *(prior art: `browser-settings.ts`)*

- **Why there are settings at all.** Standard 1 says the product should not push a choice onto the person. These
  follow the prior art by the person's decision: a browser that must pass as someone's own needs their zone,
  language, screen and device, and the product cannot guess those.
- **Where they are kept** *(call)*: in the service's state file on the agent's machine, under the agent's id. They are
  never synced and never sent to the backend.
- **What can be set** (Mockup 5):

  | Setting | Values | Default |
  |---|---|---|
  | Proxy | scheme (HTTP, HTTPS, SOCKS5), host, port, username, password | none |
  | Time zone | Auto, or an IANA zone | Auto |
  | Language | a list such as `vi-VN, en-US` | the machine's |
  | Screen | 1920×1080, 1680×1050, 1536×864, 1440×900, 1366×768 | 1920×1080 |
  | Human input | on or off; Slow, Normal, Fast | on, Normal |
  | Device (Advanced) | off, or a GPU name, CPU cores and memory to report | off |

  - The machine's zone and language come from the daemon's `Intl.DateTimeFormat().resolvedOptions()` (`timeZone` and
    `locale`). Under launchd `LANG` is unset and the locale may come out as plain `en-US`; that is then the default,
    and the person changes it here.
  - **Auto time zone** is the proxy's exit address's zone when a proxy is set, and the machine's zone otherwise.
  - **Device** *(prior art: `gateway-source/scripts/sandbox-browser-inject.py`)*: a small standing process in the
    container, `device-inject.mjs`, started by the entrypoint with the browser when Device is on.
    - It holds its own CDP connection, attaches to every page, frame and worker as it is created
      (`Target.setAutoAttach`, paused at start), and adds the script before the first line runs.
    - So it covers a page a person opens before the agent ever calls a tool.
- **Applying them:**
  - Human input applies to the next tool call.
  - Every other change creates the container again. The volume stays, so the login stays.
  - The container's `harness.settings` label holds a hash of everything except human input. A start compares it and
    creates the container again when it differs.
- **Requests** *(call)*: `agent_browser_settings {agentId}` reads them, `agent_browser_settings_save {agentId,
  settings}` writes them, and `agent_browser_proxy_test {agentId, proxy}` tests a proxy. All three are refused unless
  the caller may open the browser.
  - The password is write-only. A read returns `passwordSet: true` and never the password.
  - Saving with no password field keeps the stored one.

### Proxy *(prior art: `electron/browser/proxy-relay.ts`, `pool.ts:67-134`)*

- **A relay inside the container** *(call)*: `proxy-relay.mjs`, started by the entrypoint before the browser when a
  proxy is set.
  - The browser gets `--proxy-server=http://127.0.0.1:<relay port>` and
    `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
  - The relay adds the proxy's login to every request it forwards. Chrome cannot take a proxy's login on its command
    line.
    - HTTP and HTTPS proxies: CONNECT tunnels and plain HTTP, ported from the prior art.
    - SOCKS5: a handshake with username and password. The prior art's relay has no SOCKS5, so this part is new. It
      sends the host name to the proxy and never resolves it locally, so DNS goes out through the proxy too.
  - **Fail closed.** The relay connects to the proxy and to nothing else. An unreachable proxy or a refused login
    gives the page an error, never a direct connection.
  - **At start** the relay makes one request to the exit lookup through the proxy, with the proxy's login.
    - If the proxy cannot be reached or refuses the login, the entrypoint exits with code 4, the browser does not
      start, and the state is `proxy_failed`.
    - Any answer that comes back through the proxy passes, whatever the lookup service itself says. The lookup
      service being down or refusing must not look like a broken proxy.
  - **Later**, a proxy that stops answering gives each page an error. The browser stays up, and the state does not
    change.
- **The password** reaches the container as a Podman secret, never as an environment variable or an argument.
  - The secret is named `harness-proxy-<agentId>`, created from stdin, and mounted with
    `--secret harness-proxy-<agentId>,target=harness-proxy`, so the relay always reads `/run/secrets/harness-proxy`.
  - A changed password replaces the secret (`podman secret create --replace`).
  - The secret is removed with the container.
- **Test** runs from the agent's machine: it asks an address-lookup service through the proxy for the exit address
  and its time zone, with a 15 s timeout.
  - The service is the prior art's, with the address added to what it returns:
    `http://ip-api.com/json/?fields=status,timezone,query` (`electron/browser/chrome-engine/pool.ts:67`).
  - The lookup works through all three kinds of proxy. The prior art's own lookup skips SOCKS5, so that part is new;
    it shares its SOCKS5 handshake with the relay. It is an outside service this feature depends on, so the PR
    justifies it (standard 9). It is called only through the person's own proxy, and receives nothing from Harness
    beyond the request itself.
  - The same lookup sets the Auto time zone when a browser with a proxy starts. If it fails, the zone is the machine's
    and a warning is logged.

### How a person sees it: the same transport as terminals

1. **The page** *(call; prior art: `electron/remote/sandbox-viewer.ts:43-165`)*.
   - One self-contained HTML file, `browser_viewer.html`: the viewer and a pinned noVNC, bundled into a single
     classic script and inlined. A build script generates it and the result is committed.
   - It has no imports and no other files, so `loadHtmlString` loads it on every native webview, where a folder of ES
     modules would not load.
   - Its channel object carries the properties noVNC's `Websock` checks, including `protocol`
     (`websock.js:39-48, 259-263`).
   - The screen is scaled to fit the panel.
   - **Keys.** On macOS, ⌘+letter is sent as Ctrl+letter, and ⌘ itself never reaches the remote. On Windows and
     Linux, Ctrl+V becomes a paste.
   - **Paste** sets the remote clipboard over the UTF-8 extended clipboard, then sends Ctrl+V. **Copy** brings the
     remote selection back.
2. **The bridge**: noVNC's `RFB` takes a channel object instead of a URL. The page gives it one that passes raw RFB
   bytes to Dart through the webview's JavaScript channel (`addJavaScriptChannel` / `runJavaScript`). The bridge's
   cost is not known yet; see The spike.
3. **The stream** *(call)*: a terminal-like stream, not the HTTP-shaped `viewer_*` protocol.
   - **Control frames:** `agent_browser_open` (with the agent id), `agent_browser_open_result`,
     `agent_browser_ack` and `agent_browser_close` (with a reason), as JSON.
     - They are added to `applicationFrames.ts` (never to the pinned `core.ts`), to the P2P lists in
       `terminalP2p.ts`, and to the backend relay's allowlists.
     - The relay passes only known types, so the backend ships first.
     - `browser_open` is already taken: a pane's `BROWSER` shim uses it to open a URL (`openUrl.ts:29`).
   - **Bytes:** a new binary kind, `browser = 8`, beside the terminal's, in both directions. It goes on the direct
     link when there is one, otherwise through the relay. No base64 on the wire.
   - **One route per stream** *(call)*: the gateway chooses the route when the stream opens, and tells the core which
     it chose: `direct` (peer to peer), `turn` (a direct link through a TURN server, which is billed per GB), or
     `relay`. The stream never moves.
     - Terminal streams are moved between routes by three pieces of code on the viewing side
       (`remoteRelay.ts:1113-1140, 1203, 1310-1350`) and two on the agent's side (`gateway.ts:427-433, 935-966`).
       Browser streams are kept out of all five: they are tracked in their own set, never in the terminal's.
     - A `turn` route is paced and counted like the relay, because it costs money too. Today only the viewing side
       can tell TURN from a true direct link (`terminalP2p.ts:333`, `remoteRelay.ts:1077`); the agent's side gains the
       same reading, and a link it cannot classify counts as `turn`.
     - A panel on the agent's own computer does not go through the gateway at all. Its stream is `direct`.
   - **Every way a terminal stream ends, a browser stream ends too**: the client disconnects, the link goes down, or
     the local window closes (`backendSocket.ts:446-453, 465-471, 805-810`). Each kills the exec.
   - **Close reasons:** `closed` (the client closed it), `agent` (the agent stopped or was deleted, or the browser
     exited), `rate`, `backlog` and `route`.
     - A terminal survives a move through its resync and keyframe. VNC has neither, so a moved stream would corrupt.
     - When a stream's route goes away (the direct link drops), the stream is closed with reason `route`. The panel
       reconnects by itself, once, and the new stream takes whatever route exists then.
     - A stream on the relay does not move to a direct link that appears later. Closing and reopening the panel
       picks it up.
   - **Nothing is dropped silently.** A dropped chunk corrupts the VNC stream, so:
     - the backend gives browser bytes their own rate budget, apart from the terminal's. The budget is per machine,
       because the backend's guard is per machine socket;
     - the agent's daemon paces the total of the browser bytes it sends through the relay, across all its browsers
       and viewers, to stay under that budget. Streams on a direct link are not counted;
     - if the backend still has to refuse a machine's browser frame, it cannot name the stream, because the stream id
       is inside the ciphertext. It sends that machine a frame of its own,
       `agent_browser_transport_error {code: 'RATE'}`. The type goes on both backend-only lists, so a client cannot
       forge it. The machine then closes every browser stream it is sending through the relay, each with
       `agent_browser_close {reason: 'rate'}`. The backend sends the frame for each browser frame it drops, at most
       once a second, so a stream opened later is told too;
     - the stream's control frames have a budget as well, and a refused one is answered the same way. An
       `agent_browser_ack` that never arrives must not leave an exec paused for ever: a stream whose credit stays
       used up for 10 seconds is closed with reason `backlog`;
     - a client's own browser bytes (keys and mouse) have a small budget of their own, apart from terminal paste. A
       client over it gets the same frame, as it gets `terminal_transport_error` today, and closes its streams;
     - when the core-to-gateway link would pile up, the browser frame is dropped like any other, and that stream is
       closed with reason `backlog`. A frame the gateway itself cannot send (no session, or the relay socket closed)
       closes the stream with reason `route`;
     - the panel shows "Browser is slow here" with **Retry**, which reconnects.
   - **Terminals come first.** An echo must not wait behind browser bytes.
     - The means is a small credit window: at most one window of browser bytes can be ahead of an echo.
     - Reordering a queue cannot do more, because bytes already in a socket cannot be overtaken.
     - The spike measures echo p95 against window sizes. If no window keeps the echo inside its limit while the screen
       is still usable, browser bytes get their own P2P data channel and their own relay socket, and this spec is
       revised before the stream is built.
   - **Flow control:** credit-based, acknowledged with `agent_browser_ack`. The window size and the budgets come from
     The spike.
   - **The viewing Desktop:** its own daemon terminates the encryption and passes browser frames to the app over
     loopback, as it does for terminal frames. When the agent is on the same machine, that daemon serves the stream
     itself.
   - **The agent's machine:** `BrowserStreamManager` refuses `agent_browser_open` unless all of these hold:
     - the caller is the machine's own person, meaning `asker.local` or `asker.accountOwner === true`. The gateway
       already sets `accountOwner` for the person's other Desktops and not for a shared machine, so no gateway change
       is needed;
     - the caller is not a guest (`asker.guest` is unset). A verified machine share has `owner` true and must still
       be refused;
     - the agent has a browser and it is ready.
   - **Guests** are refused twice: the guest policy refuses every `agent_browser_*` frame and request by default,
     before routing, and the check above refuses them again.
   - It then asks the service's port for the exec command and pipes
     `podman exec -i harness-browser-<agentId> socat STDIO TCP:127.0.0.1:5900`: one exec per open viewer, at most 4
     per browser.
   - The stream exists only while a panel is open. Closing the panel, or losing the connection, ends the exec.
   - The page asks for Tight encoding at quality 6 and compression 2.

### The spike (before anything else is built)

Unknowns that decide whether this design holds. One throwaway spike measures them first, on macOS, Linux and Windows:

- **The bridge.** How many bytes per second pass through a JavaScript channel as base64 JSON, on each Desktop
  webview, and what it costs the UI thread. Also that `loadHtmlString` loads the page on each.
- **The stream.** How many bytes per second noVNC needs at Tight, quality 6, while Gmail scrolls at 1920x1080.
- **The echo.** Terminal echo p95 while the stream runs, at several credit window sizes, on a direct link, through
  TURN, and through the relay.
- **Approval.** Whether Claude Code and Codex prompt for an MCP tool in a Swarm agent's default mode.
- **The engines.** Whether Claude Code and Codex each wait 30 minutes on one stdio tool call.
- **Podman.** That the facts this design leans on are true under Podman on each OS:
  - `--read-only` with these tmpfs mounts runs Chrome;
  - a secret mounts under `--read-only` with a tmpfs on `/run`;
  - the exit event's name and JSON shape;
  - the limits apply;
  - `podman exec -i` carries binary stdio;
  - the TigerVNC flags work, and `Xvnc` types characters its keyboard map lacks into Chrome.

The spike's numbers set the relay budget, the credit window and the pacing. It also reports what one viewer costs
the relay per open minute, because backend cost per Swarm must fall as Swarms grow; that number is agreed before the
stream is built. If the bridge cannot carry the stream, no window protects the echo, or an engine cannot wait, the
design changes first and this spec is revised.

### The person's view on Desktop

- **Swarm New agent form** (only the `swarmNewAgent` integration, not other New harness forms):
  - a **Browser** pill next to Worktree, with the tooltip "A sandboxed Chrome the agent drives";
  - when the form targets a machine, it asks that machine's daemon `agent_browser_available`;
  - `ready`, `stopped`, `podman_old` or `podman_memory`: the pill works;
  - `needs_setup` and the machine is this computer: the pill works, the line "Needs setup · about 5 min" shows under
    it, and **Start** opens the Set up Browser dialog;
  - `needs_setup` on another computer: the pill is disabled, with the tooltip "Set up Browser on <machine name>
    first";
  - no answer (older CLI): the pill is disabled, with the tooltip "Update Harness on <machine name> first".
- **Agent header:** a **Browser** icon button after Terminal in `_agentHeader` (`swarm-browser-button`,
  `AppIcons.globe`, tooltip "Browser"). It opens a side panel with the page in the native webview. Browser, Terminal
  and Instructions each close the others. A dot shows on it while the agent is asking.
- **Panel header:** a gear for Browser settings (Mockup 5), Paste, and close.
- **Which agents:** the button shows for a browser agent on one of the person's own machines (a machine that is not
  shared with them). An older CLI never sends the `browser` field, so no button appears.
- **Not on the web build.** `desktop/lib` is also built for the web. There the pill and the button are not drawn at
  all in v1.
- **The agent frame** gains `browser: {state, step?, error?, asking?}`, sent only when it changes. It never carries
  settings.
  - `state` is `setup`, `starting`, `ready` or `failed`.
  - `step` (during `setup`) is `installing`, `starting_podman`, `building` or `restart_needed`.
  - `error` (during `failed`) is a named state from the Failures table.
  - `asking` is `{reason}` while the agent waits for its person.
- **Naming.** `docs/naming-system.md` gains one line: an agent's Browser is that agent's own Chrome; a web pane shows
  one address.

### Security

- **Nothing on the host network.** VNC and CDP are reachable only through `podman exec`.
- **Viewing is protected by** the end-to-end encrypted transport, plus the agent machine's check that the caller is
  the machine's own person and not a guest.
- **Who can read the profile.** Any process running as the person can `podman exec` into the browser and read its
  session cookies. That includes the person's other agents on that machine. This is accepted and stated: those
  agents run as the person and can already read the person's own browser and files. The machine is the person's
  own, because New agent places agents on own machines only. Rootless Podman gives no other OS user access.
- **Setup runs with administrator rights once**, for the official installer only. The files are checked against
  pinned SHA-256 values first. Only a local asker can start setup or a restart.
- **The proxy password** is stored in the service's 0600 state file and handed to the container as a Podman secret.
  It is write-only for the app, and it never appears in a log, a frame, an argument or a measure. Every
  `agent_browser_*` type is left out of the frame log, because the settings requests carry the password and the ask
  request carries the agent's reason. That covers all three places frames are logged: incoming frames
  (`backendSocket.ts:1009`), replies (`:948`), and the local and web logs (`:616-679`), which would otherwise carry
  the proxy's host and the reason inside the agent frame.
- **A page cannot press Done.** Only a caller who may open the browser can end an ask.
- **The Gmail password** is typed by a person into noVNC. It never passes through Harness, the agent, logs or
  telemetry. Typed and pasted text travels only inside the encrypted stream and never appears in argv or logs.
- **Mail content** the agent reads is data, not instructions (standard 7). The skill must say so.

### Failures

Each has a name, a log line and a state in the panel (standard 6). All are `error` values of a `failed` browser,
except the two the form shows before an agent exists.

| Failure | Named state | What the person sees |
|---|---|---|
| No Podman, seen from another computer (form) | — | Pill disabled, "Set up Browser on <machine> first" |
| Older CLI (form) | — | Pill disabled, "Update Harness on <machine> first" |
| No Podman and no setup running | `needs_setup` | "Browser isn't set up" + Install (on that computer) |
| Install cancelled or failed, or a checksum mismatch | `podman_install_failed` | "Podman didn't install" + Retry (on that computer) |
| No way to ask for the password | `podman_manual` | "Install Podman, then retry" + Retry |
| Podman older than 4.6 | `podman_old` | "Update Podman, then retry" + Retry |
| Podman has less than 3 GB | `podman_memory` | "Give Podman 4 GB of memory, then retry" + Retry |
| The state file cannot be read | `state_unreadable` | "Browser data can't be read" |
| Podman or its machine will not start | `podman_down` | "Podman is not running" + Retry |
| Image build fails with no image to fall back on | `image_failed` | "Browser image failed to build" + Retry (log keeps the last 50 build lines) |
| Container exits 3 times in a row | `browser_stopped` | "Browser stopped" + Retry |
| Profile volume not writable | `profile_unwritable` | "Browser can't save its login" + Retry |
| Proxy unreachable, or its login refused, when the browser starts | `proxy_failed` | "Proxy is not reachable" + Retry |
| Over the daemon's browser limit | `browser_limit` | "Too many browsers on this machine" + Retry (after another one stops) |

The panel also has three states of its own, which are not in the agent frame:

| Condition | What the person sees |
|---|---|
| The stream was closed for rate or backlog | "Browser is slow here" + Retry |
| The stream lost its route twice in a row | "Browser lost its connection" + Retry |
| Four viewers already have it open | "Browser is open in too many places" |
| The machine is not connected | "Reconnect this machine to open its browser" |
| Linux Desktop without WebKitGTK | "This computer can't show the browser" |

- Every `podman` call has a timeout.
- Start is idempotent: the service looks up the agent's label first.
- Retries are bounded, with backoff.

### Measures (standard 8)

The core's measures are plain counters from one fixed list (`usageCounter`, `cli/src/core/api.ts:1646`), so each
outcome is a counter of its own. All start with `agent_browser_`, because `browser_open` already counts something
else (a pane opening an address).

- From the service: `agent_browser_enabled`; `agent_browser_setup_ok` and `_setup_failed`; `agent_browser_start_ok`
  and `_start_failed`; one `agent_browser_failed_<state>` per failed state; `agent_browser_limit_dropped`;
  `agent_browser_ask_done`, `_ask_cleared` and `_ask_timeout`; `agent_browser_proxy_set`, `_proxy_removed`,
  `_proxy_test_ok` and `_proxy_test_failed`.
- From the core: `agent_browser_stream_opened`, and one `agent_browser_stream_closed_<reason>` per close reason.
- From Desktop, through its existing usage reports: `agent_browser_opened`.
- From the backend: relay bytes for the browser budget, as its rate bucket already counts.

None carries URLs, hosts, ids, reasons or page content.

## Hot path (standard 4)

The browser stream shares the transport with terminals. The PR shows numbers, before and after, on the same
workload, over a direct link and over the relay:

- terminal echo p95 while a browser panel is open and Gmail is scrolling: it stays within 50 ms and is no slower than
  with no panel;
- browser stream throughput and frame latency at the chosen encoding;
- the bridge's throughput and UI-thread cost on Windows, macOS and Linux;
- daemon and Desktop CPU at rest, with a browser agent running and its panel closed: within the at-rest limits. A
  closed panel streams nothing.

## Data and design checklist

- **Growth:**
  - Each browser agent has one container and one volume, plus a network while it runs and a secret when it has a
    proxy. Deleting the agent removes all of them, even when the service was down at the time.
  - One small settings record per browser agent, deleted with the agent.
  - At most two browser images exist at a time.
  - *(call)* At most 8 running browsers per daemon and 4 viewers per browser.
  - The browser cache is capped at 500 MB.
- **Concurrency:** the service serializes setup, start, stop and delete for each agent id. Different agents run in
  parallel. One setup and one image build run at a time per daemon.
- **Read cost:** one small `browser` field in the agent frame, sent only when it changes. Health comes from one pushed
  event stream.
- **Scale (10x):**
  - A browser uses about 300-600 MB of RAM, capped at 2 GB.
  - The first metrics to warn are `browser.start` failing for memory, and the backend's relay bytes for the browser
    budget.
  - The stream uses the direct link when it can. The PR reports relay bytes per open minute, because backend cost per
    Swarm must still fall.
- **Compatibility:**
  - Fields, frames and the binary kind are only added.
  - An older CLI never sends `browser`, so older pairs show nothing new. An older Desktop ignores the field.
- **Release order:** backend (relay allowlists and budget), then CLI, then Desktop. An older backend answers an
  unknown binary kind in a way terminals read as a lost connection, so the Desktop release that can open a stream
  goes out only after the backend is deployed.
- **Migration and rollback:**
  - There is no data migration.
  - After a rollback, the containers, volumes and state file stay. The next CLI that has the feature resumes from
    the state file.
  - The PR names the manual cleanup, by `label=harness.daemon=<id>`.
  - Podman stays installed.
- **Audience:** only the machine's own person. The agent's machine enforces this on `agent_browser_open`, on
  settings, and on Done; the backend only relays.
- **Identity:** the container runs on the agent's own person's machine, as that person.
- **Failure:** see Failures.
- **Platforms:**
  - **Container hosts:** macOS (Podman with its machine), Linux (rootless Podman), Windows (Podman with a rootful
    machine on WSL 2).
    - The daemon's `podman` calls use `ownProcessGroup()`.
    - The engine starts the relay `harness browser-mcp`. Whether a console window flashes there, and during setup,
      must be checked by recording the person's session on the signed build (Windows rules).
  - **Image:** amd64 and arm64.
  - **Client:** Desktop on macOS, Windows and Linux.

## Testing

- **CLI unit tests**, against a fake `podman` on PATH that records calls:
  - start is idempotent, and starts a stopped machine;
  - stop keeps the volume and removes the network;
  - a delete removes the container, volume, network and secret, and resumes after a crash midway;
  - a browser whose agent is gone is deleted at service start, only on a clear answer from the core;
  - a broken state file removes nothing;
  - another daemon's containers and volumes are never touched;
  - a refused limit is dropped and logged;
  - exits restart at most 3 times in a row, the count resets, and asked-for exits are not counted;
  - a reconnecting event stream reconciles with one `podman ps`;
  - failures are named.
- **Setup:** each OS's steps run in order against fakes; Windows asks for elevation once; a bad checksum fails; a
  non-local asker is refused; setup resumes from the recorded step, and after a Windows restart only when the boot
  time changed.
- **Tool server:** pure tests for the snapshot refs, the retries, the timeouts, human input and challenge detection,
  with injected inputs. Its tests against a real browser run inside the real image, by hand.
- **Proxy:** the relay adds the login for HTTP and SOCKS5; it never connects anywhere but the proxy; a refused login
  is an error; the password is absent from argv, environment, logs and frames.
- **Settings:** a change creates the container again and keeps the volume; a read never returns the password; a guest
  is refused.
- **Asking:** Done, cleared and timeout each end the wait; a second ask joins the first.
- **Relay:** `initialize` and `tools/list` answer without Podman; a call returns the named reason before the browser
  is ready; the exec is started again after a container restart.
- **Stream:** `agent_browser_open` is refused for a guest, a teammate and a non-browser agent, and allowed for the
  person's other Desktop; the viewer limit holds; closing a connection kills its execs; a frame the relay refuses
  closes the machine's relayed browser streams with a reason.
- **End to end, real daemon**, with the fake `podman`: create a browser agent, see `ready`, open a stream, delete.
  Also a `HARNESSD_TEST_FAULTS=agentBrowser` case: the service crashes and the agent keeps working.
- **Flutter:**
  - Click-through tests, as a person does: tick Browser, go through setup, see the progress; the Browser button opens
    the panel; settings; the ask banner; Retry from Failed.
  - Bridge tests for the JavaScript channel.
  - Gallery goldens for the pill, the setup dialog, the header button, the settings page and the banner, light and
    dark, in the same PR as the design doc.
- **By hand, recorded in the PR:**
  - set up from nothing on a clean macOS, Windows (with the restart) and Linux machine;
  - log in to a test Gmail through the panel on macOS and on a Windows host;
  - ask the agent to list the newest mail and draft a reply;
  - open the same browser from a second Desktop;
  - set a proxy, press Test, and confirm a "what is my IP" page shows the proxy's address and never the machine's;
  - open a reCAPTCHA demo page, let the agent ask, solve it by hand, press nothing, and see the agent go on;
  - turn Device on, and confirm a fingerprint test page opened by hand reports the chosen values;
  - paste Vietnamese text, and use ⌘C, ⌘V and ⌘A from a Mac.

## Left to the builder

- The pinned noVNC and Podman release versions (the minimum stays 4.6).
- Browser flags beyond the ones named here.
- How the per-agent `browser` flag is stored on the registry row.
- The binary frame layout for the browser kind.
- The failure copy, if a shorter form reads better under the naming rules.

## Later: the web and the phone

Not in v1. What was decided for them, so the next spec starts from it:

- **The same stream.** Both hold their own end-to-end encryption, so the frame family and kind 8 also go into the Dart
  E2EE and P2P lists (`desktop/lib/e2ee/envelope.dart`, `desktop/lib/web/p2p/terminal_p2p_link.dart`, and the phone's
  copies, kept equal by `desktop/test/p2p/mobile_parity_test.dart`).
- **The web.** The same panel, opened next to where the v3 layout offers the agent's terminal. The page runs in an
  `<iframe sandbox="allow-scripts" srcdoc=…>`, bridged with `postMessage`. The web never offers setup.
- **The phone.**
  - An **Open browser** action next to **Open terminal** (`mobile/lib/swarm/swarm_terminal_row.dart:98`,
    `swarm_project_page.dart:1789`), opening a full-screen page.
  - The screen is scaled to fit, and touch is noVNC's own, as in the prior art: a tap clicks, one finger drags in the
    page, two fingers scroll, a long press is a right click, and pinch is sent to the remote.
  - **Keyboard** shows a native Flutter text field above the phone's keyboard. **Send** types the text into the remote
    as key events, one per code point, using noVNC's keysym lookup. This works with Telex, which produces no key
    events of its own.
  - The ask banner with **Done**, and a dot on the action. No settings page.
  - It needs `webview_flutter` in the phone app, a new runtime dependency.
- **Access.** The web client and the phone are `web` peers that are not shared, so `accountOwner` already covers
  them.
- **To measure first:** the bridge on Android and iOS webviews, the web's encryption cost on the UI thread, and
  noVNC's gestures on real phones.
