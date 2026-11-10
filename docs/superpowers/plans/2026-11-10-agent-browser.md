# Agent Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Swarm agent created with the **Browser** checkbox gets a sandboxed Chrome container under Podman, which
Harness installs when it is missing. The agent drives the browser through Harness's own tools on `playwright-core`.
Its person opens the browser's screen with noVNC from Desktop, over the terminal's end-to-end encrypted transport.

**Scope:** Desktop only (macOS, Windows, Linux). The web and the phone are not in this plan; the spec's last section
keeps what was decided for them.

**Architecture:**

- **CLI service `agentBrowser`** owns everything Podman: setup, the locally built image, one container and volume per
  agent, one `podman events` stream for health, the settings, and the `browser` field in the agent frame.
- **The core** gains a port to that service and a small generic `BrowserStreamManager` beside
  `TerminalStreamManager`. The manager pipes `podman exec … socat` to a client stream with credit.
- **The stream** is a terminal-like frame family (`agent_browser_*` plus binary kind 8). It runs on the relay and on
  P2P, and is never dropped silently.
- **Desktop** bundles one self-contained noVNC page. Its channel object is bridged to Dart through the webview's
  JavaScript channel.
- **The agent** gets an MCP server `harness browser-mcp`. This is a stdio relay that answers `initialize` and
  `tools/list` from `browser-tools.json`, and forwards each call to the tool server `browser-tools.mjs` inside the
  container, which uses `playwright-core` (`connectOverCDP`).

**Tech Stack:**

- CLI: TypeScript (vitest).
- Backend: TypeScript.
- Desktop: Flutter/Dart, `webview_flutter`.
- Browser page: noVNC (pinned), bundled to one classic script.
- Container: Podman 4.6 or newer; Debian trixie, Google Chrome / Chromium, TigerVNC `Xvnc`, openbox, socat,
  `playwright-core` 1.58.2.

**Spec:** [docs/superpowers/specs/2026-11-10-agent-browser-design.md](../specs/2026-11-10-agent-browser-design.md).
Read it before starting any task. This plan does not repeat its reasons.

## Global Constraints

- **Runtime:** `podman` only. No task runs or mentions `docker`.
- **Podman:** version 4.6 or newer; at least 3 GB of memory, read from `podman info`. An installed Podman is never
  replaced, and an existing machine is never changed.
- **Names and copy:**
  - Product word: **Browser**.
  - Pill tooltip: "A sandboxed Chrome the agent drives". Line under the pill: "Needs setup · about 5 min".
  - Disabled tooltips: "Set up Browser on <machine name> first", "Update Harness on <machine name> first".
  - Setup dialog: title "Set up Browser"; body "Installs Podman on this computer to run the agent's Chrome. Asks for
    your password once. About 5 minutes, 1.5 GB."; extra line on Windows without WSL 2 "Windows restarts once.";
    buttons **Cancel**, **Install**.
  - Setup progress lines: "Podman installed", "Starting Podman…", "Building browser", "Starting browser". Restart
    step: "Restart Windows to finish", with **Later** and **Restart**.
  - Header button: `swarm-browser-button`, `AppIcons.globe`, tooltip "Browser". Panel buttons: **Paste**, **Retry**,
    **Install**.
  - Settings: page title "Browser settings"; rows "Proxy", "Time zone", "Language", "Screen", "Human input",
    "Advanced", "Device"; buttons **Remove**, **Test**, **Save**; test results "Proxy works · <address> · <zone>" and
    "Proxy is not reachable".
  - Challenge line in a tool reply: "This page asks for a person. Tell your person in chat what to do in Browser,
    wait for their answer, and do not act on the challenge yourself."
- **Failed states** (`browser.error`) and their copy, verbatim:

  | State | Copy | Button |
  |---|---|---|
  | `needs_setup` | "Browser isn't set up" | Install, on that computer only |
  | `podman_install_failed` | "Podman didn't install" | Retry, on that computer only |
  | `podman_manual` | "Install Podman, then retry" | Retry |
  | `podman_old` | "Update Podman, then retry" | Retry |
  | `podman_memory` | "Give Podman 4 GB of memory, then retry" | Retry |
  | `state_unreadable` | "Browser data can't be read" | none |
  | `podman_down` | "Podman is not running" | Retry |
  | `image_failed` | "Browser image failed to build" | Retry |
  | `browser_stopped` | "Browser stopped" | Retry |
  | `profile_unwritable` | "Browser can't save its login" | Retry |
  | `proxy_failed` | "Proxy is not reachable" | Retry |
  | `browser_limit` | "Too many browsers on this machine" | Retry |

- **Panel-only states** (not in the agent frame):
  - "Browser is slow here" with Retry: the stream closed with reason `rate` or `backlog`.
  - "Browser lost its connection" with Retry: the stream closed with reason `route` twice in a row. The first time
    the panel reconnects by itself.
  - "Browser is open in too many places": the open was refused with `VIEWER_LIMIT`.
  - "Only its owner can open this browser": `NOT_OWNER`.
  - "Reconnect this machine to open its browser"; "This computer can't show the browser" (no webview).
  - A close with reason `agent` or `closed`, and an open refused with `NOT_READY` or `NO_BROWSER`, show whatever the
    agent frame's `browser` state says.
- **Form-only states:** "Set up Browser on <machine name> first"; "Update Harness on <machine name> first"; "Browser
  isn't available on <machine name> right now" (the service did not answer).
- **Other copy:** starting "Starting browser…"; tool replies before ready "Browser is being set up" and "Browser is
  starting".
- **Agent frame field:** `browser: {state: 'setup'|'starting'|'ready'|'failed', step?: 'installing'|'starting_podman'|'building'|'restart_needed', error?: <failed state>}`.
  `step` is set only in `setup`, `error` only in `failed`. It never carries settings. It is absent for agents without
  a browser.
- **Registry field:** `browser?: true`.
- **Frames:** `agent_browser_open`, `agent_browser_open_result`, `agent_browser_ack`, `agent_browser_close`; and
  written by the backend only, `agent_browser_transport_error {code: 'RATE'}`.
  - Close reasons: `closed` (the client closed it), `agent` (the agent stopped or was deleted, or the browser
    exited), `rate`, `backlog`, `route`.
  - Routes: `direct`, `turn`, `relay`; a stream keeps the route it opened on. A stream of a window on the agent's own
    computer is `direct`. Frame lists change in `cli/src/lib/e2ee/applicationFrames.ts`. `cli/src/lib/e2ee/core.ts` is pinned by hash and is never edited. Never `browser_open`: it is taken
  (`cli/src/agentClient/openUrl.ts:29`).
- **Requests** (`AGENT_BROWSER_REQUESTS`), by who may send them:
  - any asker: `agent_browser_available`;
  - local only: `agent_browser_setup`, `agent_browser_restart`, and from the relay `agent_browser_state`;
  - the machine's own person (the access rule below): `agent_browser_retry`, `agent_browser_settings`,
    `agent_browser_settings_save`, `agent_browser_proxy_test`.
- **Access rule:** `(asker.local || asker.accountOwner === true) && !asker.guest`. `asker.owner` alone is never
  enough. The gateway already sets `accountOwner` for the person's other Desktops (`gateway.ts:202`); no task
  changes it.
- **Web build:** `desktop/lib` is also built for the web. The pill and the Browser button are not drawn when
  `kIsWeb`.
- **Binary kind:** `browser = 8`, the same value in CLI, backend and Desktop.
- **Container names and labels:** `harness-browser-<agentId>` for the container, the volume and the network; labels
  `harness.agent=<agentId>`, `harness.daemon=<daemonId>`, `harness.settings=<hash>`. The network exists only while
  the browser runs. No published ports. No `--add-host`. No VNC password. CDP is bound to `127.0.0.1` inside the
  container.
- **Proxy secret:** `harness-proxy-<agentId>`, mounted with `target=harness-proxy`.
- **Exit lookup:** `http://ip-api.com/json/?fields=status,timezone,query`, through the proxy only, 15 s timeout.
- **Limits:**
  - Container: `--memory 2g --cpus 2 --pids-limit 512 --shm-size 1g`.
  - tmpfs: `/tmp` 256 MB, `HOME` 256 MB, `/var/tmp` 16 MB, `/run` 16 MB.
  - Running browsers per daemon: `min(8, floor((Podman memory − 1 GB) / 2 GB))`, at least 1. Viewers per browser: 4.
  - Browser disk cache: 500 MB.
  - Unexpected exits: at most 3 restarts in a row; the count resets after 10 minutes Ready.
- **Timeouts:** `podman info` 5 s, cached 60 s. Every `podman` call has a timeout: 30 s, except build at 15 min,
  machine init and start at 10 min, and `events`, which streams. Agent start never waits on Podman.
- **A page that needs a person:** no waiting tool. The tool reply names the challenge and tells the agent to ask in
  chat. No tool waits longer than 60 s, inside both engines' defaults (Codex 300 s, Claude Code 120 s before it moves
  a call to the background), so no timeout setting is added.
- **Stream numbers** (relay budget, pacing, credit window, chunk size): taken from Task 0's report. Tasks that need
  them say so. The relay budget is per machine; the daemon paces the total of its relayed browser bytes under it.
- **Release order:** backend → CLI → Desktop. Fields, frames and the kind are only added. The Desktop release with
  Task 18 goes out only after the backend with Task 13 is deployed.
- **Frame log:** every `agent_browser_*` type is left out of the frame log, at all three sites
  (`cli/src/backendSocket.ts:1009`, `:948`, `:616-679`).
- **Assets:** a file added to `cli/assets/browser/` gets its define in both `cli/build-bundle.mjs:61-75` and
  `cli/build.mjs:45-56`, and its entry in `assets.ts`. `*.d.mts` files are not assets: they are left out of
  `browserContextFiles()`, the hash and the image. "Every asset file" below means every file in that folder except
  `*.d.mts`.
- **Container paths:** user `browser`, `HOME` `/home/browser`, profile `/var/lib/harness-browser-profile`, ready
  marker `/tmp/harness-ready`, Harness's files `/opt/harness-browser/`.
- **Measures:** counters only, through `usageCounter` (`cli/src/core/api.ts:1646`), each added to
  `PRODUCT_USAGE_METRICS`. The names are in spec § Measures; all start with `agent_browser_`.
  `cli/src/lib/productUsageContract.ts` and `backend/src/types/productUsage.ts` must stay byte-identical
  (`backend/src/lib/productUsage.test.ts:107-110`), so both change in the same pull request, the CLI's.
- **`.mjs` in TypeScript:** code in `cli/src` imports only `socks5.mjs`, through its `socks5.d.mts`. Specs import the
  other `.mjs` files with a dynamic import under `@ts-expect-error`, as `dsh/catalogPublisher.spec.ts:8` does.
- **Container environment:** `TZ`, `ACCEPT_LANG`, `SCREEN` (as `1920x1080`), `PROXY=1` when a proxy is set, `DEVICE`
  (JSON) when Device is on. The proxy relay listens on `127.0.0.1:3128` inside the container.
