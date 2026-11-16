# The dial knows the Codex app, names it, and a tap opens the session in it (PM for Diego, 2026-11-16)

Wave 1 of the device integration roadmap, row "Codex: open via `codex://`". On `main` (ae81a1f077) the Codex desktop
app's sessions are on the dial's "Other" page, and a tap opens nothing.

## Why

Diego, 2026-11-16: "I opened the Codex app with 4 sessions open; why does the device call the app Other?"

The app is `/Applications/ChatGPT.app`. Its bundle id is `com.openai.codex`, and its Dock name is "ChatGPT". Its agents
run as `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, a child of the app,
and it registers the URL scheme `codex`. `cli/src/cable/hosts/hostDetect.ts` `APP_BUNDLES` has no row for it, so:
- a hook whose `__CFBundleIdentifier` is `com.openai.codex` names the app `terminal`, which the dial calls "Other";
- the open scan's walk reaches `/Applications/ChatGPT.app`, reads `com.openai.codex`, finds no app, and leaves the
  session on the "Other" page until a hook comes;
- a tap has no bundle to bring forward and no pane to open.

## What the app offers (read 2026-11-16, ChatGPT 26.1111.21308)

- **Info.plist:** `CFBundleIdentifier` `com.openai.codex`, `CFBundleDisplayName` "ChatGPT", `CFBundleURLSchemes`
  `codex` (with `http` and `https`).
- **The session link is documented.** OpenAI's
  [Codex app commands, "Deep links"](https://developers.openai.com/codex/app/commands) says the ChatGPT desktop app keeps
  the `codex://` scheme, and lists `codex://threads/<thread-id>`: "A local chat. `<thread-id>` is its technical thread
  ID." That id is the Codex session id: the UUID a Codex hook sends, the open scan reads from the rollout's name, and
  `codex queue --thread` takes (`codexQueue.ts` `CODEX_THREAD`). No undocumented link is used.
- **How its sessions reach the dial.** Diego's four sessions were listed, on "Other": by their hook (Harness's Codex
  hooks in `~/.codex`, whose `__CFBundleIdentifier` the hook sends, `cli/hook/notify.mjs`), or by the open scan, which
  lists a rollout a Codex server holds open (`app: true`). Both paths are covered here; which one fired on Diego's Mac
  was not read.
- Nothing of the app's conversations and no other process's environment was read. Process paths came from `ps`'s
  `comm` column, as the scan reads them.

## Decided (PM for Diego, 2026-11-16)

1. **The app's id is `codex`, its name "Codex"**: what Diego calls it, and the vendor name the
   [Naming System](../naming-system.md) keeps. Not "ChatGPT", which is also the name of OpenAI's chat app
   (`com.openai.chat`), a different app.
2. **`codex` is the 17th app id; the firmware keeps `CABLE_MAX_APPS` 16.** The daemon's `apps` frame carries at most 16
   rows, the shown app always among them. Diego decided no firmware release now.
3. **The firmware's host name table gains `{"codex", "Codex"}`**, committed, not flashed or released.
4. **A session the open scan found, with no hook yet, opens its thread too.** The adapter's pane comes from the app
   (`codex`), the engine (`codex`) and the session id (a UUID); it needs no hint.
