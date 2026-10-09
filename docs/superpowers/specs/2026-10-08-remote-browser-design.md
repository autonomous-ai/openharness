# Remote Browser: viewer surface v2 → "browser" agent (like terminal)

## Context
The user wants a browser that runs on a machine (box or Mac) and is used from the Harness app **like a real local browser**: the pane matches the app pane's size exactly, and touch, scroll, typing, copy-paste, a URL bar with back/forward, and tabs/popups all work. The work is done in phases:
1. **Viewer surface v2** on desktop, mobile and web. It is used first for harness viewers, for example the Blender model-viewer, where the client cannot use the WKWebView proxy.
2. **Agent type "browser"**, like terminal: it can be chosen in New agent, appears in the agent list, supports rename/stop/resume, and survives a daemon restart. **All Browser agents on one machine share one long-lived Chrome profile** (as on a local machine): one Chrome per machine, and each Browser agent is one tab. It runs in its **own sub-process, following the harnessd architecture**.
3. P2P for surface frames: measure first, build later.

Current state: path B `viewer_surface` (`cli/src/lib/interactiveViewer.ts`, a separate headless Chrome per surface via `cli/src/sharing/viewer.ts`) pulls one JPEG `captureScreenshot` at a time, polls every 160 ms when idle, uses `deviceScaleFactor:1`, supports only mouse/key/text, and allows 160–1920 × 120–1200. Only desktop web uses it (`desktop/lib/viewer/interactive_viewer.dart`); mobile has no viewer yet; frames travel through the E2EE relay, not P2P.

## Phase 1: viewer_surface v2 (no new frame type, no protocol bump)

**Protocol (additions to the same `viewer_surface` request)**
- Request: `op: 'frame'|'input'|'close'`, logical `width,height` (160..3840 × 120..2400), `scale?` (DPR 1..3), `mobile?`, `touch?`, `dark`, `reload?`, `after?` (seq: long-poll for up to 1000 ms until a newer frame exists), `events?` (≤64).
- New event: `touch {event: touchStart|Move|End|Cancel, points[{x,y,id}] ≤5}` → `Input.dispatchTouchEvent`. `key` gains `text?` and `commands?` (allowlist: selectAll/copy/cut/paste/undo/redo, for ⌘ on Mac). `text` is capped at 64 KB (paste). `copy`/`cut` → the reply carries `clipboard`.
- Reply: `{data, mime, width, height, scale, seq, hostActions, editable?, clipboard?, unchanged?}`.
- Pixel cap: `width·height·scale² ≤ 4.2M`. The daemon lowers the scale itself and reports the scale it actually used.
- Compatibility: a client recognizes v2 by the presence of `seq`. A new client sends its first request within the v1 limits until it sees `seq`. An old daemon ignores the new fields. An old client receives the v1 shape.

**Daemon**
- `cli/src/sharing/viewer.ts`: add an `onEvent(method, params)` hook in the ws handler (next to `Page.loadEventFired`). Share (`SharedViewerPool`) stays unchanged.
- `cli/src/lib/interactiveViewer.ts`:
  - The capture becomes a "screen": `Page.startScreencast({jpeg, q75, maxWidth/Height})`. It keeps the newest frame plus `seq` and **acks when the client takes a frame**. Chrome holds back frames on its own while nobody is watching, so fps follows the client's speed. If no frame arrives within 1 s, it falls back to `captureScreenshot`. hostActions are read at most every 500 ms.
  - When the size changes: `Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:scale,mobile})` + `setTouchEmulationEnabled` + restart the screencast.
  - Request rules: a second frame poll on the same surface settles the earlier one with `unchanged` (not `VIEWER_BUSY`). `op:'input'` runs immediately even while a poll is waiting and is queued per surface (BUSY only above 256 events). The input reply is `{ok, seq, editable?, clipboard?}`. The idle timer is refreshed on every request. A waiter settles on close/closeConnection.
- Long-poll, not push: keeping one frame in flight per surface gives back-pressure through the relay for free. Push (`CoreApi.clients.viewerFrame`, `core/api.ts:240`) is left to Phase 3, because the `gateway.target` queue is unbounded.