- **Pull requests** (standard 12), each with its own evidence from Task 20:
  1. backend: Task 13;
  2. CLI container and service: Tasks 1-8 (this one also changes the backend's copy of the usage contract);
  3. agent tools: Tasks 9-11;
  4. stream: Tasks 12 and 14;
  5. Desktop: Tasks 15-19.
- **Code standards:** every task follows AGENTS.md standards 1-13. Tests come first, shown failing then passing. No
  stubs and no dead code. Windows processes start with `ownProcessGroup()`. Measures carry no ids, URLs, hosts,
  reasons or content.
- Commit only when the person running the work asks. The commit steps below mark where a commit belongs.

## Review Focus

1. **A share guest opens the owner's logged-in browser.** `asker.owner` is true for a verified machine share. Task 14
   adds `open refused for a share guest whose owner flag is true`. Task 8 adds `the guest policy refuses every
   agent_browser type`.
2. **The core gives no agent list, or the state file is broken, when the service starts.** Nothing may be deleted on a
   missing answer. Task 7 adds `no answer from the core deletes nothing` and `an unreadable state file removes
   nothing and is named`.
3. **The agent is deleted while the service is down, or while its image is building.** Nothing may be left behind,
   least of all the volume with the login. Task 7 adds `browser of a gone agent is deleted at service start` and
   `delete during build leaves no container`.
4. **A second daemon on the same Podman.** It must never touch this daemon's containers or volumes. Task 6 adds
   `sweep spares another daemon's containers and every unlisted volume`.
5. **A browser frame the relay refuses.** It must close the browser streams with a reason, never corrupt them. Task
   13 adds `a refused machine browser frame sends that machine agent_browser_transport_error`. Task 14 adds
   `a transport error closes every relayed browser stream with reason rate`.
6. **A proxy that fails mid-session.** The browser must show an error page and never fall back to the machine's own
   address. Task 11 adds `relay never connects anywhere but the proxy`. Task 20's e2e checks it on a real container.

---

## Phase 0: the spike

### Task 0: Measure the bridge, the stream, the echo, the engines and Podman

Throwaway code. It is not merged. It lives in the scratch directory, and only the report is kept.

**Files:**
- Create: `docs/superpowers/specs/2026-11-10-agent-browser-spike.md` (the report)

- [ ] **Step 1: Podman facts**, on macOS (arm64), Linux (amd64, rootless) and Windows (rootful machine on WSL 2). Build
  a minimal image from the spec's package list and run it with the spec's flags. Record for each OS:
  - Chrome starts and stays up under `--read-only` with the four sized tmpfs mounts and `--cap-drop ALL`;
  - the `Xvnc` command line from the spec is accepted;
  - `podman events --format json --filter label=…`: the exact event name and JSON shape when a container exits, and
    whether a `podman stop` produces the same event;
  - `--memory`, `--cpus` and `--pids-limit` are accepted, or the exact refusal text;
  - `podman exec -i <c> socat STDIO TCP:127.0.0.1:5900` returns the 12-byte banner `RFB 003.008\n` unchanged;
  - `--secret <name>,target=harness-proxy` mounts a readable file under `--read-only` with a tmpfs on `/run`, and
    `podman secret create --replace` from stdin works;
  - `Xvnc` receives noVNC `sendKey` for "chào", "ạ", an emoji and a 200-character run, and Chrome shows them all;
  - `podman machine init` flags that take effect on macOS and on WSL, and what `podman info` reports as memory;
  - how many bridge networks one Podman can hold;
  - `playwright-core` 1.58.2 `connectOverCDP`, `ariaSnapshot()` and `getByRole` work against that Chrome;
  - whether Google Chrome has a Linux arm64 build today.
- [ ] **Step 2: The stream.** With noVNC connected through a plain websockify (spike only), Tight, quality 6,
  compression 2, 1920x1080: record bytes per second at rest, while typing, and while scrolling Gmail for 60 s (mean
  and peak).
- [ ] **Step 3: The bridge.** A webview page that receives base64 JSON chunks through the JavaScript channel and
  echoes them back. Measure bytes per second and UI-thread frame time on `webview_flutter_wkwebview` (macOS),
  `webview_win_floating` (Windows) and `webview_all_linux` (Linux), at 8, 32 and 64 KiB chunks. Also confirm that
  `loadHtmlString` loads a 1 MB self-contained page on each.
- [ ] **Step 4: The echo.** A throwaway patch lets kind 8 pass through the CLI and a local backend, and a filler
  source sends bytes at Step 2's scrolling rate with a credit window. With a terminal open on the same connection,
  record terminal echo p95 at windows of 32, 64, 128 and 384 KiB, over a direct link, through TURN, and over the
  relay. Record the bytes per open minute on TURN and on the relay.
- [ ] **Step 5: The engines.**
  - Record each engine's default limits for a stdio MCP tool call (done in the macOS run: Codex 300 s; Claude Code
    moves a call to the background at 120 s and aborts a silent one at 30 minutes).
  - Record whether each prompts for a `mcp__browser__…` call in a Swarm agent's default mode (Claude Code
    `--permission-mode auto`; Codex `--approve-for-me`, `engines/codex/launch.ts:3-7`), and for Codex the per-server
    key that allows it.
- [ ] **Step 6: Write the report** with a table for each step, and these decisions, each with its number: the
  backend's browser budget (bytes per machine per minute, since its guard is per machine socket); the daemon's total
  pacing rate for relayed browser bytes, below that budget; the credit window and the ack step; the chunk size for
  the bridge.
- [ ] **Step 7: Decide.** Stop and revise the spec before Phase 1 if any of these holds:
  - the bridge on any platform carries less than the stream's mean scrolling rate;
  - no credit window keeps echo p95 within 50 ms while the screen stays usable (then browser bytes need their own
    channel);

  Also report what one viewer costs the relay per open minute at the chosen budget. That number is agreed with the
  project's PM before Phase 3 starts, because backend cost per Swarm must fall as Swarms grow.

  Otherwise copy the four numbers into this plan's Global Constraints, replacing the "taken from Task 0's report"
  line.

## Phase 1: Podman and the container (CLI)

### Task 1: The tool server and the image assets, embedded in the bundle

**Files:**
- Create in `cli/assets/browser/`: `Containerfile`, `entrypoint.sh`, `policy.json`, `browser-tools.json`,
  `browser-tools.mjs`, `browser-tools-lib.mjs` (pure helpers the server imports)
- Create: `cli/src/services/agentBrowser/assets.ts`, `cli/src/lib/browserToolsAsset.ts` (so the relay in
  `agentClient`, Task 9, can import the tool list without crossing into `services/`)
- Modify: `cli/build-bundle.mjs:61-75` and `cli/build.mjs:45-56` (the `define` blocks)
- Test: `cli/src/services/agentBrowser/assets.spec.ts`, `cli/src/services/agentBrowser/browserToolsLib.spec.ts`

**Interfaces:**
- Produces:
  - `browserContextFiles(): Record<string, string>`: file name → content, for every asset file in
    `cli/assets/browser/`. Tasks 8, 10 and 11 add files to that folder, and this function and the bundle defines grow
    with them.
  - `browserTools(): { tools: McpTool[] }`, in `cli/src/lib/browserToolsAsset.ts`.
  - `browserAssetsHash(): string`: SHA-256 over every file of `browserContextFiles()`, first 12 hex characters.
  - `PLAYWRIGHT_CORE_VERSION = '1.58.2'`
  - From `browser-tools-lib.mjs`:
    - `roleSnapshot(aria: string): { text: string; refs: Record<string, { role: string; name?: string; nth: number }> }`
    - `connectWithRetry(connect: (timeoutMs: number) => Promise<B>, sleep: (ms: number) => Promise<void>): Promise<B>`
    - `withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T>`
  - `browser-tools.mjs`: a stdio MCP server (newline-delimited JSON-RPC) for these tools: `browser_navigate`,
    `browser_back`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_select`,
    `browser_scroll`, `browser_screenshot`, `browser_tabs`, `browser_wait`. It
    exits when stdin closes. It reads the CDP address from `HARNESS_BROWSER_CDP`, default `http://127.0.0.1:9222`.

- [ ] **Step 1: Write the failing tests.**
  - `assets.spec.ts`:
    - `embedded copies equal the files`, for every file in the folder.
    - `containerfile pins what the spec names`: it matches `/FROM debian:trixie[^@]*@sha256:/`; it contains
      `tigervnc-standalone-server`, `openbox`, `socat`, `fonts-noto-cjk`, `fonts-noto-color-emoji`, `pulseaudio`,
      `apt-get upgrade`, `playwright-core@1.58.2`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, and a `COPY` of the whole
      folder to `/opt/harness-browser/`; `policy.json` is copied to both `/etc/opt/chrome/policies/managed/` and
      `/etc/chromium/policies/managed/`; it contains none of `@playwright/mcp`, `novnc`, `websockify`, `EXPOSE` or
      `--mount=type=cache`.
    - `entrypoint`: it contains every browser flag in spec § Entrypoint, and none of `--headless`,
      `--enable-automation` or `--disable-dev-shm-usage`; it removes the three `Singleton*` files; it starts
      `Xvnc :1 -geometry "$SCREEN" -depth 24 -localhost -rfbport 5900 -SecurityTypes None -AlwaysShared`; openbox and
      PulseAudio are started detached; it ends with `wait -n` on the browser and Xvnc only; it exits 3 when the
      profile dir is not writable; it writes `/tmp/harness-ready` after CDP and port 5900 answer.
    - `browser-tools.json names exactly the eleven tools above`, each with an `inputSchema`.
  - `browserToolsLib.spec.ts`:
    - `roleSnapshot gives each interactive line a ref`: for `- button "Send"` twice and `- textbox "To"`, the text
      holds `[ref=e1]`, `[ref=e2]`, `[ref=e3]`, and `refs.e2` is `{role:'button', name:'Send', nth:1}`.
    - `connectWithRetry tries 3 times with timeouts 5000, 7000, 9000 and sleeps 250, 500`; a third failure rejects
      with "Browser is not reachable".
    - `concurrent connects share one attempt`.
    - `withTimeout rejects with "<what> timed out"`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/agentBrowser/assets.spec.ts src/services/agentBrowser/browserToolsLib.spec.ts`.
  Expected: FAIL (modules missing).
- [ ] **Step 3: Write the files.**
  - Copy the ref scheme from the prior art, `gateway-source/src/browser/pw-role-snapshot.ts` ("role" mode), and the
    connection handling from `pw-session.ts:368-426`.
  - `browser-tools.mjs` uses only public `playwright-core` API. Tool timeouts: 20 s, navigation 60 s, `browser_wait`
    clamped to 30000 ms. A ref that no longer resolves returns "Element not found; take a new snapshot".
  - Use the browser choice and the flag results that Task 0 recorded.
  - Add one `define` per file to `build-bundle.mjs`, following `__GUEST_HELPER__`.
- [ ] **Step 4: Run** the same tests. Expected: PASS. Then run `node cli/build-bundle.mjs` and confirm
  `grep -c __BROWSER_ dist/cli.js` prints 0.
- [ ] **Step 5: Commit** `feat(cli): agent browser image assets and tool server`.

### Task 2: Podman runner

**Files:**
- Create: `cli/src/services/agentBrowser/podman.ts`
- Create: `cli/src/services/agentBrowser/fakePodman.ts` (test helper: a script on a temp PATH that records argv and
  stdin to a JSON file, and replies from a table)
- Test: `cli/src/services/agentBrowser/podman.spec.ts`

**Interfaces:**
- Produces:
  - `class PodmanError extends Error { constructor(readonly state: string, message: string) }`
  - `type Availability = { state: 'ready' } | { state: 'stopped' } | { state: 'needs_setup'; restart: boolean } | { state: 'podman_old' } | { state: 'podman_memory' }`
  - `interface Podman { path(): Promise<string | null>; run(args: string[], opts?: { timeoutMs?: number; stdin?: string }): Promise<{ stdout: string; stderr: string }>; spawn(args: string[]): ChildProcess; available(): Promise<Availability>; startMachine(): Promise<void>; memoryBytes(): Promise<number> }`
  - `createPodman(deps?: { resolve?: (cmd: string) => Promise<string | null>; exists?: (path: string) => boolean; platform?: NodeJS.Platform; wsl2?: () => Promise<boolean>; now?: () => number }): Podman`

- [ ] **Step 1: Write the failing tests:**
  - `finds podman through the login shell, then the installers' paths`: `/opt/podman/bin/podman` on darwin, and
    `%ProgramFiles%\RedHat\Podman\podman.exe` on win32.
  - `no podman is needs_setup; restart is true only on win32 without WSL 2`.
  - `podman info ok is ready`.
  - `machine stopped is stopped`: `podman info` fails and `podman machine list --format json` shows a machine that is
    not running.
  - `a version below 4.6 is podman_old`, `less than 3 GiB is podman_memory`.
  - `memoryBytes reads memTotal from podman info on every platform`.
  - `available is cached 60 s`, and `info times out after 5 s`.
  - `startMachine runs machine start, and a failure is PodmanError('podman_down')`.
  - `run uses the login shell env and ownProcessGroup, and passes stdin`.