5. **A rest of the dial shows the session in the app while the app is in front**, as the Claude app's link does.
6. **Voice keeps `codex queue`** (#4334): nothing changes in that route; a test holds it for an app session.
7. **A link that fails brings the app forward** with `open -b com.openai.codex`, for a scanned session too (Codex
   adapter only; the Claude app's behavior does not change).
8. **Diego's check on his dial holds the merge**: a tap on a session opens that chat in the app.
9. **A link and the adapter's own `open -b` that both fail**, for a session a hook told of, let `open.ts` log its
   fallback line and run `open -b` once more, unchanged: rare and harmless (PM, 2026-11-16).
10. **Docs:** the devices row in `cli/AGENTS.md` and the adapter table in
    [the host adapter spec](../specs/2026-11-15-device-host-adapter.md) name the Codex app.
11. **The link goes to the Codex app alone** (`open -b com.openai.codex <url>`), so no other app that registers
    `codex` gets a thread id. The Claude app's link keeps its one-argument form here (Follow-ups).
12. **Not in this pull request:** the dial following the session the app's window shows (the Claude app has that from
   its mod's `session.attach`; the Codex app offers no such event that is known).

## Design

All of it is in the devices process (`cli/src/cable/hosts/`, wired in `cli/src/services/devices.ts`) and the firmware's
name table. Nothing is in the core (cli/AGENTS.md rule 7).

### The app (`hostDetect.ts`)

- `APP_BUNDLES.codex = 'com.openai.codex'`; `NAMES.codex = 'Codex'`, placed after `claude`. `APP_IDS` gets 17 ids.
- Through the tables that already read `APP_BUNDLES`, with no new code:
  - `detectApp`: a hook with that bundle id names the app `codex`;
  - `BUNDLE_APPS` and `frontAppId`: the app in front is `codex`, so the dial follows it as it follows every listed app;
  - `scannedApps`: the walk from a Codex process up to `/Applications/ChatGPT.app` reads `com.openai.codex` and names
    the app `codex` (the outermost `.app` of the path, as today);
  - `open.ts` `BUNDLES`: a tap may bring the app forward by its bundle id.
- `detectHost`: `bundle === APP_BUNDLES.codex` returns `codex`, beside the Claude app's row, so the agent's nearest
  host is the app, not `terminal`.
- The comment on `APP_IDS` now says the firmware's bound is 16 and the `apps` frame holds to it (below).

### At most 16 apps on the dial

`CABLE_MAX_APPS` is 16, and a 17th row in the `apps` frame is dropped by the firmware (`cable_client.c`), which could
drop the shown app. So the frame the daemon sends carries at most 16 rows:
- the rows in their order (the order the apps appeared, `AppRings.apps()`);
- with more than 16, the first 16 rows are sent; when the shown app is past the 16th, the 16th row gives it its place,
  so the first 15 never move (PM, 2026-11-16);
- the frame is built in `cableHost.ts` from `AppRings.apps()`; the bound is `APP_LIMIT = 16` in `select.ts`, named
  after the firmware's `CABLE_MAX_APPS`.

Seventeen apps with agents at once is not expected on one computer. The bound keeps the frame within what the dial
holds.

### The Codex app adapter (`hosts/codexApp.ts`)

One `HostAdapter`, `id: 'codex'`, `tap: 'instead'` (the link brings the app forward itself):
- `paneOf(place)`: a pane `{ adapter: 'codex', id: sessionId }` when `place.app === 'codex'`, `place.engine ===
  'codex'` and `place.sessionId` matches `CODEX_THREAD`; none otherwise. A hook's place and a scanned place both have
  these three (the scan sets the app and the session id, `observed.ts` `scanOnce`, then `learnTty` locates the panes).
- `canFocus`: macOS only. `focus(pane)`: checks the id against `CODEX_THREAD` again, then runs
  `/usr/bin/open -b com.openai.codex codex://threads/<id>` with no shell, the URL one argument, under
  `RUN_TIMEOUT_MS`; true on exit 0. `-b` hands the link to the Codex app alone, so another app that registers the
  `codex` scheme never receives a thread id (PM, 2026-11-16).
- `canShow`: macOS and the app most recently reported in front is `codex` (`cableHost.latestFront()`), asked at each
  look. `show(pane, agentId)`: the same link; `'busy'` while a link for that agent runs; `'ok'` or `'failed'`.
- A link that fails (`open` exits non-zero or times out) brings the app forward from the adapter itself:
  `/usr/bin/open -b com.openai.codex`, one line `[device] open · codex · fallback` (the line `open.ts` writes for every
  pane's fallback, never a thread id), and `focus` answers whether the app came forward, as `open.ts`'s own fallback
  answers. This covers a session only the scan found, which has no bundle until its first hook (`observed.ts`
  `entry.bundle`, as on `main` for every app), so `open.ts` alone could not bring the app. A `focus` that answers true
  ends the tap in `open.ts`: the app is never brought forward twice. A rest's `show` that fails stays `'failed'` and
  brings nothing, as the Claude app's: the app is already in front.
- Only the Codex adapter does this. The Claude app's pane exists only with its hook's bundle id
  (`claudeApp.ts` `paneOf`), so `open.ts`'s fallback already brings that app forward, and its behavior does not
  change.
- A tap and a rest at once: as the Claude app's, `open.ts` holds one tap at a time per agent, the adapter one rest at a
  time per agent, and two runs of one link do no harm.
- A Codex CLI run in a terminal inside the app carries the app's bundle id too, so it is on the "Codex" page and its
  tap runs its thread's link. The app may open that chat or only come forward; either is accepted.

The Claude app adapter (`claudeApp.ts`) does the same with its own link. The shared part (the mac check, the one-link-
at-a-time set, the front check, the outcome) moves to one helper both adapters use (`hosts/appLink.ts`), so there is
one way to open an app's session by link. `claudeApp.ts` keeps its `paneOf` and its `CLAUDE_SESSION` check; its
behavior does not change, and its specs pass unchanged.

The adapter is listed in `devices.ts` beside the Claude app's, `inFront: () => cableHost.latestFront() === 'codex'`.

### What the dial shows

- The app picker and the face: "Codex", from the `apps` frame's name, on every firmware that reads that frame.
- The voice hint for an agent the dial cannot talk to ("See it in …") names the agent's host from the firmware's own
  table. With `{"codex", "Codex"}` it says "See it in Codex"; on the firmware dials run today, which lacks that row, it
  says "See it in Terminal" until the next firmware release. A session only the scan found keeps host `terminal`
  until its first hook (as on `main`), so its hint says "See it in Terminal" on every firmware until then. A Codex app session in Harness's Codex home takes voice
  through `codex queue`, so it seldom shows that hint.

### Firmware (`devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`)

`host_name`'s table gains `{"codex", "Codex"}`. `test/test_touch_ui.py` holds the table equal to the daemon's `NAMES`
less its "Terminal" rows, so the two change together. Nothing is flashed or released.

## Failures and measures

- A tap or rest whose link fails: the existing fallback line and the swipe's existing outcome count. No new log line
  names a thread, a path or a title.
- The scan's existing line (`[observed] scan · n found · n app known · …`) counts the app sessions it now knows.
- No new path needs a new measure: the tap, the rest and the voice route each already count their outcome.

## Platforms

- **macOS:** everything above.
- **Windows, Linux:** the app id and name exist, but no hook or scan names `codex` there (no bundle id; the Linux scan
  reads exe names, and the app has none listed), and the link runs on macOS only. Nothing changes there.
- **Firmware:** one table row, built by its host tests; no device is flashed.

## Data

Nothing is stored or synced. The dial gets one more app id and name in the `apps` frame it already gets. The thread id
goes only into the `open` argument, checked against its form; it is never logged.

## Testing

- **Unit:**
  - `hostDetect.spec.ts`: the bundle id names app and host `codex`, name "Codex". Its test "APP_IDS has 16 ids, at
    most 16" becomes 17 ids, and the "at most 16" bound moves to the `apps` frame's test.
  - `frontApp.spec.ts`: `com.openai.codex` in front is `codex`.
  - `scannedApp.spec.ts`: a Codex process under `/Applications/ChatGPT.app` is the `codex` app.
  - `codexApp.spec.ts`: `paneOf` for a hook's place and a scan's place; none for another app, another engine or a
    session id that is not a UUID; `focus` runs `/usr/bin/open` with `codex://threads/<id>` as its one argument on
    macOS (as `-b com.openai.codex <url>`), nothing elsewhere; a link that exits non-zero or times out runs `open -b com.openai.codex` once and logs the
    fallback line with no thread id; `show` only with the app in front, `'busy'` while one runs.
  - `open.spec.ts`: a Codex pane whose link failed and whose app came forward runs no second `open -b`.
  - `appLink` and `claudeApp.spec.ts`: the Claude app's behavior unchanged.
  - `cableHost.spec.ts`: 17 apps with agents send 16 rows, the shown one kept.
  - `observed.spec.ts`: a scanned Codex app session gets app `codex` and a `codex` pane; its words still go through
    `codex queue`.
  - Firmware `test/test_touch_ui.py`: the name table matches the daemon's.
- **End to end** (`cli/e2e/`, the real daemon and a fake dial, as `dialClaudeAppFollow.e2e.ts`): a fake Codex hook with
  `__CFBundleIdentifier=com.openai.codex` puts its agent on a "Codex" page. Nothing taps or swipes, so nothing reaches
  `open`; no real Codex session or app runs.
- **By Diego, on his Mac and dial** (holds the merge; the PM asks him once the PR is ready): with the Codex app open
  on its sessions, the dial shows a "Codex" page; a tap on one opens that chat in the app; a rest with the app in front
  shows it.

## Follow-ups

- **The Claude app's link by its bundle id too:** `open -b com.anthropic.claudefordesktop claude://code/continue?…`,
  so no other app that registers `claude` gets a session id (`claudeApp.ts`).

## Done when

1. Codex app sessions are on a "Codex" page, whether a hook or the open scan found them.
2. A tap on one opens its chat in the app on macOS; a link that fails brings the app forward, whether a hook or the
   scan found the session.
3. A rest with the app in front shows the session in it.
4. The dial's words reach an app session through `codex queue`, as before.
5. The `apps` frame never carries more than 16 rows, and the shown app is always among them.
6. The firmware's name table has `{"codex", "Codex"}` and its host tests pass.
7. The tests under Testing pass, and Diego's check on his dial.