**Clients**
- Desktop and web, `desktop/lib/viewer/interactive_viewer.dart`: a `frame(after: seq)` loop replaces the 160 ms poll. Input is sent immediately with `op:'input'` (mouseMoved events are still coalesced). `scale = MediaQuery.devicePixelRatioOf`. Resize is debounced by about 100 ms. ⌘C/X/V map to copy/cut/paste. The image is drawn at its logical size. Native desktop keeps the WKWebView proxy (path A) for loopback viewers.
- Mobile (the file is copied into `mobile/lib/viewer/`; there is no shared package):
  - add `'viewer_surface'` to `mobile/lib/e2ee/envelope.dart` (and `mobile/test/encrypted_down_types_test.dart`);
  - add `viewerUrl/viewerError/dsh` to the mobile Agent model (`mobile/lib/core/models.dart`);
  - a "Viewer" button in `TerminalPage` opens a full-screen page with `mobile:true, touch:true`; the native keyboard toggles with `editable`; voice becomes `text` events.

## Phase 2: "browser" agent + harnessd-browser process

**Spike first (step 0):** headless Chrome with a CDP pipe on Linux and Mac. Sign in to Google, claude.ai and chatgpt.com, and measure touch-to-frame latency through the relay. If blocked, use full Chrome inside a headless compositor (cage/labwc with `WLR_BACKENDS=headless`).

**The "browser" engine is anchored to a pane (this keeps the registry invariant "every row has a pane")**
- The tmux pane runs a placeholder: `/bin/sh -c "printf 'Harness browser. Open it in Harness to see the page.\n'; exec tail -f /dev/null"`. Create/list/rename/stop/resume/restart and surviving daemon restart or reboot use the terminal's existing path unchanged; an old client sees only the placeholder line.
- `cli/src/engines/types.ts`: add `'browser'` to `ENGINES`, add `BROWSER_ENGINE` and `isPaneEngine(e)` (terminal|browser), make `ProcessEngine` exclude both, and make `PROCESS_ENGINES` filter on `!isPaneEngine`. The compiler then forces an entry in each `Record<AgentEngine,…>` map (`lib/engineLaunch.ts`, `lib/agentNames.ts` → 'Browser', `lib/engineBin.ts`, `lib/registry.ts:774`).
- Change `isTerminalEngine` to `isPaneEngine` wherever the meaning is "has no process engine": `core/agents/{launches,create,restart,events,list}.ts`, `core/turns/activity.ts`, `core/wifiAgents.ts`, `core/terminals/sessions.ts`, `lib/{engineLaunch (placeholder argv),stopAgentService,resumeAgentService,resumeCapability,restoreAgents,terminalAgentReconciler:399,captureResumeIdentity,stoppedAgents,sessionSync,apiInstructions}.ts`, `device/deviceFleet.ts`, `services/windowNames.ts`, `teams/service.ts`, `dsh/{adapters,compatibility}.ts`. Keep `isTerminalEngine` where an engine is adopted or released (`discovery.ts:100`, `terminalAgentReconciler.ts:87`, `registry.ts` terminalHost/adopt/release, `core/main.ts:1877`, `resumeStoppedAgent.ts:40`). The `releaseEngine` call at `restoreAgents.ts:262` never runs for browser.
- `lib/engineProbe.ts`: `browser` counts as installed when `viewerBrowser()` finds Chrome.

**The `browser` service (no BrowserPort is needed, because core does not call the service)**
- `core/api.ts`: `BROWSER_REQUESTS = ['browser_surface']`. `lib/e2ee/applicationFrames.ts`: add it to `MACHINE_REQUESTS`.
- `services/browser.ts` `startBrowser(core)`: a `browser_surface` handler (payload = viewer_surface v2 plus navigation). It rejects the request if the asker is not `asker.owner` or the agent is not a browser engine. Surfaces are keyed by `asker.connection` and closed on `closed`.
- Separate process: `services/browserProcess.ts` (modeled on `monitorProcess.ts`), `SERVICE_HOSTS.browser = {services:['browser'], onDemand:true, askedSince:5}`, bump `HARNESSD_PROTOCOL` 4→5, `SERVICE_RUNNERS`, `services/inline.ts`, `serviceHost.serve` in `core/main.ts` plus the on-demand set (`core/main.ts:1169`), and update `leanEntry.spec.ts` and `architecture.spec.ts`.
- A tab is opened lazily on the first request. A sweep every 10 s, and on every request, closes the tabs of agents that are no longer alive. Resume reopens the saved URL from `<dataDir>/browser/tabs.json` (newest 200).
- The Phase 1 "screen" is separated from the page source: `InteractiveViewers` takes a source, either viewer (a separate Chrome per surface, as before) or browser (a tab in the shared Chrome, not closed when a surface closes). Several surfaces can watch one tab; the viewport follows the surface that last sent input or opened.