- [ ] **Step 2: Run** `npx vitest run src/services/agentBrowser/podman.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `createPodman`** with `execFile`, `resolveViaLoginShell` (`lib/tmuxOnPath.ts:110`),
  `loginShellEnvironment()` and `ownProcessGroup()`.
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): podman runner for agent browsers`.

### Task 3: Setup: install Podman and create its machine

**Files:**
- Create: `cli/src/services/agentBrowser/setup.ts`
- Create: `cli/src/services/agentBrowser/podmanRelease.ts` (the pinned version, and for each artifact its URL and
  SHA-256)
- Test: `cli/src/services/agentBrowser/setup.spec.ts`

**Interfaces:**
- Consumes: `Podman` (Task 2).
- Produces:
  - `type SetupStep = 'installing' | 'starting_podman' | 'restart_needed'`
  - `type SetupResult = 'done' | 'restart_needed'`
  - `class Setup { constructor(deps: { podman: Podman; platform: NodeJS.Platform; arch: string; download: (url: string, to: string, timeoutMs: number) => Promise<void>; sha256: (file: string) => Promise<string>; run: (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>; which: (cmd: string) => Promise<string | null>; interactive: () => boolean; bootTime: () => number; hostMemoryBytes: number; hostCpus: number; step: (s: SetupStep | null, bootTime?: number) => void })`,
    with:
    - `run(from: { step: SetupStep | null; bootTime?: number }): Promise<SetupResult>`: throws
      `PodmanError('podman_install_failed' | 'podman_manual' | 'podman_down', …)`.
  - `PODMAN_RELEASE: { version: string; artifacts: Record<'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'win32-arm64', { url: string; sha256: string }> }`

- [ ] **Step 1: Write the failing tests** (all dependencies are fakes):
  - `macOS installs the pkg through osascript with administrator privileges`: the downloaded file is checked, then
    `osascript -e 'do shell script "installer -pkg … -target /" with administrator privileges'` runs, with a 10 min
    timeout.
  - `a bad checksum deletes the file and fails podman_install_failed`; the installer never runs.
  - `a cancelled password dialog is podman_install_failed`: `osascript` exits non-zero with "User canceled".
  - `Windows runs one elevated script that enables WSL 2 when missing and installs the MSI`: exactly one
    `Start-Process -Verb RunAs -Wait` call is made, from a hidden PowerShell; the script holds
    `wsl --install --no-distribution` (only when WSL 2 is missing) and `msiexec /i … /qn /norestart`.
  - `Windows returns restart_needed after the script when WSL 2 was just enabled`: `step('restart_needed', bootTime)`
    is recorded, and nothing else runs.
  - `restart_needed resumes only after the boot time changed`: `run({step:'restart_needed', bootTime: T})` with
    `bootTime()` still `T` returns `restart_needed` again; with a later boot time it goes on to the machine steps.
  - `after the restart no elevated call is made`.
  - `Linux uses pkexec with the distro's package manager`: `apt-get` when present, else `dnf`, `pacman`, `zypper`.
  - `no way to ask is podman_manual`: Linux without `pkexec` or without a known manager, and any platform when
    `interactive()` is false. No installer runs.
  - `machine init when there is none`: on darwin `podman machine init --memory <MB> --cpus <n>`, where memory is
    `min(host/2, 16 GB)` and cpus is `max(2, host/2)`; on win32 `podman machine init --rootful` with no size. Then
    `machine start`.
  - `an existing machine is never changed`: when `machine list` returns one, neither `init` nor `set` is called.
  - `an installed Podman is never replaced`: when `podman` is found, the install step is skipped whatever its version.
  - `Linux skips the machine steps`.
  - `resumes from the recorded step`: starting with step `starting_podman` skips the install.
- [ ] **Step 2: Run** `npx vitest run src/services/agentBrowser/setup.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `Setup`.** Follow the prior art, `electron/sandbox-runtime/installer.ts:253-320, 846-886,
  938-973`. Fill `PODMAN_RELEASE` from the official Podman release's published checksums, and note the release page in
  a comment. `interactive` is false when `SSH_CONNECTION` is set, or when Linux has neither `DISPLAY` nor
  `WAYLAND_DISPLAY`.
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): set up Podman for agent browsers`.

### Task 4: Image build

**Files:**
- Create: `cli/src/services/agentBrowser/image.ts`
- Test: `cli/src/services/agentBrowser/image.spec.ts`

**Interfaces:**
- Consumes: `Podman` (Task 2), `browserContextFiles()` and `browserAssetsHash()` (Task 1).
- Produces:
  - `imageTag(hash: string, now: Date): string`: returns `harness-browser:<hash>-<ISO year>w<ISO week>`.
  - `ensureImage(podman: Podman, now: Date, log: (line: string) => void): Promise<string>`: returns a tag to run, or
    throws `PodmanError('image_failed', lastFiftyLines)` when there is no image at all.
  - `pruneImages(podman: Podman, keep: string): Promise<void>`

- [ ] **Step 1: Write the failing tests:**
  - `tag carries the hash and the ISO week`: 2026-11-10 gives `harness-browser:<hash>-2026w46`.
  - `builds from a temp context dir, not stdin`: the argv is `['build', '-t', <tag>, <dir>]`, and the dir held every
    file of `browserContextFiles()` at call time.
  - `returns the current tag without building when it exists`.
  - `with an older image present, returns it at once and builds the new tag in the background`.
  - `a failed background build is logged and the next call still returns the older image`.
  - `with no image at all, a failed build throws image_failed with the last 50 lines`.
  - `one build at a time`: two concurrent calls run one `build`.
  - `temp dir removed after success and failure`.
  - `after a background build succeeds, prune removes older harness-browser tags no container uses`.
- [ ] **Step 2: Run** `npx vitest run src/services/agentBrowser/image.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The build timeout is 15 min.
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): build the agent browser image locally`.

### Task 5: Settings model

**Files:**
- Create: `cli/src/services/agentBrowser/settings.ts`
- Test: `cli/src/services/agentBrowser/settings.spec.ts`

**Interfaces:**
- Produces:
  - `interface BrowserHost { timeZone: string; languages: string }`, built once from
    `Intl.DateTimeFormat().resolvedOptions()`.
  - `type BrowserSettings = { proxy: { scheme: 'http'|'https'|'socks5'; host: string; port: number; username: string; password: string } | null; timeZone: string | null; languages: string; screen: '1920x1080'|'1680x1050'|'1536x864'|'1440x900'|'1366x768'; humanInput: boolean; humanSpeed: 'slow'|'normal'|'fast'; device: { gpuVendor: string; gpuRenderer: string; cpuCores: number; memoryGb: number } | null }`
  - `defaultSettings(host: BrowserHost): BrowserSettings`: no proxy, `timeZone: null` (Auto), the host's languages,
    `1920x1080`, human input on at `normal`, no device.
  - `parseSettings(raw: unknown, current: BrowserSettings): BrowserSettings`: validates every field; an absent
    `proxy.password` keeps the current one.
  - `publicSettings(s: BrowserSettings): object`: the same shape, with `password` replaced by `passwordSet: boolean`.
  - `settingsHash(s: BrowserSettings): string`: covers everything except `humanInput` and `humanSpeed`.
  - `humanMode(s: BrowserSettings): 'off' | 'slow' | 'normal' | 'fast'`

- [ ] **Step 1: Write the failing tests:**
  - `defaults follow the machine's zone and language`.
  - `parseSettings rejects an unknown screen, a bad port, a host with spaces, and an unknown zone`.
  - `saving without a password keeps the stored one`.
  - `publicSettings never contains the password`.
  - `settingsHash ignores human input and changes with every other field`.
- [ ] **Step 2: Run** `npx vitest run src/services/agentBrowser/settings.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): agent browser settings model`.

### Task 6: Containers: create, start, stop, remove, sweep

**Files:**
- Create: `cli/src/services/agentBrowser/containers.ts`
- Test: `cli/src/services/agentBrowser/containers.spec.ts`

**Interfaces:**
- Consumes: `Podman` (Task 2), `BrowserSettings` and `settingsHash` (Task 5).
- Produces:
  - `class Containers { constructor(podman: Podman, daemonId: string, log: (line: string) => void)`, with:
    - `start(agentId: string, image: string, settings: BrowserSettings, timeZone: string): Promise<{ limitsDropped: string[] }>`:
      create, or start the existing one, or create again when its image or its `harness.settings` label differs (the
      volume stays). It creates the network first.
    - `stop(agentId: string): Promise<void>`: stops the container and removes the network.
    - `remove(agentId: string): Promise<void>`: the container, the volume, the network and the secret.
    - `sweep(listedAgentIds: Set<string>): Promise<number>`: removes this daemon's containers that are not listed.
    - `running(): Promise<string[]>`: agent ids of this daemon's running browser containers.
    - `ready(agentId: string): Promise<boolean>`: one `podman exec <c> test -f /tmp/harness-ready`.
    - `exitCode(agentId: string): Promise<number | null>`
    - `execArgs(agentId: string, cmd: string[]): string[]`: returns `['exec', '-i', name, ...cmd]`.
  - `}`
  - `browserLimit(podmanMemoryBytes: number): number`: `min(8, floor((memory − 1 GiB) / 2 GiB))`, at least 1.

- [ ] **Step 1: Write the failing tests** (fake podman):
  - `create args`: the exact argv contains:
    - `--name harness-browser-a1`, `--label harness.agent=a1`, `--label harness.daemon=d1`,
      `--label harness.settings=<hash>`;
    - `--network harness-browser-a1`;
    - `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only`;
    - `--tmpfs /tmp:size=256m`, `--tmpfs /home/browser:size=256m`, `--tmpfs /var/tmp:size=16m`,
      `--tmpfs /run:size=16m`;
    - `-v harness-browser-a1:/var/lib/harness-browser-profile`;
    - `--memory 2g --cpus 2 --pids-limit 512 --shm-size 1g`;
    - `-e TZ=<timeZone> -e ACCEPT_LANG=<languages> -e SCREEN=<screen>`;
    - no `-p`, no `--publish` and no `--add-host`.

    The network and the volume are created first, with the first two labels.
  - `with a proxy`: the secret `harness-proxy-a1` is created from stdin with `--replace`, holding the proxy as JSON;
    the create argv has `--secret harness-proxy-a1,target=harness-proxy` and `-e PROXY=1`. The password is in no
    argument and no `-e`.
  - `with a device`: the create argv has `-e DEVICE=<json of the four values>`.
  - `start is idempotent`.
  - `a container on an older image, or with a different settings label, is created again and keeps its volume`.
  - `refused limit is dropped and logged`: use the refusal text Task 0 recorded; the result is
    `limitsDropped: ['memory']`.
  - `stop keeps the volume and removes the network`, `start creates the network again`.
  - `remove deletes container, volume, network and secret`.
  - `sweep spares another daemon's containers and every unlisted volume` (Review Focus 4): with containers `d1/a1`
    (listed), `d1/a9` (not listed) and `d2/a5`, only `d1/a9` is removed, and no `volume rm` runs.
  - `browserLimit`: 17 GiB gives 8, 7 GiB gives 3, 3 GiB gives 1.
- [ ] **Step 2: Run** `npx vitest run src/services/agentBrowser/containers.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `Containers`.**
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): agent browser containers`.

### Task 7: Browser state, events, and the state file

**Files:**
- Create: `cli/src/services/agentBrowser/browsers.ts`, `cli/src/services/agentBrowser/events.ts`,
  `cli/src/services/agentBrowser/stateFile.ts`
- Test: `browsers.spec.ts`, `events.spec.ts`, `stateFile.spec.ts` in the same folder

**Interfaces:**
- Consumes: `Containers` and `browserLimit` (Task 6), `ensureImage` (Task 4), `Setup` (Task 3), `Podman` (Task 2),
  the settings functions (Task 5).
- Produces:
  - `type BrowserState = { state: 'setup' | 'starting' | 'ready' | 'failed'; step?: SetupStep | 'building'; error?: string }`
  - `class StateFile { constructor(path: string)`, with
    `read(): { browsers: Record<string, BrowserSettings>; deleting: string[]; setup: { step: SetupStep; bootTime?: number } | null }`
    (throws `PodmanError('state_unreadable')` for a file that exists and cannot be parsed) and
    `update(change: (s) => void): void` (atomic write, mode 0600). `}`
  - `class Browsers { constructor(deps: { podman: Podman; containers: Containers; setup: Setup; image: () => Promise<string>; state: StateFile; host: BrowserHost; exitZone: (proxy) => Promise<string | null>; changed: (agentId: string) => void; closeViewers: (agentId: string) => void; measure: (name: string) => void; now?: () => number })`,
    with:
    - `start(agentId: string): Promise<void>`
    - `setUp(): Promise<void>`: runs setup, then starts every browser waiting on it.
    - `stop(agentId: string): Promise<void>`
    - `delete(agentId: string): Promise<void>`
    - `retry(agentId: string): Promise<void>`
    - `state(agentId: string): BrowserState | undefined`
    - `settings(agentId: string): BrowserSettings`
    - `saveSettings(agentId: string, next: BrowserSettings): Promise<void>`: stores them, and restarts the browser when
      `settingsHash` changed.
    - `exited(agentId: string): void`
    - `reconcile(): Promise<void>`: one `containers.running()`, compared with what should be running.
    - `resume(known: Set<string> | null): Promise<void>`: `null` means the core gave no answer.
  - `}`
  - `watchEvents(podman: Podman, daemonId: string, on: { exited: (agentId: string) => void; reconnected: () => void }): { close(): void }`

- [ ] **Step 1: Write the failing tests:**
  - `start with no podman and no setup running is failed needs_setup`.
  - `setUp reports steps and then starts the waiting browsers`: `changed` sees `setup/installing`,
    `setup/starting_podman`, `setup/building`, then `starting`, then `ready`.
  - `setUp that needs a restart leaves browsers in setup/restart_needed, and a later setUp after the restart goes on`.
  - `start starts a stopped machine first`.
  - `a first start with no image shows setup/building until the build ends, then starting, then ready`.
  - `resume with the step starting_podman runs setUp`, and `with restart_needed runs it once the boot time changed`.
  - `resume with the step installing does not run the installer`: every browser waiting on it becomes
    `failed/podman_install_failed`.
  - `start goes starting then ready`: it calls `containers.ready` once a second for at most 60 s, then stops calling.
  - `failures are named`: `podman_old`, `podman_memory`, `podman_down`, `image_failed`, `browser_limit`,
    `podman_install_failed`, `podman_manual`; container exit code 3 gives `profile_unwritable` and 4 gives
    `proxy_failed`.
  - `exit codes 3 and 4 go straight to failed and are not restarted`.
  - `retry on browser_limit starts the browser once another has stopped`.
  - `the limit counts running browsers only`.
  - `exit restarts at most 3 times in a row with backoff 1 s, 2 s, 4 s`; a fourth gives `browser_stopped`.
  - `the count resets after 10 minutes ready`.
  - `an exit the service asked for is not counted`: `stop`, `delete`, a settings change, and a move to a new image.
  - `operations are serialized per agent; different agents run in parallel`.
  - `delete during build leaves no container` (Review Focus 3).
  - `delete is recorded first, closes viewers, and resumes after a crash`.
  - `browser of a gone agent is deleted at service start` (Review Focus 3): the state file lists `a1` and `a2`;
    `resume(new Set(['a1']))` removes `a2`'s container, volume and network.
  - `no answer from the core deletes nothing` (Review Focus 2): `resume(null)` finishes recorded deletes only,
    removes no browser and sweeps nothing.
  - `an empty set from the core is believed`: `resume(new Set())` deletes every listed browser.
  - `resume sweeps unlisted containers of this daemon`.
  - `an unreadable state file removes nothing and is named` (Review Focus 2): every browser agent's state is
    `failed/state_unreadable`, the file is left as it is, and no `podman` call that changes anything is made.
  - `saveSettings with a changed hash restarts the browser and keeps the volume; a human-input-only change does not`.
  - `auto time zone uses the proxy's exit zone, and the machine's when the lookup fails` (with a logged warning).
  - `events.spec`: the argv uses `events --format json`, the label filter, and the event name Task 0 recorded; each
    line calls `exited(agentId)`; a dropped stream restarts with backoff (1 s, doubling, capped at 30 s) and calls
    `reconnected`; `close()` kills the child.
  - `reconnected runs reconcile once`.
  - `stateFile.spec`: `update is atomic and 0600`, `a missing file reads as empty`,
    `a file that cannot be parsed throws state_unreadable and is not rewritten`.
- [ ] **Step 2: Run** `npx vitest run src/services/agentBrowser/browsers.spec.ts src/services/agentBrowser/events.spec.ts src/services/agentBrowser/stateFile.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement the three files.** Counters: `agent_browser_setup_ok`, `_setup_failed`, `_start_ok`,
  `_start_failed`, `_failed_<state>` and `_limit_dropped`. `measure(name)` takes a name only.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): agent browser state, health events and state file`.

### Task 8: Service wiring: port, registry field, frame field, requests, and who is asking

**Files:**
- Create: `cli/src/services/agentBrowser.ts` (`startAgentBrowser`), `cli/src/services/agentBrowserProcess.ts`,
  `cli/src/core/agentBrowserLink.ts` (copy `core/agentCleanupLink.ts`), `cli/src/services/agentBrowser/exitLookup.ts`
- Modify: `cli/src/core/api.ts`: `AGENT_BROWSER_REQUESTS` (near `:666-810`); `AgentBrowserPort` and
  `AGENT_BROWSER_FALLBACKS` (near `:1023`); an `agentBrowser` slot in `CorePorts`/`emptyPorts` (`:1912-1930`).
- Modify: `cli/src/core/main.ts`: serve the service (as `:1762-1784`); call `attached` beside the `attachDsh` sites
  (`:1954, 2633, 2793, 2824, 2899`); call `stopped` beside `ports.agentCleanup?.closed` (`:2903`); start the service
  at daemon start when the state file exists.
- Modify: `cli/src/core/agents/lifecycle.ts:107`: call `ports.agentBrowser?.deleted(s.agentId)` in the purge
  `deleted` callback.
- Modify: `cli/src/harnessd/services.ts:375` (`SERVICE_HOSTS` row, `onDemand: true`, `askedSince` set to the new
  protocol number, and the memory limits the other on-demand rows carry), `cli/src/harnessd/protocol.ts` (bump
  `HARNESSD_PROTOCOL`), `cli/src/serviceProcess.ts:40`, `cli/src/services/inline.ts:35`.
- Modify: the registry field `browser?: true` in `cli/src/lib/registry.ts:89`, `:717-731`, `:1424`, `:1747`, `:1798`,
  `:2156` (keep on rebind) and `:2314` (clear on separate shell).
- Modify: `cli/src/lib/createAgentPane.ts:45,93,157`, `cli/src/core/agents/create.ts:426-450`, and
  `cli/src/backendSocket.ts:159-213` (`onCreateAgent` input `browser?: boolean`).
- Modify: `cli/src/lib/agentFrame.ts`: `browser?: BrowserState` in `AgentFrameContext` (`:164`), emitted in the frame
  (`:215-291`), and filled at `backendSocket.ts:1446,1460` and `main.ts:432`.
- Modify: `cli/src/backendSocket.ts:1118`: extract the inline Asker into `askerFor(connId: string): Asker`, used by
  the existing code and by Task 14. `gateway.ts` is not changed in this task.
- Modify: `cli/src/backendSocket.ts:1009`, `:948` and `:616-679`: leave every `agent_browser_` type out of the frame
  log at all three sites, and leave the `browser` field out of any agent frame those sites log.
- Modify: `cli/build-bundle.mjs`, `cli/build.mjs` and `cli/src/services/agentBrowser/assets.ts` (for `socks5.mjs`).
- Modify: `cli/src/lib/productUsageContract.ts` and `backend/src/types/productUsage.ts` together: the counters of
  spec § Measures.
- Modify: `cli/src/lib/e2ee/applicationFrames.ts:26-45`: the requests a remote Desktop sends
  (`agent_browser_available`, `agent_browser_retry`, `agent_browser_settings`, `agent_browser_settings_save`,
  `agent_browser_proxy_test`).
- Create: `cli/assets/browser/socks5.mjs` (the SOCKS5 username/password handshake that sends the host name; used by
  `exitLookup.ts` here and by the relay in Task 11), and `cli/assets/browser/socks5.d.mts` beside it, so TypeScript
  in `cli/src` can import it (`tsconfig.json` has no `allowJs`).
- Test: `cli/src/services/agentBrowser.spec.ts`, `cli/src/services/agentBrowser/exitLookup.spec.ts`,
  `cli/src/services/agentBrowser/socks5.spec.ts`; new cases in `cli/src/core/agents/lifecycle.spec.ts`,
  `cli/src/lib/registry.spec.ts`, `cli/src/lib/agentFrame.spec.ts`, `cli/src/gateway/gateway.spec.ts` and
  `cli/src/core/guestPolicy.spec.ts`; `cli/e2e/agentBrowser.e2e.ts`

**Interfaces:**
- Consumes: `Browsers` (Task 7), `createPodman` (Task 2), the settings functions (Task 5).
- Produces:
  - `AGENT_BROWSER_REQUESTS = ['agent_browser_available', 'agent_browser_setup', 'agent_browser_restart', 'agent_browser_retry', 'agent_browser_state', 'agent_browser_settings', 'agent_browser_settings_save', 'agent_browser_proxy_test'] as const`.
  - `mayOpenBrowser(asker: Asker): boolean`: the access rule of Global Constraints. Exported from `core/api.ts`.
  - `askerFor(connId: string): Asker`
  - `interface AgentBrowserPort { attached(session: RegisteredSession): void; stopped(agentId: string): void; deleted(agentId: string): void; frameContext(agentId: string): BrowserState | undefined }`.
    Task 14 adds `streamCommand` and `onCloseViewers`, when the stream needs them.
    - Out of process, `frameContext` answers from the values the link was last told, like `core/viewersLink.ts:149`.
  - On `CoreApi` (the core answers these; `services/AGENTS.md` step 1), if it has no call for them yet:
    `agents.ids(): Promise<{ live: string[]; stopped: string[] }>` and `agents.ofPane(pane: string): string | null`.
  - `testProxy(proxy, deps?): Promise<{ ok: true; address: string; timeZone: string } | { ok: false }>`, 15 s
    timeout, in `exitLookup.ts`. It works through HTTP, HTTPS and SOCKS5 proxies, with their login.
    `exitZone(proxy)` is its `timeZone` or null.
  - `socks5.mjs`: `socks5Connect(socket, { host, port, username, password }): Promise<void>`.
  - Replies:
    - `agent_browser_available` → `Availability` (Task 2).
    - `agent_browser_setup` → `{ok: true}` and runs `Browsers.setUp()`; `{error: 'LOCAL_ONLY'}` unless `asker.local`.
    - `agent_browser_restart` → runs `shutdown /r /t 10 /c "Harness is restarting Windows to finish setting up
      Browser"` on win32 only; `LOCAL_ONLY` otherwise.
    - `agent_browser_retry {agentId}` → `Browsers.retry`.
    - `agent_browser_state {pane}` → `{agentId, state, error?, podman: <path>, human: 'off'|'slow'|'normal'|'fast'}`;
      `LOCAL_ONLY` unless `asker.local`.
    - `agent_browser_settings {agentId}` → `publicSettings`.
    - `agent_browser_settings_save {agentId, settings}` → `publicSettings` after the save.
    - `agent_browser_proxy_test {agentId, proxy}` → the `testProxy` result. A proxy without a password uses the stored
      one.
    - The last four, and retry, answer `{error: 'NOT_OWNER'}` unless `mayOpenBrowser(asker)`.