**`cli/src/lib/browserChrome.ts`: the machine's shared Chrome**
- Flags: `--headless=new --remote-debugging-pipe --user-data-dir=<dataDir>/browser/profile` (0700), `--password-store=basic --use-mock-keychain --enable-unsafe-swiftshader --mute-audio --no-first-run --no-default-browser-check --disable-blink-features=AutomationControlled --force-webrtc-ip-handling-policy=disable_non_proxied_udp`. CDP runs over a pipe (fd 3/4, NUL-delimited JSON), so **no TCP port is opened** and another local process cannot control a browser that holds logins.
- It starts on demand, shuts down when no browser agent is alive, and restarts itself if it dies. A pid ledger and orphan cleanup (modeled on `dsh/viewerLedger.ts`) avoid a stale `SingletonLock`.
- Each tab: `Target.createTarget({url, newWindow:true})`, `setFocusEmulationEnabled`, a UA without "HeadlessChrome" (a mobile UA when `mobile`), `Browser.setDownloadBehavior deny`, and file choosers blocked.
- Popups and new tabs: `Target.setDiscoverTargets`. A target whose `openerId` belongs to an agent is pushed onto that agent's tab stack and the surface switches to it; closing it pops back to the opener (this suits OAuth popups). At most 8 tabs per stack. A JS dialog produces a reply with `dialog`, and the client answers with a `dialog` event.
- Navigation (events on `op:'input'`, browser source only): `navigate{url}` (http/https/about:blank, ≤8 KB), `back`, `forward`, `reload`, `stop`, `closeTab`, `dialog{accept,text?}`. Every reply carries `page {url,title,canGoBack,canGoForward,loading,tabs,dialog?}`.
- Security: owner-only; no CDP port; downloads and uploads blocked; the daemon's loopback endpoints already reject requests carrying `Origin` and check `Host` (`localWsServer.ts`, `hookServer.ts`, `lib/loopbackRequest.ts`); rely on Chrome's Local Network Access for LAN/loopback and verify it in e2e; if it leaks, add a proxy that filters private addresses.

**Clients**
- `browser` (globe icon) in `desktop/lib/widgets/engine_identity.dart` (next to `kTerminalEngine`) and in the mobile engine list. Creating one needs no folder (mobile `new_agent_page.dart` drops the folder requirement for browser).
- Desktop/web: in `pane_grid.dart`, the terminal branch is followed by a branch for an agent with `engine=='browser'`, which renders a BrowserPanel = `RemoteViewerSurface` (calling `browserSurface`) plus a toolbar with back/forward/reload/URL/tab count.
- Mobile: `AgentSwipeHost` (`phone/agent_swipe.dart:352,419`) shows a BrowserPage when the engine is browser.
- Add `'browser_surface'` to both Dart envelopes.

## Phase 3: measure first
Add `renderMs`/`bytes` to the reply, a round-trip histogram on the client, and a surface workload in `e2e/perf.e2e.ts`. If the relay is the bottleneck: return `*_surface_result` over the P2P data channel when the request arrived over P2P, send frames as binary (no base64), and only then consider push with an ack window.