- [ ] **Step 1: Write the failing tests:**
  - `attached starts a browser only for browser:true sessions`, and counts `agent_browser_enabled` once per agent.
  - `stopped stops, deleted deletes`.
  - `frameContext follows state and calls core.agents.sync on change`.
  - `setup and restart refuse a non-local asker`.
  - `retry, settings, settings_save and proxy_test refuse a share guest and a plain owner without accountOwner`.
  - `settings never returns the password`, and `the agent frame never carries settings`.
  - `state finds the agent by pane and carries the human mode`.
  - `service start resumes with the core's live and stopped agent ids, and with null when the core does not answer`.
  - `exitLookup.spec`: `asks ip-api through an HTTP proxy, an HTTPS proxy and a SOCKS5 proxy, each with its login,
    and returns the address and zone`, `a failed lookup is ok:false`, `times out after 15 s`,
    `an invalid zone is ignored`.
  - `socks5.spec`: `sends the host name, never a resolved address`, `a refused login rejects`.
  - `saving or removing a proxy, and a proxy test, count agent_browser_proxy_set, _removed, _test_ok or
    _test_failed`.
  - Gateway spec, as a record of what exists (it passes before any change):
    `accountOwner is set for the owner's other machine, and never for a shared machine`.
  - Guest policy spec, also a record of what exists (the policy is default-deny, so it passes before any change):
    `the guest policy refuses every agent_browser type` (Review Focus 1), for each stream frame and each request in
    Global Constraints.
  - `no agent_browser frame is written to the frame log`: with `LOG_FRAMES` on, a settings save with a password, its
    reply with the proxy's host, and a proxy test reply with the exit address leave none of the three in the log.
  - Lifecycle spec: `purge calls agentBrowser.deleted; a plain stop does not`.
  - Registry spec: `browser:true survives persist, parse and rebind; cleared on separate shell`.
  - AgentFrame spec: `browser field present only when the context has it`.
  - E2E, real daemon with the fake `podman` on PATH (`cli/AGENTS.md` rule 5):
    - `create a browser agent, see browser ready in its frame, delete it, see remove calls`;
    - `HARNESSD_TEST_FAULTS=agentBrowser: the service crashes and the agent keeps working`.
- [ ] **Step 2: Run** `npx vitest run src/services/agentBrowser.spec.ts src/services/agentBrowser src/core/agents/lifecycle.spec.ts src/lib/registry.spec.ts src/lib/agentFrame.spec.ts src/gateway/gateway.spec.ts src/core/guestPolicy.spec.ts`.
  Expected: the new cases FAIL, except the two records of what exists (the gateway case and the guest policy case),
  which pass.
- [ ] **Step 3: Implement the service and the wiring.**
  - The service needs two things from the core: the ids of its live and stopped agents, and the agent of a pane. Use
    the `CoreApi` calls that give them if they exist; otherwise add the two named under Interfaces. A call that
    fails or times out is "no answer", and `resume` gets `null`.
  - The daemon id is a stable hash of the daemon's data dir. Port
  the HTTP part of the exit lookup from the prior art, `electron/browser/chrome-engine/pool.ts:67-134`; the HTTPS
  and SOCKS5 parts are new. Justify the outside service in the PR (standard 9). The default language is
  `Intl.DateTimeFormat().resolvedOptions().locale`, whatever it gives under launchd.
- [ ] **Step 4: Run** the tests above, plus `npx vitest run src/architecture.spec.ts`, `npm run test:harnessd`,
  `npm run test:sharing`, and the e2e file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): agentBrowser service`.

## Phase 2: the agent drives the browser

### Task 9: `harness browser-mcp` relay, attached at create and relaunch

**Files:**
- Create: `cli/src/agentClient/browserMcp.ts`, `cli/src/lib/browserMcpArgs.ts`
- Modify: `cli/src/cli.ts`: add `case 'browser-mcp'` beside `case 'computer-use'` (`:2838`)
- Modify: `cli/src/core/agents/create.ts:395` (`extraArgs`, after `...machineMcp`), `cli/src/lib/launchOverrides.ts:319-324`
- Test: `cli/src/agentClient/browserMcp.spec.ts`, `cli/src/lib/browserMcpArgs.spec.ts`; new cases in
  `cli/src/core/agents/create.spec.ts` and the launchOverrides spec

**Interfaces:**
- Consumes: `browserTools()` from `cli/src/lib/browserToolsAsset.ts` (Task 8); the request `agent_browser_state`
  (Task 8); the pane lookup `sendPane`, as `openUrl.ts:20` uses it; the daemon request helper with a timeout per
  request (`cli/src/agentClient/daemon.ts:116-125`).
- Produces:
  - `browserMcpCommand(io?: { stdin: Readable; stdout: Writable }, deps?: { ask: …; spawn: … }): Promise<number>`
  - `browserMcpArgs(engine: 'claude' | 'codex', harnessPath: string): string[]`. It takes no agent id.
  - Each forwarded `tools/call` carries `params._harness = { human: 'off'|'slow'|'normal'|'fast' }`, from the state
    reply.

- [ ] **Step 1: Read Task 0's report** for the approval results and the timeout settings of both engines. They
  decide the exact arguments below.
- [ ] **Step 2: Write the failing tests** (in-memory streams, a fake daemon request function):
  - `initialize and tools/list answered without podman`: the daemon is never asked.
  - `tools/call before ready returns the named reason`: `setup` gives "Browser is being set up", `starting` gives
    "Browser is starting", and a failed state gives its copy from Global Constraints. The result is
    `{isError: true, content: [{type: 'text', text}]}`.
  - `tools/call when ready is forwarded`: it spawns `<podman> exec -i harness-browser-<agentId> node
    /opt/harness-browser/browser-tools.mjs`, replays `initialize` to the child once, and passes the call and its reply
    through with ids preserved.
  - `each forwarded call carries the human mode of the latest state reply`.
  - `child exit restarts on the next call`.
  - `stdin close ends the child and returns 0`.
  - `outside a Harness pane it exits non-zero with a one-line message`.
  - `the podman exec child starts with ownProcessGroup()` (no console window on Windows).
  - `claude args`:
    `['--mcp-config={"mcpServers":{"browser":{"type":"stdio","command":"<harness>","args":["browser-mcp"]}}}']`.
    No `--allowedTools`: the spike measured that Claude Code in `--permission-mode auto` runs MCP tools without a
    prompt.
  - `codex args`: `['-c', 'mcp_servers.browser.command="<harness>"', '-c', 'mcp_servers.browser.args=["browser-mcp"]', …the key from Task 0, if Codex prompts]`.
  - Create spec: `browser:true adds the args; absent adds nothing`.
  - LaunchOverrides spec: `relaunch of a browser agent keeps the args`.
- [ ] **Step 3: Run** `npx vitest run src/agentClient/browserMcp.spec.ts src/lib/browserMcpArgs.spec.ts src/core/agents/create.spec.ts`.
  Expected: FAIL.
- [ ] **Step 4: Implement.** The relay is a newline-delimited JSON-RPC relay, and must not pull heavy modules into the
  lean bundle (check `scripts/check-lean-bundle.mjs`). The args mirror `machineMcpArgs` (`lib/machineMcp.ts:162-176`).
- [ ] **Step 5: Run** the same tests plus `npm run test:core`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(cli): harness browser-mcp relay`.

### Task 10: Human-like input and challenge detection

**Files:**
- Create: `cli/assets/browser/human-input.mjs`, `cli/assets/browser/challenge.mjs`
- Modify: `cli/assets/browser/browser-tools.mjs`, `cli/src/services/agentBrowser/assets.ts`, `cli/build-bundle.mjs`,
  `cli/build.mjs`
- Modify: `cli/src/services/agentBrowser.ts` (count `agent_browser_challenge_seen` when the relay reports one)
- Test: `cli/src/services/agentBrowser/humanInput.spec.ts`, `challenge.spec.ts`; new cases in `browserMcp.spec.ts`
  and `assets.spec.ts`

**Interfaces:**
- Produces:
  - `human-input.mjs`: `mousePath(from: Point, box: Box, rng: () => number): Point[]`,
    `keyDelays(text: string, speed: 'slow'|'normal'|'fast', rng: () => number): number[]`. All randomness goes
    through `rng`. The tool server reads the mode from each call's `params._harness.human`.
  - `challenge.mjs`: `detectChallenge(frames: { url: string; visible: boolean; width: number; height: number }[], elements: string[]): string | null`.
    It returns one of `recaptcha`, `hcaptcha`, `cloudflare`, `datadome`, `perimeterx`, `arkose`, `awswaf`, or null.
    reCAPTCHA counts only by its challenge frame (a URL containing `/recaptcha/` and `bframe`), never by the badge
    frame.
  - Tool replies of `browser_navigate`, `browser_click`, `browser_type` and `browser_snapshot` gain
    `challenge: <kind>` and the line "This page asks for a person. Tell your person in chat what to do in Browser,
    wait for their answer, and do not act on the challenge yourself." when one is detected.
  - There is no waiting tool. The tool list stays the eleven tools of Task 1.

- [ ] **Step 1: Write the failing tests:**
  - `mousePath ends inside the box and is not a straight line`, `the same rng gives the same path`.
  - `keyDelays are log-normal within the speed's range, and exact for a fixed rng`.
  - `human mode off clicks and types at once`.
  - `each challenge kind is detected from its visible frame or element`: one case per kind, with the prior art's
    signs (`2026-11-01-captcha-handoff-design.md` §5.1).
  - `the word captcha in page text is not a challenge`, `an invisible or zero-size frame is not a challenge`,
    `the badge of an invisible reCAPTCHA is not a challenge`.
  - `a detected challenge is added to the tool reply with the chat line`, and `a page with none adds nothing`.
  - `a reply with a challenge counts agent_browser_challenge_seen once per page`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/agentBrowser src/agentClient/browserMcp.spec.ts`.
  Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.** Port the timing model from the prior art, `gateway-source/src/browser/human-input.ts`
  (log-normal draws, resampled inside the range, a session tempo).
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): human-like input and challenge detection in the agent browser`.

### Task 11: Proxy relay and device script (container)

**Files:**
- Create: `cli/assets/browser/proxy-relay.mjs`, `cli/assets/browser/device-inject.mjs`
- Modify: `cli/assets/browser/entrypoint.sh`, `cli/src/services/agentBrowser/assets.ts`, `cli/build-bundle.mjs`,
  `cli/build.mjs`
- Test: `cli/src/services/agentBrowser/proxyRelay.spec.ts`, `deviceInject.spec.ts`; new cases in `assets.spec.ts`

**Interfaces:**
- Consumes: the container environment Task 6 sets (`PROXY=1`, the secret at `/run/secrets/harness-proxy`, `DEVICE`),
  and `socks5.mjs` (Task 8).
- Produces:
  - `proxy-relay.mjs`: listens on `127.0.0.1:3128` inside the container, reads the upstream from
    `/run/secrets/harness-proxy` (JSON), and forwards CONNECT and absolute-form HTTP with `Proxy-Authorization`, or
    through a SOCKS5 username/password handshake that sends the host name.
  - `device-inject.mjs`: a standing process with its own CDP connection. It attaches to pages, frames and workers as
    they are created, and adds a script that reports the `DEVICE` values before the first line runs.
  - Entrypoint: with `PROXY=1` it starts the relay first, waits for its port, and passes
    `--proxy-server=http://127.0.0.1:<port>` and `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
  - At start the relay makes one request to the exit lookup through the proxy. Any HTTP answer that comes back
    through the proxy passes. A failure to connect to the proxy, a refused login, or a relay that does not answer
    makes the entrypoint exit with code 4. With `DEVICE` set it starts `device-inject.mjs`, detached.

- [ ] **Step 1: Write the failing tests:**
  - Relay: `adds Proxy-Authorization to CONNECT and to plain HTTP`; `does a SOCKS5 username/password handshake and
    sends the host name, never a resolved address`; `relay never connects anywhere but the proxy` (Review Focus 6:
    with the upstream down, a request gets 502 and no other socket is opened); `a 407 from the proxy is a 502 for the
    page`; `every socket has an error handler` (a reset upstream does not crash the process);
    `the start probe fails when the proxy is down or refuses the login`;
    `the start probe passes on any answer through the proxy, including a 429 or a 500 from the lookup service`.
  - Device, against a fake CDP socket: `sets Target.setAutoAttach with waitForDebuggerOnStart`; `a new page gets
    Page.addScriptToEvaluateOnNewDocument and then Runtime.runIfWaitingForDebugger`; `a worker gets Runtime.evaluate
    and then runIfWaitingForDebugger`; `a page that existed before it started is attached too`.
  - Entrypoint (text assertions in `assets.spec.ts`): the relay starts before the browser; the two proxy flags are
    present only under `PROXY=1`; exit code 4 when the relay does not come up or its start probe fails; the device script starts only when
    `DEVICE` is set.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/agentBrowser/proxyRelay.spec.ts src/services/agentBrowser/deviceInject.spec.ts src/services/agentBrowser/assets.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Port the HTTP and HTTPS relay from the prior art, `electron/browser/proxy-relay.ts`. SOCKS5 is new code.
  - Port the device script from `gateway-source/scripts/sandbox-browser-inject.py:140-190` to Node.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): proxy relay and device script for the agent browser`.

## Phase 3: the stream

### Task 12: Frame family and binary kind in the CLI and Desktop lists

**Files:**
- Modify: `cli/src/lib/terminalBinary.ts`: `browser = 8` in the enum (`:36-56`), `validKind` (`:102`),
  `terminalBinaryType` (`:112`), `maxCiphertextBytesFor` (`:125`), `terminalBinaryAadLabel` (`:281`).
- Modify: `cli/src/lib/terminalP2p.ts:49,62`: DOWN gets `agent_browser_open`, `agent_browser_ack`,
  `agent_browser_close`; UP gets `agent_browser_open_result`, `agent_browser_close`.
- Modify: `cli/src/lib/e2ee/applicationFrames.ts`: the four stream frames, declared the way `VIEWER_DOWN_TYPES` and
  `VIEWER_UP_TYPES` are. `cli/src/lib/e2ee/core.ts` is not edited.
- Modify: `desktop/lib/terminal/terminal_binary.dart:28` (the kind, for the loopback encoding).
- Test: `cli/src/lib/terminalBinary.spec.ts`, `cli/src/lib/terminalP2p.spec.ts`, the application frames spec, and
  the Dart binary test. `cli/src/lib/e2ee/core.test.ts` must pass unchanged.

**Interfaces:**
- Produces: kind `8`, in both directions, with plaintext chunks of at most the size Task 0 chose. Its ciphertext
  limit is the same as `output`'s. `validKind` and the AAD label accept it from a client and from a machine. Native Desktop needs no Dart E2EE or P2P list change: its daemon holds the encryption.

- [ ] **Step 1: Write the failing tests:** `browser kind round-trips plain, local and hop encodings` (CLI);
  `browser kind round-trips the local encoding` (Dart); `p2p lists carry the browser control frames`;
  `the four stream frames are sealed down and up`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/terminalBinary.spec.ts src/lib/terminalP2p.spec.ts src/lib/e2ee`,
  then the Dart binary test. Expected: the new cases FAIL, and `core.test.ts` passes.
- [ ] **Step 3: Add the entries everywhere listed.**
- [ ] **Step 4: Run** the same commands, plus `cd desktop && flutter test test/p2p/mobile_parity_test.dart` (it must
  still pass: the Dart P2P lists are untouched). Expected: PASS.
- [ ] **Step 5: Commit** `feat: agent browser frames and binary kind`.

### Task 13: Backend relay allows and budgets the browser family (ships first)

**Files:**
- Modify: `backend/src/lib/terminalRelay.ts:4-15` (the type lists) and `:60-70` (`limits`: a browser budget of its
  own, with Task 0's number)
- Modify: `backend/src/lib/terminalBinary.ts`: the kind enum, the parser (`:58-61`), and
  `TERMINAL_BINARY_CLIENT_UP_KINDS` (`:34`), each gaining `browser`
- Modify: `backend/src/lib/adapterWs.ts:455-478`: pass kind 8 upward under a browser rate key of its own, and route
  `agent_browser_*` JSON like `terminal_*`. When a machine's kind-8 frame is over budget, drop it and send that
  machine socket `agent_browser_transport_error {code: 'RATE'}`.
- Modify: `backend/src/lib/webWs.ts:74,541,664-675`: route the JSON down, and pass kind 8 from clients under its own
  rate key (not `terminal_paste`'s). A client over it gets `agent_browser_transport_error {code: 'RATE'}`, as it
  gets `terminal_transport_error` at `:675`.
- Modify: the second, older handler in `backend/src/lib/webWs.ts:736` (binary) and `:748` (JSON), the same way.
- Modify: `backend/src/lib/backendOnlyFrames.ts`: add `agent_browser_transport_error`, so a client cannot send it.
- Test: `backend/src/lib/terminalRelay.test.ts`, plus the adapter and web WS tests that cover the pass lists

**Interfaces:**
- Produces: the relay forwards the four `agent_browser_*` stream frames and kind 8 both ways.
  - Machine-to-client kind 8 has a budget per machine socket (the guard at `adapterWs.ts:276` is per socket), with
    Task 0's number.
  - Client-to-machine kind 8 has a small budget per client connection.
  - The four stream JSON frames get limits of their own in `limits()`, sized from Task 0's window and ack step, so
    acks are never caught by the 600-a-minute default for unlisted types (`terminalRelay.ts:81`).
  - Over any browser budget, binary or JSON, the relay drops the frame and sends its sender
    `agent_browser_transport_error {code: 'RATE'}`, for each dropped frame, at most once a second per socket.
  - The browser buckets count bytes in the existing rate metric.

- [ ] **Step 1: Write the failing tests:**
  - `relays agent_browser_open down and agent_browser_open_result up`;
  - `relays binary kind 8 both ways`;
  - `a refused machine browser frame sends that machine agent_browser_transport_error` (Review Focus 5);
  - `a refused client browser frame sends that client agent_browser_transport_error`;
  - `the transport error is sent for a drop, and at most once a second per socket`;
  - `agent_browser_ack at the rate Task 0 chose is never refused`, and `a refused browser JSON frame is answered with
    the transport error`;
  - `browser bytes are counted in the rate metric under their own keys`;
  - `a spent browser budget does not throttle terminal_output or terminal_input`;
  - `unknown agent_browser_foo is still dropped`;
  - `a client that sends agent_browser_transport_error is refused`;
  - `both web socket handlers pass kind 8`.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/lib/terminalRelay.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests plus the backend tests of the changed files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): relay agent browser streams`. This ships and deploys before Tasks 14-19
  reach users. The requests of Tasks 8 and 10 ride the existing encrypted request path and need no backend change.

### Task 14: `BrowserStreamManager`, and routing on both daemons

**Files:**
- Create: `cli/src/core/browserStreams.ts`
- Modify: `cli/src/core/api.ts` and `cli/src/services/agentBrowser.ts`: add to `AgentBrowserPort`
  `streamCommand(agentId: string): { argv: string[] } | { error: 'NO_BROWSER' | 'NOT_READY' }` (the resolved `podman`
  path, then `exec -i harness-browser-<id> socat STDIO TCP:127.0.0.1:5900`) and
  `onCloseViewers(listener: (agentId: string) => void): void`.
- Modify: `cli/src/backendSocket.ts`:
  - `:1105-1110`: route `agent_browser_*` JSON beside `terminal_*`;
  - `:913` and `handleLocalBinary` (`:833-836`): route kind 8;
  - `:446-453` (client disconnected), `:465-471` (link down) and `:805-810` (local window gone): call
    `closeConnection`, as they close terminal streams.
- Modify: `cli/src/lib/relayFrames.ts:41`: add `agent_browser_transport_error` to `BACKEND_ONLY_DOWN_TYPES`.
- Modify: `cli/src/gateway/gateway.ts`:
  - the route maps (`:427` `terminalBinary`, `:663` and `:935` `noteTerminalInputRoute`, `:908` `noteLiveStream`,
    `:1006` `routeTerminalOutputToP2p`): key them for `agent_browser_open`, `agent_browser_open_result` and
    `agent_browser_close`, in a set of browser stream ids kept apart from the terminal's `p2pStreams`, with the
    route fixed when the stream opens. The gate at `:663` gets an `agent_browser_` branch. The set is cleared where
    the terminal's maps are (`:196-211`, `:705-711`);
  - `noteTerminalInputRoute` (`:935-966`) must not move a browser stream on a relay frame;
  - `terminalBinary` (`:424-433`): a kind-8 frame that cannot be sent, on either route (the direct send failed, there
    is no session, or the relay socket is closed), is dropped and raises `browserRouteLost`. It never falls through
    from a direct link to the relay;
  - `demoteP2pConnection` (`:226, 1026`): raise `browserRouteLost` for each browser stream that used the link;
  - `backendControl` (`:668`): accept `agent_browser_transport_error`.
- Modify: `cli/src/lib/terminalP2p.ts`: `TerminalP2pResponderPool` (`:578`) gains `transport(connId)`, read from the
  connection's ICE transport as the initiator's `transport` getter is (`:333`). `null` counts as `turn`.
- Modify: `GatewayEvents` in `cli/src/core/api.ts`, `cli/src/gateway/gatewayProcess.ts:50-72` (where events are
  serialised) and `cli/src/core/gatewayLink.ts:407-497` (where they are switched): three new events,
  `browserRoute(streamId: string, route: 'direct' | 'turn' | 'relay')`, `browserRouteLost(streamId: string)` and
  `browserTransportError()`
- Modify: `cli/src/core/main.ts`: construct it beside `TerminalStreamManager` (`:1214`), and connect
  `ports.agentBrowser.onCloseViewers` to `closeAgent`
- No change to the backlog guard: `gatewayLink.terminalBinary` already returns false when the link would pile up
  (`cli/src/core/gatewayLink.ts:200-201`). The manager closes the stream with reason `backlog` on false.
- Modify: `cli/src/lib/remoteRelay.ts` (the viewing machine):
  - `sessionFor().send` (`:900-930`), `sendBinary` (`:931-954`), inbound relay binary (`:735-751`) and inbound P2P
    binary (`:1040-1051`) carry the browser frames and kind 8;
  - browser streams are kept in their own map, never in `entry.streams`, so `promoteOpenStreams` (`:1203`),
    `demoteP2p` (`:1113-1140`) and `promoteToDirect` (`:1310-1350`) do not resync or move them;
  - `demoteP2p` sends the app `agent_browser_close {reason: 'route'}` for each browser stream on the lost link, and
    sends the machine `agent_browser_close` for it over the relay;
  - in `promoteToDirect`, browser streams on the old channel are closed the same way immediately before the swap
    (`entry.p2p = shadow`, `:1345`), after the bail-outs at `:1321-1341`, so an abandoned upgrade closes nothing;
  - the plaintext guard at `:786-787` also refuses the four browser stream types when they arrive unsealed.
  - A plaintext `agent_browser_transport_error` already reaches the app unchanged (`e2ee/relayClient.ts:145`); no
    code is needed for it here.
- Modify: `cli/src/localWsServer.ts:818-837`: kind 8 from the app goes to the relay for remote machines, and to
  `backend.handleLocalBinary` for this machine
- Test: `cli/src/core/browserStreams.spec.ts`, `cli/src/lib/remoteRelay.spec.ts`, `cli/src/gateway/gateway.spec.ts`,
  `cli/e2e/gatewayProcess.e2e.ts` (new case)

**Interfaces:**
- Consumes: `AgentBrowserPort.streamCommand`, `mayOpenBrowser` and `askerFor` (Task 8); the lists (Task 12); the
  senders `deps.sendTarget` and `deps.sendBinaryTarget`, as `cli/src/lib/terminalStreamManager.ts:206-240` uses them.