## Verification
- **Phase 1:** `cli/src/lib/interactiveViewer.spec.ts` (fake screen: seq/long-poll `unchanged`, a new poll replaces the old one, input runs in parallel in the right order, scale cap, touch/commands/copy validation, v1 shape when fields are missing); `services/viewers.spec.ts` at 100% (`npm run test:core`); extend `e2e/viewersProcess.e2e.ts` (skipped without Chrome): a v2 poll with `scale:2` returns an image with twice the pixels, and a click changes the next frame; Dart tests for `InteractiveViewerSession` (fallback without seq, input sent separately, resize debounce); mobile envelope parity and a widget test for the viewer page. Manual check: the Blender viewer on the iOS simulator, web and desktop.
- **Phase 2:** core specs at 100% for the browser branches (launches/create/restart/list); lib specs for restore/stop/resume/reconciler (browser is never dormant) and the placeholder argv; `services/browser.spec.ts` at 100% (fake BrowserChrome: owner-only, rejects a non-browser agent, sweep, tabs.json, navigation validation); `lib/browserChrome.spec.ts` (fake pipe: NUL framing, popup stack, dialog); `leanEntry.spec.ts`, `architecture.spec.ts`; `e2e/browserAgent.e2e.ts` (real Chrome if available): create → appears in `agents_list`; navigate to a loopback fixture; two agents share cookies; `window.open` → 2 tabs → close → 1; stop/resume keeps the URL; daemon restart → row and tab come back; the process does not run until the first request; `HARNESSD_TEST_FAULTS=browser.browser_surface` → `SERVICE_FAILED` while other agents keep running; a "public" page cannot fetch loopback. `npm run typecheck`, `npm run test:core`, `npm run test:harnessd`, `npm run test:e2e`.
- Do not commit until told to.

## Risks
1. Google/Cloudflare block headless Chrome/CDP → the step 0 spike; fallback is full Chrome in a headless compositor.
2. Background tabs may stop painting → `newWindow` plus focus emulation, checked in e2e.
3. The profile's secrets on disk are protected only by 0700 permissions and the mock keychain; RAM for N tabs is not measured yet → add a tab cap once there are numbers.
4. Local Network Access differs between Chrome versions and distro Chromium builds → fall back to the filtering proxy.
5. The placeholder pane costs one tmux pane and one `tail` per browser agent, in exchange for not changing the registry invariant in about 10 modules.

## Decisions made during Phase 1 implementation
These supersede the matching text in the plan.
- Unchanged poll replies may carry `hostActions` (`{seq, unchanged: true, hostActions}`), read under the same 500 ms throttle, so Monitor navigation never stalls on a static page. Clients deliver host actions from unchanged replies too.
- The daemon clamps a poll's `after` to the capture's current seq, so a surface recreated behind the client's back cannot freeze.
- Real Chrome (154) emits screencast frames at CSS size even under `deviceScaleFactor` > 1. At scale > 1 the screencast is therefore only the change signal and backpressure; the frame handed out is a fresh `Page.captureScreenshot` (one extra round trip per dense frame). Upgrade path: launch each renderer with `--force-device-scale-factor`.
- After a screencast restart (resize) or a failed restart, the capture takes a fallback screenshot when no frame has arrived since the restart. `stop()` wakes waiting polls.
- The phone's viewer surface lives in `mobile/lib/surface/`, not `mobile/lib/viewer/`, which already holds the E2EE viewer identity.
- The real-Chrome check is `cli/src/lib/interactiveViewer.chrome.spec.ts`, run only with `RUN_REAL_CHROME_VIEWER=1` (and a browser found), instead of an extension of `e2e/viewersProcess.e2e.ts`. CI runners ship Chrome, so an availability check alone would run it in the fast PR shards.
- A `touchEnd`/`touchCancel` lists only the lifted or cancelled finger; `touchStart`/`touchMove` list every finger down. Chrome releases the points a `touchEnd` lists, so listing the remaining ones released those and left the lifted finger stuck. The daemon rejects a `touchStart`/`touchMove` with no points.
- A phone on a v1 machine (no `seq` yet) sends one finger as pointer events (`mousePressed`/`mouseMoved`/`mouseReleased`) and ignores further fingers, because the v1 parser refuses `type: 'touch'`. Once the machine proves v2, touches go out as touch events.
- The input reply carries `clipboard` only when the selection is non-empty, and a cut deletes only a non-empty selection, so ⌘C/⌘X with nothing selected neither wipes the local clipboard nor eats the character after the caret. Key `commands` no longer accept `copy`/`cut`/`paste`; the clipboard goes through `copy`/`cut`/`text` events.