- Produces: `class BrowserStreamManager { constructor(deps: { command: (agentId: string) => { argv: string[] } | { error: 'NO_BROWSER' | 'NOT_READY' }; asker: (connId: string) => Asker; sendTarget: …; sendBinaryTarget: …; spawn?: typeof spawn; measure: …; pacing: { bytesPerSecond: number }; window: { pauseBytes: number; resumeBytes: number }; chunkBytes: number })`,
  with:
  - `open(connId: string, payload: { requestId: string; agentId: string }): void`: replies with
    `agent_browser_open_result {requestId, streamId}` or `{requestId, error}`. The errors are `NOT_OWNER`,
    `NO_BROWSER`, `NOT_READY` and `VIEWER_LIMIT`.
  - `ack(connId, payload: { streamId: string; bytes: number }): void`
  - `input(connId, streamId: string, bytes: Uint8Array): void`
  - `close(connId, payload: { streamId: string }): void`
  - `closeConnection(connId: string): void`
  - `closeAgent(agentId: string): void`
  - `route(streamId: string, route: 'direct' | 'turn' | 'relay'): void`: called from the gateway's `browserRoute`
    event when a stream opens. A stream opened by a local connection is `direct` from the start. Any other stream
    with no route yet is paced as a relayed one.
  - A stream whose credit stays used up for 10 s is closed with reason `backlog`.
  - `routeLost(streamId: string): void`: called from `browserRouteLost`; closes that stream with reason `route`.
  - `transportError(): void`: called from `browserTransportError`; closes every browser stream whose route is
    `relay`, with reason `rate`. Other streams stay open.
  - Every close sends `agent_browser_close` to the client and kills the exec.
- The pacing, window and chunk values are Task 0's. `pacing.bytesPerSecond` is one total for all browser streams on
  the `relay` and `turn` routes, shared evenly between those that have bytes to send. `direct` streams are not paced.
- The Desktop app (plaintext loopback) sends `agent_browser_open` and kind-8 frames the way it sends `terminal_open`
  and input, whether the agent is local or remote.

- [ ] **Step 1: Write the failing tests** (fake `spawn` with PassThrough streams):
  - `open allowed for a local asker and for accountOwner`.
  - `open refused for a share guest whose owner flag is true` (Review Focus 1): `{owner: true, guest: 'x@y'}` gets
    `NOT_OWNER`, and nothing is spawned.
  - `open refused for owner:true without local or accountOwner`.
  - `open passes NO_BROWSER and NOT_READY through from the port`.
  - `open spawns the port's argv with ownProcessGroup`.
  - `stdout becomes kind-8 frames of at most chunkBytes`.
  - `the total output of relay and turn streams is paced to bytesPerSecond, shared between them; a direct stream is
    not paced` (fake clock).
  - `input bytes reach the child's stdin`.
  - `credit pauses the child's stdout at pauseBytes unacked and resumes below resumeBytes`, so no more than one
    window is ever queued.
  - `fifth viewer refused with VIEWER_LIMIT`.
  - `closeConnection kills every exec of that connection within one second`.
  - `closeAgent sends agent_browser_close with reason agent and kills the children`.
  - `a stream whose direct link drops is closed with reason route, and is never moved to the relay`.
  - Gateway spec: `the route of a browser stream is chosen at open and reported once, as direct, turn or relay`;
    `kind 8 output of a direct stream leaves on the direct link, and of a relay stream on the relay`;
    `a relay frame for a direct browser stream does not move it`;
    `a kind-8 frame that cannot be sent, on a direct link or on the relay, is dropped and raises browserRouteLost`;
    `a link the responder cannot classify is reported as turn`;
    `a dropped link raises browserRouteLost for each of its browser streams and for no terminal stream`;
    `a plaintext agent_browser_transport_error from the backend is accepted and raises browserTransportError`;
    `the same frame from a client is refused`.
  - `a send that returns false closes the stream with reason backlog`.
  - `a stream whose credit stays used up for 10 s is closed with reason backlog` (a lost ack).
  - `a local connection's stream is direct and is not paced`.
  - `client disconnected, link down and local window gone each close that connection's streams and kill the execs`.
  - `child exit, agent stop and agent delete close with reason agent; a client's close closes with reason closed`.
  - `a transport error closes every relayed browser stream with reason rate` (Review Focus 5), and
    `the backend's agent_browser_transport_error reaches transportError`.
  - `child exit sends agent_browser_close`.
  - `an open counts agent_browser_stream_opened, and a close counts agent_browser_stream_closed_<reason>`.
  - RemoteRelay spec (the viewing machine): `a browser stream opened while p2p is up uses it`;
    `a browser stream opened while p2p is down uses the relay and stays there when p2p comes up`;
    `a browser stream is never sent terminal_resync`;
    `when p2p drops, the app gets agent_browser_close with reason route, and the machine gets a close over the relay`;
    `a promote to a direct channel closes the old channel's browser streams with reason route at the swap, and an
    abandoned promote closes none`;
    `an unsealed agent_browser stream frame from the relay is refused`;
    `agent_browser_transport_error sent to this viewing machine reaches the app`.
  - `local agent: kind 8 from the app reaches handleLocalBinary`.
- [ ] **Step 2: Run** `npx vitest run src/core/browserStreams.spec.ts src/lib/remoteRelay.spec.ts src/gateway/gateway.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests plus `npm run test:core`, `npm run test:remote-viewers`, `npm run test:sharing`
  and the gateway e2e. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): pipe and route agent browser streams`.

## Phase 4: Desktop

### Task 15: The page (one self-contained file)

**Files:**
- Create: `desktop/tool/browser_viewer/viewer.js`, `desktop/tool/browser_viewer/build.mjs` (bundles `viewer.js` and
  the pinned noVNC into one classic script and inlines it into the HTML), `desktop/tool/browser_viewer/package.json`
  (pins noVNC and the bundler, as dev tooling only)
- Create: `desktop/assets/browser/browser_viewer.html` (generated, committed)
- Modify: `desktop/pubspec.yaml:176` (assets)
- Test: `desktop/tool/browser_viewer/viewer.test.mjs` (Node test runner, with a fake `RFB` and a fake host),
  `desktop/test/browser/viewer_asset_test.dart`

**Interfaces:**
- Produces the page ⇄ host protocol: the page posts JSON strings through `window.HarnessBrowser.postMessage`, and the
  host calls `window.harnessBrowserReceive(<JSON object literal>)` through `runJavaScript`.
  - **Host → page:** `{t:'config', mac: boolean}`, `{t:'open'}`, `{t:'data', b64}`, `{t:'closed', reason}`,
    `{t:'paste', text}`.
  - **Page → host:** `{t:'ready'}`, `{t:'data', b64}`, `{t:'copy', text}`, `{t:'state', connected: boolean}`.
  - The page wraps these in a channel object with `readyState`, `binaryType`, `protocol`, `send`, `close`, `onopen`,
    `onmessage`, `onclose` and `onerror`, and passes it to `new RFB(screen, channel)`.
  - It sets `scaleViewport = true`, `qualityLevel = 6` and `compressionLevel = 2`.
  - When noVNC closes the channel itself, the page posts `{t:'state', connected: false}`, and the host closes the
    stream.
  - Pinned: `@novnc/novnc` 1.7.0 and `esbuild` 0.28.2. noVNC 1.7.0 has one top-level `await` (an H.264 probe in
    `core/util/browser.js`); `build.mjs` rewrites that line to a `.then` and fails if a later noVNC changes it.
  - CI: the Node test needs `npm ci` in `desktop/tool/browser_viewer`. The pull request adds it to the Desktop CI job,
    since no job runs it today.

- [ ] **Step 1: Write the failing tests:**
  - `the channel has every property noVNC's Websock checks, including protocol`.
  - `bytes pass both ways`.
  - `cmd+letter is sent as ctrl+letter on mac, and cmd never reaches the remote`.
  - `ctrl+v on windows and linux becomes a paste`.
  - `paste sets the clipboard, then sends Ctrl+V`: `clipboardPasteFrom("Xin chào 👋")` is followed by key events for
    Control down, v, Control up.
  - `copy from the remote posts {t:'copy'}`.
  - `closed posts state and draws nothing of its own` (the host draws the failure).
  - Node: `the committed html equals a fresh build`.
  - Dart: `the html has no external src or href and no import statement`.
- [ ] **Step 2: Run** `node --test desktop/tool/browser_viewer/viewer.test.mjs` and
  `cd desktop && flutter test test/browser/viewer_asset_test.dart`. Expected: FAIL.
- [ ] **Step 3: Write `viewer.js` and `build.mjs`, then generate the HTML.** Adapt the key mapping from the prior art,
  `electron/remote/sandbox-viewer.ts:118-147`.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): bundled agent browser viewer page`.

### Task 16: Dart stream client, requests and model

**Files:**
- Create: `desktop/lib/browser/browser_stream.dart`, `desktop/lib/browser/browser_settings.dart` (the settings model)
- Modify: `desktop/lib/state/app_state.dart`: route `agent_browser_*` frames, `agent_browser_transport_error` and
  kind-8 binary beside `_handleTerminalBinary` (`:13330`) and `_sendTerminalBinary` (`:13349`); add the requests
  below, copying `orchestratorRequest` (`:3138`); `agentsEqual` compares `browser` (`:11357`); `createAgent` sends
  `'browser': true` (`:16118-16165`).
- Modify: `desktop/lib/core/models.dart`: `Agent.browser` (`AgentBrowser?`) near `viewerUrl` (`:529`); `fromJson`
  (`:715`) with a sanitizer that accepts only the known states, steps and errors; `copyWith` (`:838`).
- Test: `desktop/test/browser/browser_stream_test.dart`, `desktop/test/browser/browser_requests_test.dart`, and the
  model test file

**Interfaces:**
- Consumes: the frames (Task 12) and the requests (Tasks 8 and 10).
- Produces:
  - `class BrowserStream { BrowserStream({required String machineId, required String agentId, required TerminalFrameSender send, required TerminalBinarySender sendBinary})`,
    with `Future<void> open()` (throws `BrowserStreamError(code)`), `void write(Uint8List bytes)`,
    `Stream<Uint8List> get bytes`, `Future<String?> get closed` (the close reason), `Future<void> close()`,
    `void handleFrame(String type, Map<String, dynamic> payload)`, `void handleBinary(TerminalBinaryFrame frame)` and
    `void transportError()`. `}`
  - It acks with `agent_browser_ack {streamId, bytes}` at Task 0's ack step.
  - `class AgentBrowser { final String state; final String? step; final String? error; }`
  - `class BrowserAvailability { final String state; final bool restart; }`, with `state` one of `ready`, `stopped`,
    `needs_setup`, `podman_old`, `podman_memory`, `unsupported`, `unavailable`.
  - `class BrowserSettings` (mirrors `publicSettings`), with `toSave({String? password})`.
  - On `AppNotifier`:
    - `Future<BrowserAvailability> agentBrowserAvailable(String machineId)`: `unsupported` on `WsRequestFailure` code
      `UNSUPPORTED`; `unavailable` on `SERVICE_UNAVAILABLE`, `SERVICE_FAILED` or a timeout.
    - `Future<void> agentBrowserSetup(String machineId)`, `agentBrowserRestart(String machineId)`,
      `agentBrowserRetry(String machineId, String agentId)`.
    - `Future<BrowserSettings> agentBrowserSettings(String machineId, String agentId)`,
      `agentBrowserSettingsSave(String machineId, String agentId, Map<String, Object?> settings)`.
    - `Future<ProxyTestResult> agentBrowserProxyTest(String machineId, String agentId, Map<String, Object?> proxy)`,
      with `class ProxyTestResult { final bool ok; final String? address; final String? timeZone; }`.
  - `agent_browser_transport_error` for a machine's connection calls `transportError()` on every `BrowserStream` this
    Desktop has open on that machine. Each then sends `agent_browser_close`, so the machine ends its exec.

- [ ] **Step 1: Write the failing tests**, with recording senders as `test/terminal_session_test.dart` does:
  - `open sends agent_browser_open and resolves on open_result`;
  - `open error codes map to BrowserStreamError`;
  - `bytes arrive in order, with an ack at each ack step`;
  - `write sends kind 8 chunks of at most the chunk size`;
  - `agent_browser_close from the machine ends bytes and completes closed with its reason`, for each of `rate`,
    `backlog`, `route` and `agent`;
  - `transportError completes closed with rate and sends agent_browser_close`;
  - `a transport error for one machine closes only that machine's streams`;
  - `available maps UNSUPPORTED to unsupported, and a service error or a timeout to unavailable`;
  - `Agent.fromJson keeps known browser values and drops unknown ones`;
  - `agentsEqual sees a browser state change`;
  - `createAgent sends browser:true only when asked`.
- [ ] **Step 2: Run** `cd desktop && flutter test test/browser`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): agent browser stream client and model`.

### Task 17: The Browser pill and the setup dialog

**Files:**
- Modify: `desktop/lib/state/harness_launch_integration.dart:24-120` (`final bool offersBrowser`),
  `desktop/lib/super_tabs/new_agent.dart:20` (`offersBrowser: true`), `desktop/lib/state/new_harness.dart`
  (`bool get browser`, `toggleBrowser()`, `browserAvailability`, loaded when `machineId` changes), and
  `desktop/lib/widgets/new_harness_form.dart:2457-2481` (the pill and its line, only when
  `integration.offersBrowser`).
- Create: `desktop/lib/browser/browser_setup_dialog.dart`
- Modify: `docs/naming-system.md` (one line under Browser, as spec § Naming says), and
  `desktop/design/desktop-design-system.md` plus `desktop/test/swarm_elements_gallery_test.dart` and its goldens (the
  pill with its line, and the dialog).
- Test: `desktop/test/new_harness_form_test.dart`, `desktop/test/super_tab_new_agent_launch_test.dart`,
  `desktop/test/browser/browser_setup_dialog_test.dart`

**Interfaces:**
- Consumes: `agentBrowserAvailable`, `agentBrowserSetup` (Task 16).
- Produces: `Future<bool> showBrowserSetupDialog(BuildContext context, {required bool restart})` (true on
  **Install**), and `bool browserOffered({required bool web, required bool offersBrowser})`.

- [ ] **Step 1: Write the failing tests:**
  - `the pill shows only in Swarm New agent`;
  - `the pill is not offered on the web`: `browserOffered({required bool web, required bool offersBrowser})` is false
    when `web` is true. The form passes `kIsWeb`, so the test needs no browser platform;
  - `ready, stopped, podman_old and podman_memory: the pill works and shows no line`;
  - `needs_setup on this computer: the pill works and shows "Needs setup · about 5 min"`;
  - `needs_setup on another computer: disabled with "Set up Browser on Ken Mac first"`;
  - `unsupported: disabled with "Update Harness on Ken Mac first"`;
  - `unavailable: disabled with "Browser isn't available on Ken Mac right now"`;
  - `Start with needs_setup opens the dialog; Cancel creates nothing; Install calls agentBrowserSetup and creates the
    agent with browser:true`;
  - `the dialog shows "Windows restarts once." only when restart is true`.
- [ ] **Step 2: Run** `cd desktop && flutter test test/new_harness_form_test.dart test/super_tab_new_agent_launch_test.dart test/browser/browser_setup_dialog_test.dart`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `flutter test test/swarm_elements_gallery_test.dart --update-goldens`,
  review the golden diff, and run it again without the flag. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): Browser checkbox and setup dialog in Swarm New agent`.

### Task 18: The Browser button and side panel

**Files:**
- Create: `desktop/lib/browser/browser_panel.dart` (the states and the header),
  `desktop/lib/browser/browser_bridge.dart` (the page ⇄ `BrowserStream` bridge),
  `desktop/lib/browser/browser_view.dart` (webview with `loadHtmlString` and the `HarnessBrowser` JavaScript channel)
- Modify: `desktop/lib/super_tabs/view.dart`: `_agentHeader` (`:3896-3955`), adding the button after Terminal, and a `_browserOpen` flag that closes Instructions and Terminal and is closed by them; the right-pane
  choice (`:6319-6380`), adding the browser branch.
- Modify: `desktop/lib/measurement/product_measurement.dart`: report `agent_browser_opened` when a stream opens.
- Modify: `desktop/test/asset_paths_test.dart`: take `assets/browser/browser_viewer.html` off the pinned list of
  bundled-but-not-drawn assets, now that `browser_view.dart` loads it. Task 15 put it there.
- Modify: `desktop/design/desktop-design-system.md:427-433` (Top bar: Browser icon) and the gallery test and goldens
  (the header button, the setup progress, a failed state).
- Test: `desktop/test/browser/browser_panel_test.dart`, `desktop/test/browser/browser_bridge_test.dart`, and a
  click-through case in `desktop/test/swarm_v4_journey_test.dart`

**Interfaces:**
- Consumes: `BrowserStream` and the requests (Task 16), the page (Task 15), `Agent.browser`, looked up from
  `SuperTabAgent.machineId`/`harnessId` in `app.stateOf(machineId).agents`, and `showBrowserSetupDialog` (Task 17).
- Produces:
  - `class BrowserView { void post(Map<String, Object?> message); Stream<Map<String, Object?>> get messages; Widget build(BuildContext context); }`
  - `class BrowserBridge { BrowserBridge(BrowserView view, BrowserStream stream, {required bool mac}); Future<void> start(); void paste(String text); Stream<String> get copied; Future<void> close(); }`
  - `BrowserPanel({required String machineId, required String agentId, required bool thisComputer, VoidCallback? onClose})`.
    Copy follows Global Constraints.

- [ ] **Step 1: Write the failing tests:**
  - `only browser agents on the person's own machines show swarm-browser-button; an agent on a machine shared with
    them (Machine.isSharedMachine, models.dart:184) does not`;
  - `the button is not offered on the web`, through the same `browserOffered` function (Task 17);
  - `Browser, Terminal and Instructions close each other`;
  - `setup shows the four progress lines, with the current step spinning and earlier ones ticked`;
  - `setup/restart_needed shows "Restart Windows to finish" with Later and Restart; Restart calls
    agentBrowserRestart`;
  - `starting shows "Starting browser…"`;
  - `each failed state shows its copy and its button from the table`: `state_unreadable` shows no button; the others
    show Retry, which calls `agentBrowserRetry`;
  - `needs_setup shows Install on this computer, which opens the setup dialog; on another computer it shows "Set up
    Browser on Ken Mac first" and no button`;
  - `podman_install_failed shows Retry on this computer only, and Retry calls agentBrowserSetup`;
  - `offline shows "Reconnect this machine to open its browser"`;
  - `no webview shows "This computer can't show the browser"` (`WebPanePanel.webviewAvailable` false);
  - `ready opens a BrowserStream and closes it when the panel closes`;
  - `a stream closed with reason rate or backlog shows "Browser is slow here"; Retry reconnects`;
  - `a stream closed with reason route reconnects by itself once, with no message; a second route close in a row
    shows "Browser lost its connection" with Retry`;
  - `an open refused with VIEWER_LIMIT shows "Browser is open in too many places"`, and `NOT_OWNER shows "Only its
    owner can open this browser"`;
  - `a close with reason agent, and an open refused with NOT_READY, show the agent frame's browser state`;
  - `opening a stream reports agent_browser_opened once, with no other field`;
  - Bridge: `{t:'state', connected:false} from the page closes the stream`;
    `page data reaches stream.write and stream bytes reach the page`, `Paste posts the clipboard's text`,
    `copy from the page reaches the clipboard`.
  - Journey test, as a person: tick Browser, Start, Install, see progress, see the button, open the panel, close it.
- [ ] **Step 2: Run** `cd desktop && flutter test test/browser test/swarm_v4_journey_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests plus the gallery (update the goldens, review, run again). Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): agent browser panel`.

### Task 19: Browser settings page

**Files:**
- Create: `desktop/lib/browser/browser_settings_page.dart`
- Modify: `desktop/lib/browser/browser_panel.dart` (the gear opens the page inside the panel)
- Modify: `desktop/design/desktop-design-system.md` and the gallery test and goldens (the settings page)
- Test: `desktop/test/browser/browser_settings_page_test.dart`, and a case in `desktop/test/swarm_v4_journey_test.dart`

**Interfaces:**
- Consumes: `BrowserSettings` and the settings requests (Task 16).
- Produces: `BrowserSettingsPage({required String machineId, required String agentId, required VoidCallback onBack})`.

- [ ] **Step 1: Write the failing tests:**
  - `the gear opens Browser settings, and back returns to the screen`;
  - `the page loads the saved settings; a saved password shows as dots and is never in the widget tree as text`;
  - `Save sends only changed fields, and no password when it was not edited`;
  - `Test shows "Proxy works · 203.0.113.7 · Asia/Ho_Chi_Minh" or "Proxy is not reachable"`;
  - `Remove clears the proxy after Save`;
  - `Screen offers exactly the five sizes`;
  - `Human input off disables the speed choice`;
  - `Device is under Advanced and off by default`;
  - `an invalid port disables Save`;
  - Journey, as a person: open Browser, open settings, set a proxy, Test, Save, see the browser restart and come back.
- [ ] **Step 2: Run** `cd desktop && flutter test test/browser/browser_settings_page_test.dart test/swarm_v4_journey_test.dart`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests plus the gallery (update the goldens, review, run again). Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): agent browser settings`.

## Phase 5: proof

### Task 20: Real Podman, hot-path numbers, platforms

**Files:**
- Create: `cli/e2e/agentBrowserPodman.e2e.ts`. It runs only when `podman info` succeeds, and is not part of PR CI.
- Create: `cli/scripts/agent-browser-bench.ts`: terminal echo p95 with and without an open, scrolling browser stream,
  plus stream throughput.

- [ ] **Step 1: Write the e2e** `real image: create, ready, tools, stream, settings, stop keeps login, delete removes
  all`. It:
  - builds the image and starts a browser agent, then waits for `ready`;
  - runs the tool server through the relay: `browser_navigate` to a local fixture page, `browser_snapshot`,
    `browser_click` by ref, `browser_type` with "Xin chào 👋", and `browser_screenshot`;
  - opens a stream and reads the banner `RFB 003.008`;
  - sets a cookie, stops and starts the agent, and checks the cookie is still there;
  - starts a local authenticated proxy, saves it as the agent's proxy, and checks a fixture "my address" page is
    reached through it; then stops the proxy and checks the page fails and no direct connection is made;
  - turns Device on, and checks a page opened without any tool call reports the chosen cores and memory;
  - opens a fixture page with a visible challenge frame, and checks the tool reply names it with the chat line;
  - kills the browser process inside the container, and checks the service restarts it;
  - deletes the agent, and checks no container, volume, network or secret with its name remains;
  - checks the daemon's loopback socket refuses a request made from inside the container.
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/agentBrowserPodman.e2e.ts` on macOS
  (arm64), Linux (amd64) and Windows. Expected: PASS. Record the three runs in the PR.
- [ ] **Step 3: Run the bench** before (main) and after (branch), on the same machines, over a direct link and over
  the relay. Record:
  - terminal echo p95 (≤ 50 ms, and no slower than main);
  - browser throughput and frame latency;
  - relay bytes per open minute;
  - bridge throughput and UI-thread frame time on each platform, compared with Task 0;
  - daemon and Desktop CPU at rest with a browser agent running and its panel closed (within the AGENTS.md limits).
- [ ] **Step 4: Check by hand**, with screenshots in the PR:
  - set up from nothing on a clean macOS machine, a clean Windows machine (with the WSL 2 restart) and a clean Linux
    machine; time each from Install to Ready;
  - on a machine that already has Podman with a machine and containers, confirm they are unchanged afterwards;
  - log in to a test Gmail through the panel on macOS and on a Windows host;
  - ask the agent to list the newest mail and draft a reply;
  - open the same browser from a second Desktop;
  - set a real proxy, press Test, and confirm a "what is my IP" page shows the proxy's address;
  - open a reCAPTCHA demo page, see the agent ask in chat, solve it by hand in Browser, answer in chat, and see the
    agent go on;
  - paste "Xin chào 👋", and use ⌘C, ⌘V and ⌘A from a Mac;
  - on Windows, record the person's session on the signed build during setup and while a browser agent runs: the UAC
    prompt is the only window that appears (`docs/windows-rules.md`).
- [ ] **Step 5: Run the CLI coverage gates** this touches: `npm run test:core`, `test:harnessd`, `test:sharing` and
  `test:remote-viewers`. Expected: PASS. Record them in the PR.
- [ ] **Step 6: Commit** `test: agent browser e2e and bench`.
