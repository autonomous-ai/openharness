# The dial knows the Codex app, names it, and a tap opens the session in it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** A Codex desktop app session is on a "Codex" page of the dial, whether a hook or the open scan found it; a tap opens its chat in the app, a rest shows it while the app is in front, and the dial's words still reach it through `codex queue`.

**Architecture:**
- **One table row** (`cable/hosts/hostDetect.ts`) names the app: id `codex`, name "Codex", bundle `com.openai.codex`. The hook, the app in front, the open scan and a tap's `open -b` all read that table, so they need no new code.
- **One adapter** (`cable/hosts/codexApp.ts`, new) holds the app's pane: the thread id, from the app, the engine and the session id alone. Its link is `codex://threads/<id>` through `/usr/bin/open`. A link that fails on a tap brings the app forward from the adapter itself.
- **One helper** (`cable/hosts/appLink.ts`, new) is the one way to open an app's session by link. The Claude app adapter moves onto it with no change in behavior.
- **The `apps` frame carries at most 16 rows**, the shown app always among them: `codex` is the 17th app id and the firmware holds 16.
- **The firmware's name table** gains one row, committed, not flashed.
- Everything is in the devices process. Nothing goes through the core, and nothing is stored.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`); the round dial's firmware in C with its Python host test.

**Spec:** `docs/plans/2026-11-16-dial-codex-app-design.md`. Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md` (Protect the core, rule 7).

## Base

- Branch `feat/dial-codex-app`, on `main` at `ae81a1f077`, in the worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-codex-app`. Nothing else has to merge first.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund`. This worktree's `cli/` has no `node_modules`. One process runs it, never two tasks at once.
- The tasks name functions, never lines. Names at the base:
  - `hostDetect.ts`: `APP_BUNDLES`, `NAMES`, `APP_IDS`, `BUNDLE_APPS`, `detectHost`, `detectApp`, `hostDisplayName`, `appDisplayName`, `UNKNOWN_APP`.
  - `claudeApp.ts`: `createClaudeAppAdapter`, `CLAUDE_SESSION`. `open.ts`: `OPEN`, `createOpenActions`, `bundleOf`. `orca.ts`: `OrcaDeps`, `RUN_TIMEOUT_MS` (10 000). `codexQueue.ts`: `CODEX_THREAD`.
  - `select.ts`: `RING_PLACES`, `AppRings.apps()`. `cableHost.ts`: `DaemonCableHost.appList`, `pickApp`, `latestFront`.
  - `services/devices.ts`: `claude` (the Claude app adapter), `adapters`, `noting`, `opener`, `log`.
  - Spec helpers: `claudeApp.spec.ts` `recorder`, `holding`; `open.spec.ts` `recorder`, `run`, `forward`; `observed.spec.ts` `setup`, `fakeActions`, `Fakes`, `counted`, `THREAD`; `cableHost.spec.ts` `setup`, `agent`, `ids` (in `the dial that shows one app at a time`); `devices.spec.ts` `startHere`, `mac`, `hook`, `attach`, `listed`, `said`, `host`, `orcaRuns`, `codexRuns`, `swiped`, `fakeListener`, `inClaudeApp`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The app's id, name, bundle and dial row | `cli/src/cable/hosts/hostDetect.ts`, `hostDetect.spec.ts`, `frontApp.spec.ts`, `scannedApp.spec.ts`, `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`, `devices/harness-device/firmware/test/test_touch_ui.py` | none | high | `hostDetect.spec.ts`, `frontApp.spec.ts`, `scannedApp.spec.ts`, `test_touch_ui.py` |
| 2 One way to open an app's session by link | `cli/src/cable/hosts/appLink.ts` (new), `appLink.spec.ts` (new), `claudeApp.ts` | none | xhigh | `appLink.spec.ts` |
| 3 The Codex app adapter | `cli/src/cable/hosts/codexApp.ts` (new), `codexApp.spec.ts` (new), `open.spec.ts` | 1, 2 | xhigh | `codexApp.spec.ts`, `open.spec.ts` |
| 4 At most 16 apps on the dial | `cli/src/cable/hosts/select.ts`, `select.spec.ts`, `cli/src/cable/cableHost.ts`, `cableHost.spec.ts` | 1 | high | `cableHost.spec.ts`, `select.spec.ts` |
| 5 The observed source holds the pane and the queue | `cli/src/cable/hosts/observed.spec.ts` | 1, 3 | medium | none: no behavior changes (tests of Tasks 1 and 3 through the source) |
| 6 The devices list the adapter | `cli/src/services/devices.ts`, `devices.spec.ts` | 1, 3 | high | `devices.spec.ts` |
| 7 End to end: a "Codex" page | `cli/e2e/dialCodexApp.e2e.ts` (new) | 1, 6 | high | none: no behavior changes (the end-to-end test of Tasks 1 to 6) |
| 8 The docs name the Codex app | `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md` | none | medium | none: docs only, one commit |

Longest chain: 1 → 3 → 6 → 7 (or 2 → 3 → 6 → 7): four tasks.

- Tasks 1, 2 and 8 share no file and start at once. Task 8 describes what Tasks 2, 3 and 6 build, as this plan gives it, and needs none of them done first.
- Task 4 needs Task 1 only: with 16 ids, a 17th app folds into "Other" (`select.ts` `pageOf`), so its failing test cannot be written sooner. It runs beside Tasks 2, 3, 5 and 6.
- Tasks 5 and 6 share no file and run beside each other.
- Task 7 needs Task 6 because its claim is about the wired daemon: an agent with a Codex pane is listed and nothing reaches `open`.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/hostDetect.ts`, `appLink.ts`, `claudeApp.ts`, `codexApp.ts`, `select.ts`, `cli/src/cable/cableHost.ts` | **Devices service process**, and only there | Their specs (PR CI `cli-tests`) |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`, local) |
| `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` | **Firmware**, the round dial; not flashed | `test_touch_ui.py` (PR CI `firmware-checks`) |
| `cli/e2e/dialCodexApp.e2e.ts` | Test: the real daemon, a fake dial, a fake Codex hook | Verification 1 |
| `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md` | Docs | Review |

Not changed, and a diff in any is a finding:
- anything under `cli/src/core/`, and `cli/src/architecture.coreFiles.txt`;
- `cable/hosts/open.ts`, `observed.ts`, `codexQueue.ts`, `frontApp.ts`, `scannedApp.ts`, `claudeApp.spec.ts`;
- `cable/cableSession.ts`, `cli/hook/notify.mjs`;
- the firmware's `cable_client.h` (`CABLE_MAX_APPS` stays 16) and `version.txt`.

## Global Constraints

- **The app.** Id `codex`, name "Codex", bundle id `com.openai.codex`. Never "ChatGPT": `com.openai.chat` is another app and names nothing.
- **The link.** `/usr/bin/open codex://threads/<thread-id>`: no shell, the URL one argument, under `RUN_TIMEOUT_MS`. No undocumented link.
- **The thread id** is the Codex session id. It is checked against `CODEX_THREAD` (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`, imported from `codexQueue.ts`) in `paneOf`, and again before every command. It is never logged.
- **The pane** exists when `place.app === 'codex'`, `place.engine === 'codex'` and the session id passes. No hint is read.
- **The fallback.** A tap whose link exits non-zero or times out runs `/usr/bin/open -b com.openai.codex` from the Codex adapter, and logs `[device] open · codex · fallback`. When that `open -b` fails too, for a session a hook told of, `open.ts` (unchanged) logs its own fallback line and runs `open -b` once more (spec, Decided 9). A rest that fails stays `'failed'` and brings nothing forward.
- **Codex only.** The Claude app's behavior does not change, and `claudeApp.spec.ts` passes with no edit.
- **`codex queue` is not touched.** `codexQueue.ts` and `ObservedSource.send` are not edited.
- **At most 16 rows** in the `apps` frame (`APP_LIMIT = 16`), the shown app always among them. `CABLE_MAX_APPS` stays 16.
- **No firmware release.** One table row, committed. Nothing is flashed, and `version.txt` does not move.
- **Rule 7.** No file under `cli/src/core` changes. The devices process owns all of it.
- **macOS only** for the link and `open -b`. On Linux and Windows nothing runs and nothing a person sees changes.
- **Logs.** No new line names a thread, a path, a title or a bundle id.
- **Tests never reach the real thing:** no real Codex session, no real Codex app, no `/usr/bin/open` (a recording runner), no other process's environment, none of the app's conversations. Throwaway homes only (cli/AGENTS.md rule 6). No fixed sleeps.
- **Not in this pull request:** the dial following the session the app's window shows.

## Review Focus

1. **OpenAI's chat app** (`com.openai.chat`, also "ChatGPT" in the Dock) in front, in a hook or over a scanned session: it is not the Codex app, and names nothing. Task 1 (`OpenAI's chat app is not the Codex app`, and its rows in `frontApp.spec.ts` and `scannedApp.spec.ts`).
2. **A process named `codex` on Linux or Windows** (the CLI's own name): the scan and the front read exe names there, and it must not put a session on the Codex page. Task 1 (`a process named codex names no app`).
3. **A Codex CLI session in another app** (Ghostty, Orca, a terminal nothing names): it has a thread id too, and must get no `codex://` pane; its tap brings its own app. Task 3 (`paneOf: none for …`), Task 5 (`a Codex session in Ghostty has no Codex pane`).
4. **A session that leaves the app after the dial listed it** (resumed in a terminal): its pane goes at that event, and no tap or rest runs its link. Task 5 (`the pane is the latest event's`).
5. **The app not installed, or a link nothing handles:** the link and `open -b` both fail, the tap ends false after a bounded number of runs, and the dial is told "Codex did not open it." Task 3 (`a link and an app that both fail answer false`), Task 6 (`the link and the app both fail: the dial is told so`).

---

### Task 1: The app's id, name, bundle and dial row

**Layer:** devices service process, and the firmware's name table. **Depends on:** none. **Effort:** `high` (two components; the firmware's test holds the two tables equal, so they change in one commit).

**Red tests:** `hostDetect.spec.ts`, `frontApp.spec.ts`, `scannedApp.spec.ts`, `test_touch_ui.py`.

**Files:**
- Modify: `cli/src/cable/hosts/hostDetect.ts`
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`host_name`'s table)
- Test: `cli/src/cable/hosts/hostDetect.spec.ts`, `frontApp.spec.ts`, `scannedApp.spec.ts`, `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- Produces:
  - `APP_BUNDLES.codex === 'com.openai.codex'`; `NAMES.codex === 'Codex'`, placed after `claude`, so `APP_IDS` has 17 ids with `codex` right after `claude`.
  - `detectHost({ __CFBundleIdentifier: 'com.openai.codex' }) === 'codex'`, its row beside the Claude app's.
  - Through the tables, with no new code: `detectApp` and `frontAppId` give `codex` for the bundle; `open.ts` `bundleOf` gives the bundle; the listener's `front` takes `codex`.
  - The firmware's `host_name("codex")` is `"Codex"`.

- [ ] **Step 1: Write the tests.**
  - `hostDetect.spec.ts`:
    - `the Codex app's bundle id is codex, read Codex`: for `{ __CFBundleIdentifier: 'com.openai.codex' }`, `detectHost` and `detectApp` are `'codex'`; `hostDisplayName('codex')` and `appDisplayName('codex')` are `'Codex'`.
    - `a multiplexer inside the Codex app is on the Codex page`: `{ TMUX_PANE: '%3', __CFBundleIdentifier: 'com.openai.codex' }` gives host `tmux`, app `codex`.
    - `OpenAI's chat app is not the Codex app` (a pin): `{ __CFBundleIdentifier: 'com.openai.chat' }` gives app `UNKNOWN_APP`, host `'terminal'`.
    - `APP_IDS has 16 ids, at most 16, …` becomes `APP_IDS has 17 ids, and every one has a display name`: `toHaveLength(17)`, the `toBeLessThanOrEqual(16)` line goes (the bound is the frame's, Task 4), and `APP_IDS.indexOf('codex')` is `APP_IDS.indexOf('claude') + 1`.
    - In `the unknown app reads Other, …`, `others` has 15.
  - `frontApp.spec.ts`: `BUNDLES` gains `['com.openai.codex', 'codex']`. The list of values that are none gains `'com.openai.chat'`, `'codex'`, `'Codex.exe'` and `'ChatGPT'`.
  - `scannedApp.spec.ts`, in `scannedApps on macOS`:
    - `a Codex session under the Codex app is in codex: the outermost .app of its path`: rows `[500, 499, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex']` and `[499, 1, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT']`, bundles `{ '/Applications/ChatGPT.app': 'com.openai.codex' }`. The answer is `new Map([[500, 'codex']])`, and `bundleId` was called with `'/Applications/ChatGPT.app'` alone.
    - `OpenAI's chat app at that path names nothing` (a pin): the same rows with `'com.openai.chat'` give an empty map.
    - `a process named codex names no app` (a pin, platform `'linux'`): rows `[500, 499, 'codex']`, `[499, 498, 'bash']`, `[498, 1, 'codex']` give an empty map.
  - `test_touch_ui.py`: the `named` table of "See it in" hints gains `{"codex","See it in Codex"}`.
- [ ] **Step 2: Run.**
  - `cd cli && npx vitest run src/cable/hosts/hostDetect.spec.ts src/cable/hosts/frontApp.spec.ts src/cable/hosts/scannedApp.spec.ts`. Expected: FAIL in the tests that name `codex` and the count; the three pins pass.
  - From the repository root: `python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL, the C assertion on `named` (the dial says "See it in Terminal").
- [ ] **Step 3: Commit** `test(dial): the Codex app has an id, a name and a row on the dial (red)`.
- [ ] **Step 4: Implement.**
  - `hostDetect.ts`: the three rows above. The comment on `APP_IDS` now says: seventeen ids; the firmware holds 16 (`CABLE_MAX_APPS`), and the `apps` frame holds to it (`APP_LIMIT`, `select.ts`).
  - `ui_habitat.c`: `{"codex", "Codex"}` after `{"claude", "Claude"}`. Nothing else in the firmware.
- [ ] **Step 5: Run** both commands of step 2, then `cd cli && npx vitest run src/cable src/services/devicesListener.spec.ts src/devices && npm run typecheck`. Expected: PASS. A spec outside this task's files that counted 16 ids is a finding: stop and report it.
- [ ] **Step 6: Commit** `dial: the Codex app has an id, a name and a row on the dial's name table`.

### Task 2: One way to open an app's session by link

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (the one place an id from a hook reaches `/usr/bin/open`, and the one-link-at-a-time set).

**Red test:** `cli/src/cable/hosts/appLink.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/appLink.ts`, `cli/src/cable/hosts/appLink.spec.ts`
- Modify: `cli/src/cable/hosts/claudeApp.ts`
- Not edited: `claudeApp.spec.ts`

**Interfaces:**
- Produces, in `appLink.ts`:
  ```ts
  export type AppLinkDeps = Pick<OrcaDeps, 'run' | 'platform'> & { inFront(): boolean }
  /** One app whose session opens by a link of the app's own. */
  export interface AppLink {
    /** The form of a session id the link may name: checked again before every command. No `g` flag. */
    session: RegExp
    url(session: string): string
    /** A tap's own way to bring the app forward once its link failed, answering whether the app came. Absent, a failed
     *  link answers false and the opener's fallback decides (open.ts). A rest never runs it. */
    forward?(): Promise<boolean>
  }
  export type AppLinkVerbs = Pick<HostAdapter, 'canFocus' | 'focus'> & Required<Pick<HostAdapter, 'canShow' | 'show'>>
  export function createAppLink(deps: AppLinkDeps, link: AppLink): AppLinkVerbs
  ```
- The verbs, which are today's `claudeApp.ts` with the session's form and the link passed in:
  - `canFocus`: macOS. `canShow`: macOS and `deps.inFront()`, asked at each call.
  - `focus(pane)`: false off macOS or for an id not in `link.session`, with nothing run. Else `OPEN [link.url(pane.id)]` under `RUN_TIMEOUT_MS`; true on exit 0. On any other end: `link.forward()`'s answer when there is one, else false.
  - `show(pane, agentId)`: `'failed'` off macOS or for a bad id; `'busy'` while a rest's link for that agent runs; else `'ok'` or `'failed'` by the link's exit. The set is a rest's own: a tap is never refused by it.
  - No verb uses `this` (adapter.ts rule 2).
- `claudeApp.ts` keeps `CLAUDE_SESSION`, `paneOf`, `id` and `tap`, and spreads `createAppLink(deps, { session: CLAUDE_SESSION, url })` with `claude://code/continue?session=<id>` and no `forward`. Its signature does not change.

- [ ] **Step 1: Write `appLink.spec.ts`**, with a made-up app (`session: /^s[0-9]{1,3}$/`, `url: (s) => \`fake://open/${s}\``) and a recording runner as `claudeApp.spec.ts`'s `recorder` and `holding`. No test runs a command.
  - `canFocus is macOS only; canShow also needs the app in front, asked each time`.
  - `focus runs the link alone, the URL its one argument`: the call is `{ file: '/usr/bin/open', args: ['fake://open/s1'], timeoutMs: 10_000 }` and the answer true. Exit 1 and no exit (`null`) answer false after that one call. Linux and Windows: false, no call. Ids `''`, `'s1&x=1'`, `'-b'`, `'s1/../s2'`: false, no call.
  - `with a forward, a tap whose link failed runs it once and answers what it answered`: for exit 1 and `null`, and a forward that answers true and one that answers false. A link that worked, a bad id, and Linux run no forward.
  - `a rest never runs the forward`: exit 1 gives `'failed'`, the forward not called.
  - `a rest: ok, failed, and nothing for a bad id or off macOS`.
  - `a link still running drops the next rest for that agent, and another agent's runs`.
  - `a tap is not refused while a rest's link runs, and a rest is not busy while a tap runs`.
  - `the verbs work spread into another object`: `{ ...createAppLink(…) }`'s `focus` and `show` called on the copy.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appLink.spec.ts`. Expected: FAIL (`./appLink.js` does not exist).
- [ ] **Step 3: Commit** `test(dial): one way to open an app's session by its link (red)`.
- [ ] **Step 4: Implement** `appLink.ts`, and move `claudeApp.ts` onto it. The helper's header comment says why there is one (two apps open a session by link; one way to do it), and keeps the comments that say why a rest has its own set and why a failed rest brings nothing forward.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable/hosts/appLink.spec.ts src/cable/hosts/claudeApp.spec.ts src/cable/hosts/open.spec.ts src/cable/hosts/observed.spec.ts src/services/devices.spec.ts && npm run typecheck`. Expected: PASS. From the repository root, `git diff --stat -- cli/src/cable/hosts/claudeApp.spec.ts cli/src/cable/hosts/open.spec.ts cli/src/cable/hosts/observed.spec.ts cli/src/services/devices.spec.ts` prints nothing: an existing expectation that has to change is a finding.
- [ ] **Step 6: Commit** `dial: one way to open an app's session by its link, and the Claude app uses it`.

### Task 3: The Codex app adapter

**Layer:** devices service process. **Depends on:** 1 (`APP_BUNDLES.codex`), 2 (`createAppLink`). **Effort:** `xhigh` (an id from a hook or a file name reaches `/usr/bin/open`).

**Red tests:** `cli/src/cable/hosts/codexApp.spec.ts`, `cli/src/cable/hosts/open.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/codexApp.ts`, `cli/src/cable/hosts/codexApp.spec.ts`
- Test: `cli/src/cable/hosts/open.spec.ts` (its `recorder` gains the Codex adapter after `claude`, over the same runner and log)
- Not edited: `open.ts`

**Interfaces:**
- Consumes: `createAppLink`, `AppLinkDeps` (Task 2); `APP_BUNDLES.codex` (Task 1); `CODEX_THREAD` (`codexQueue.ts`); `OPEN` (`open.ts`); `RUN_TIMEOUT_MS` (`orca.ts`).
- Produces:
  ```ts
  export function createCodexAppAdapter(
    deps: AppLinkDeps & { log(line: string): void },
  ): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>>
  ```
  - `id: 'codex'`, `tap: 'instead'`, no `type`.
  - `paneOf(place)`: `{ adapter: 'codex', id: place.sessionId }` when `place.app === 'codex'`, `place.engine === 'codex'` and `place.sessionId` passes `CODEX_THREAD`; none otherwise.
  - The verbs are `createAppLink(deps, { session: CODEX_THREAD, url, forward })` with `codex://threads/<id>`. `forward` logs `[device] open · codex · fallback`, then runs `OPEN ['-b', APP_BUNDLES.codex]` under `RUN_TIMEOUT_MS`, true on exit 0.

- [ ] **Step 1: Write the tests.** `THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'`, `CODEX_APP = 'com.openai.codex'`, a recording runner and log, `link = { file: '/usr/bin/open', args: [\`codex://threads/${THREAD}\`], timeoutMs: 10_000 }`, `forward = { file: '/usr/bin/open', args: ['-b', CODEX_APP], timeoutMs: 10_000 }`.
  - `codexApp.spec.ts`:
    - `its id is codex, its link takes the place of open -b, and it types nothing`.
    - `paneOf: a hook's place and a scan's place both give the thread's pane`: `{ host: 'codex', app: 'codex', hints: { __CFBundleIdentifier: CODEX_APP }, engine: 'codex', sessionId: THREAD, pid: 4242 }` and `{ host: 'terminal', app: 'codex', hints: {}, engine: 'codex', sessionId: THREAD }` both give `{ adapter: 'codex', id: THREAD }`.
    - `paneOf: none for another app, another engine, or a session id that is no thread id`: app `'ghostty'`, `'orca'` and `'terminal'` (one whose hints carry the Codex bundle too: the app decides, never a hint); engine `'claude'` in app `codex`; no session id; and ids `THREAD.toUpperCase()`, `` `${THREAD}/../x` ``, `` `${THREAD}?x=1` ``, `'--args'`, `'local_abc'`, `'my-thread'`, `''`.
    - `canFocus is macOS only; canShow also needs the app in front, asked each time`.
    - `focus runs /usr/bin/open with the thread's link as its one argument`: calls are `[link]`, the answer true, no log. Linux and Windows: false, no call. A pane id not in the form: false, no call, no log.
    - `a link that exits non-zero or times out brings the app forward once, in one line with no thread id`: for exit 1 and `null`, the answer is true, calls are `[link, forward]`, logs are `['[device] open · codex · fallback']`, and no log holds `THREAD`.
    - `a link and an app that both fail answer false`: exits `[1, 1]` and `[null, null]`; two calls, one line.
    - `a rest runs the link alone; one that fails stays failed and brings nothing forward`: `'ok'` with `[link]`; exit 1 and `null` give `'failed'`, calls `[link]`, no log.
    - `a rest with the app not in front is not asked for, and one with a bad id or off macOS runs nothing`.
    - `a link still running drops the next rest for that agent`: `'busy'`.
  - `open.spec.ts`, the Codex targets written by hand (`target()` reads hints alone): hooked `{ bundle: CODEX_APP, pane: { adapter: 'codex', id: THREAD } }`, scanned `{ pane: { adapter: 'codex', id: THREAD } }`.
    - `the Codex app: its thread through codex://threads, which brings the app forward itself`: `can` is true, `open` true, calls `[link]`.
    - `a Codex pane whose link failed and whose app came forward runs no second open -b`: exits `[1]`, hooked. `open` is true, calls are exactly `[link, forward]`, logs exactly one fallback line.
    - `a Codex session only the scan found still gets its app when its link fails`: the same for the scanned target, which has no bundle.
    - `the link and the adapter's own open -b both failed` (spec, Decided 9): `open.ts` stays unchanged, so for a session a hook told of it logs its own fallback line and runs `open -b` once more. Hooked, exits `[1, 1]`: calls `[link, forward, forward]`, two fallback lines, `open` true by the third. Scanned (no bundle, so `open.ts` has no app to bring), exits `[1, 1]`: false after two calls, one line.
    - `on Linux a Codex pane opens nothing`: `can` false for both targets, no call.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/codexApp.spec.ts src/cable/hosts/open.spec.ts`. Expected: FAIL (`./codexApp.js` does not exist).
- [ ] **Step 3: Commit** `test(dial): a tap opens a Codex app session by its thread's link (red)`.
- [ ] **Step 4: Implement** `codexApp.ts`. Its header comment says: the link is OpenAI's documented one, the id came from a hook or a rollout's name so it is checked before the link, and why the adapter brings the app forward itself (a session only the scan found has no bundle until its first hook, so the opener alone could not).
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/cable/hosts && npm run typecheck`. Expected: PASS. From the repository root, `git diff --stat -- cli/src/cable/hosts/open.ts` prints nothing.
- [ ] **Step 6: Commit** `dial: the Codex app adapter opens a session by its thread's link, and brings the app forward when the link fails`.

### Task 4: At most 16 apps on the dial

**Layer:** devices service process. **Depends on:** 1 (the 17th id). **Effort:** `high`.

**Red tests:** `cli/src/cable/cableHost.spec.ts`, `cli/src/cable/hosts/select.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/select.ts`, `cli/src/cable/cableHost.ts` (`appList`, and the comment over `listAgents`)
- Test: `cli/src/cable/hosts/select.spec.ts`, `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Consumes: `APP_IDS` with 17 ids (Task 1); `AppRings.apps()`.
- Produces:
  - `select.ts`: `export const APP_LIMIT = 16`, its comment naming the firmware's `CABLE_MAX_APPS` (`cable_client.h`), which drops a 17th row.
  - `DaemonCableHost.appList`: the rows of `AppRings.apps()` in their order. Up to `APP_LIMIT` rows: all of them. Past that: the first `APP_LIMIT`, unless the shown app is past them; then the first `APP_LIMIT - 1` and the shown app's row: the 16th row gives the shown app its place, so the first 15 never move (spec, "At most 16 apps on the dial").
  - Only the frame is bounded. The shown app's ring, the filter's counts and a pick still read every app.

- [ ] **Step 1: Write the tests.**
  - `select.spec.ts`: `the apps frame holds sixteen rows, the firmware's`: `expect(APP_LIMIT).toBe(16)`.
  - `cableHost.spec.ts`, in `the dial that shows one app at a time`, with one agent in each of `APP_IDS` in that order (`a-<app>`), and a second in `ghostty`, so Ghostty is shown with no draw:
    - `17 apps with agents send 16 rows, the shown one kept`: the first read's ids are `APP_IDS.slice(0, 16)`, with `shown` `'ghostty'` among them. Then `host.pickApp(APP_IDS[16])` is `'switched'`, and the next read's ids are `[...APP_IDS.slice(0, 15), APP_IDS[16]]`, its `shown` `APP_IDS[16]`, and its last row `{ id: 'terminal', name: 'Other', count: 1, waiting: 0 }`: the 16th row gave the shown app its place, and the first 15 did not move.
    - In the same test: that read's agents are `['a-terminal']` and its `total` 1. The bound is the frame's, not the ring's.
    - `16 apps send every row` (a pin): `APP_IDS.slice(0, 16)`, one agent each, give 16 rows in that order. It reads the rows alone: with 16 equal apps the shown one is a draw.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/select.spec.ts src/cable/cableHost.spec.ts`. Expected: FAIL (`APP_LIMIT` is not exported; the frame holds 17 rows).
- [ ] **Step 3: Commit** `test(dial): the apps frame carries at most 16 rows, the shown app among them (red)`.
- [ ] **Step 4: Implement.** The comment in `appList` says why: the firmware keeps the first 16 rows and drops the rest, which could be the shown app.
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/cable && npm run typecheck`. Expected: PASS, no other expectation edited.
- [ ] **Step 6: Commit** `dial: the apps frame carries at most 16 rows, the shown app always among them`.

### Task 5: The observed source holds the pane and the queue

**Layer:** tests of the devices service process. **Depends on:** 1 (`detectApp` gives `codex`), 3 (`createCodexAppAdapter`). **Effort:** `medium` (one file, tests only).

**Red test:** none. `observed.ts` already hands every adapter the app, the engine and the session id (`locate`), for a hook's session and a scanned one (`scanOnce` sets the app, then `learnTty` locates). These tests hold that for the Codex app; no production file changes. One commit.

**Files:**
- Test: `cli/src/cable/hosts/observed.spec.ts`
- Not edited: `observed.ts`. A test here that needs it changed is a finding: stop and report it.

**Interfaces:**
- Consumes: `createCodexAppAdapter` (Task 3).
- `fakeActions` gains `codexInFront: vi.fn(() => true)` (in `Fakes` too) and, after the Claude app's adapter, `createCodexAppAdapter({ ...deps, inFront: () => fake.codexInFront(), log: () => {} })`. Its commands go to the inert `ran`.

- [ ] **Step 1: Write the tests**, in a new `describe('ObservedSource and the Codex app')`. `inApp = { engine: 'codex', sessionId: THREAD, hostHints: { __CFBundleIdentifier: 'com.openai.codex' } }`. A scanned session is set up as in `a Codex session the open scan found takes voice before its first hook` (`open`, `owners` with `{ pid: 100, engine: 'codex' }`, `externals`), with `apps: async () => new Map([[100, 'codex']])`.
  - `a Codex app session a hook told of is on the Codex page, and a tap takes its thread's pane and its app`: the agent matches `{ app: 'codex', host: 'codex' }`; `focus` hands `actions.open` `{ bundle: 'com.openai.codex', pane: { adapter: 'codex', id: THREAD } }`.
  - `one only the scan found has its thread's pane before any hook, and no bundle`: the agent matches `{ app: 'codex', host: 'terminal' }` with no `appPending`; its caps have `focus: true`; `focus` hands `actions.open` `{ pane: { adapter: 'codex', id: THREAD } }` and no `bundle` key.
  - `a rest shows it in the app only while the app is in front`: `hasPane` true and `showPane` `'ok'`, `ran` called with `('/usr/bin/open', ['codex://threads/' + THREAD], 10_000)`. With `codexInFront` false: `hasPane` false, `showPane` `'failed'`, no further run. On `'linux'`: `hasPane` false.
  - `the dial's words still go through codex queue, a hook's session and a scanned one alike`: with the rollout under `/home/u/.codex/sessions/…`, caps have `voice: true`, `send` answers `{ ok: true }`, `codexQueue.send` was called with `[THREAD, 'next']`, `counted` ends with `'codex'`, and `ran` was not called.
  - `a Codex session in Ghostty has no Codex pane`: hints `{ TERM_PROGRAM: 'ghostty' }`; `focus` hands `{ bundle: 'com.mitchellh.ghostty' }` alone, and `hasPane` is false.
  - `a scanned Codex session whose app is not known yet has no pane`: `apps` answers an empty map; caps have `focus: false`.
  - `a Claude Code session under the Codex app has no Codex pane`: engine `'claude'` with the Codex bundle; `focus` hands `{ bundle: 'com.openai.codex' }` alone.
  - `the pane is the latest event's`: after `inApp`, an event with `{ TERM_PROGRAM: 'ghostty' }`; `hasPane` false, and `focus` hands `{ bundle: 'com.mitchellh.ghostty' }` alone.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: PASS, every existing test with it.
- [ ] **Step 3: See them fail once, and commit none of it.** Take the Codex adapter's line out of `fakeActions`; the first three tests fail. Put it back; the run passes.
- [ ] **Step 4: Commit** `test(dial): a Codex app session keeps its thread's pane and its queue, a hook's and a scan's alike`.

### Task 6: The devices list the adapter

**Layer:** devices service process. **Depends on:** 1 (the listener's `front` takes `codex`), 3 (`createCodexAppAdapter`). **Effort:** `high` (`services/devices.ts` is in the 100% gate).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `createCodexAppAdapter` (Task 3); `cableHost.latestFront()`.
- Produces, in `devices.ts`: `createCodexAppAdapter({ ...apps, inFront: () => cableHost.latestFront() === 'codex', log })`, listed in `adapters` right after the Claude app's entry, inside the list `noting` wraps. No `noteLink`: that echo guard is for the Claude app's attach, and the Codex app sends none.

- [ ] **Step 1: Write the tests**, in `describe('the mod's voice and Orca, …')`, beside the Claude app's. `THREAD` as above, `CX = observedAgentId('codex', THREAD)`, `inApp = { engine: 'codex', sessionId: THREAD, hostHints: { __CFBundleIdentifier: 'com.openai.codex' } }`, `link = ['/usr/bin/open', ['codex://threads/' + THREAD], 10_000]`, `forward = ['/usr/bin/open', ['-b', 'com.openai.codex'], 10_000]`, and a runner over `mac` that answers the next of a list of exit codes, then 0.
  - `a Codex session in the Codex app opens on its thread; a link that fails brings the app forward once, in one line with no id`: exits `[1]`. `listed()` is `[{ id: CX, name: 'api', caps: 'sf' }]`; `openAgent(CX)` is undefined; `orcaRuns` is `[link, forward]`; `said()` is `['[device] open · codex · fallback']`. A second tap adds `[link]` alone. No log line holds `THREAD`. This is the red test.
  - `the link and the app both fail: the dial is told so` (spec, Decided 9: `open.ts` unchanged, so a hooked session's tap runs `open -b` once more, with a second fallback line): exits `[1, 1, 1]`. `openAgent(CX)` is `{ ok: false, error: 'Codex did not open it.' }`, and `orcaRuns` is `[link, forward, forward]`, and `said()` holds two `[device] open · codex · fallback` lines.
  - With `inCodexApp`, a copy of `inClaudeApp` for this session (fake timers, the fake listener, `front`):
    - `with the Codex app in front, a rest on a Codex app agent runs one thread link, and no open -b`: `front('codex')`; `swipeSwitches(CX)` is true; after `swipeEnded(CX, 'rest')`, `swiped('ok')`, `orcaRuns` is `[link]`, and `said()` is `['[device] swipe · ok']`. Red too.
    - `another app in front, none, or no front known: no rest is asked for`: `swipeSwitches(CX)` is false with no front, and after `front` of `'claude'`, `'orca'` and `'none'`.
    - `a rest whose link fails stays failed, and brings nothing forward`: exits `[1]`; `swiped('failed')`, `orcaRuns` is `[link]`.
  - In `describe('codex queue, …')`: `a Codex app session's words still go through codex queue, and nothing is opened` (a pin): `started({ orca: mac }, { hostHints: { __CFBundleIdentifier: 'com.openai.codex' } })`; `sendTurn(ID, 'run the tests')` is `{ ok: true }`, `codexRuns` holds the one `queue --thread` call, `orcaRuns` is empty, and `said()` is `['[device] voice · codex']`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the two red tests (`orcaRuns` is `[forward]` alone; `swipeSwitches` is false).
- [ ] **Step 3: Commit** `test(dial): the devices open a Codex app session by its link, on a tap and on a rest (red)`.
- [ ] **Step 4: Implement** the one adapter and its place in the list. The comment says why it has no `noteLink`.
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`, and no existing expectation of `devices.spec.ts` edited.
- [ ] **Step 6: Commit** `dial: the devices open a Codex app session by its thread's link, on a tap and on a rest with the app in front`.

### Task 7: End to end: a "Codex" page

**Layer:** test: the real daemon, a fake dial, a fake Codex hook. **Depends on:** 1 (the page), 6 (the wired adapter: the listed agent has a Codex pane, and the test holds that nothing reaches `open`). **Effort:** `high`.

**Red test:** none. No production file changes. One commit.

**Files:**
- Create: `cli/e2e/dialCodexApp.e2e.ts`

**Interfaces:**
- Consumes: `IsolatedDaemon`, `until` (`e2e/harness/daemon.ts`); `Desk` (`desk.ts`); `CodexOutside` (`codexOutside.ts`). The shape is `dialClaudeAppFollow.e2e.ts`'s `fresh`.
- The file sends no `agent.open` and no `focus` from the dial, and starts no `harness hardware watch`. So no tap, no rest and no app in front exists, and nothing can reach `/usr/bin/open` (its header comment says so).

- [ ] **Step 1: Write the test** `a Codex session whose hook names the Codex app is on a "Codex" page, and nothing is opened`.
  - A daemon of its own (`env: { CABLE_DISABLE: 'false' }`), `HARNESSD_TEST_DIAL_PORT` on a file under its root, a dial plugged with `{ appFilter: 'v1' }`, its first `agents.end` in hand.
  - `new CodexOutside(d, 'api', children, { __CFBundleIdentifier: 'com.openai.codex' })`, then `hook('SessionStart', { source: 'startup' })`.
  - The dial hears an `apps` frame whose `shown` is `'codex'` and whose rows hold `{ id: 'codex', name: 'Codex', count: 1 }`, and an `agent` row with the session's id (`observedAgentId('codex', sessionId)`) and `host: 'codex'`. Each is waited for with `dial.next`, from the index noted before the hook.
  - The daemon's log holds no `[device] open` line and no `[device] swipe` line, and none of the session id, `com.openai.codex` or `codex://`.
  - `afterEach` closes the children, the desk and the daemon, as the Claude app's file does.
- [ ] **Step 2: Run** `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialCodexApp.e2e.ts`. Expected: PASS, one test, none skipped.
- [ ] **Step 3: Commit** `test(e2e): a Codex hook that names the Codex app puts its agent on a Codex page`.

### Task 8: The docs name the Codex app

**Layer:** docs. **Depends on:** none. **Effort:** `medium` (two docs, no code).

**Red test:** none. No behavior changes. One commit.

**Files:**
- Modify: `cli/AGENTS.md` (the `devices` row of its process table)
- Modify: `docs/specs/2026-11-15-device-host-adapter.md` (the table under "The adapters")

- [ ] **Step 1: Edit `cli/AGENTS.md`.** In the `devices` row, where it says a swipe "while the Claude app is in front, shows the session there", add the Codex app: a tap opens a Codex app session by `codex://threads/<id>`, and a rest does while the Codex app is in front, as the Claude app's link (`cable/hosts/codexApp.ts`; both apps open by link through `cable/hosts/appLink.ts`). Nothing else in the row changes.
- [ ] **Step 2: Edit the adapter table** in `docs/specs/2026-11-15-device-host-adapter.md`.
  - A `codex` row after `claude`: file `hosts/codexApp.ts`; `paneOf` the app `codex`, the engine `codex` and a thread id (`CODEX_THREAD`), no hint read; `type` none; `focus` the `codex://threads/<id>` link, macOS only, and `open -b com.openai.codex` when the link fails; `show` the link, while the Codex app is in front.
  - The `claude` row's `focus` and `show` name `hosts/appLink.ts`, the one way both apps open a session by link.
  - Nothing outside the table changes.
- [ ] **Step 3: Check** from the repository root: `git diff --stat` lists these two files alone, and every name the new text uses (`codexApp.ts`, `appLink.ts`, `CODEX_THREAD`, `codex://threads/<id>`, `com.openai.codex`) is the one Global Constraints and Tasks 2 and 3 give.
- [ ] **Step 4: Commit** `docs(dial): the devices row and the adapter table name the Codex app`.

---

## Verification

**Platforms the pull request names:** macOS, where all of it runs. Linux and Windows: the id and the name exist, and nothing a person sees changes; unit tests with `platform: 'linux'` and `'win32'` hold that no link and no `open -b` runs (Tasks 2, 3, 5). Firmware: one table row, held by its host test; no dial is flashed.

**Never touched by a tester or a test:** the real Codex app (`/Applications/ChatGPT.app`), any real Codex session, `/usr/bin/open`, another process's environment, the app's conversations, Diego's everyday daemon (port 18473), `~/.codex`, `~/.claude`, his dial, any backend, production.

**Temporary workflow:** none. The end-to-end check has a workflow of the repo's own (`cli-e2e.yml`), and PR CI runs the unit specs and the firmware's host tests.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 1).

**Local gates**, recorded in the pull request (PR CI does not run the first), on this Mac at the final head:
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. It runs `cli-core` (`npm run test:core`, 100% per file under `src/core/` and `src/services/`). **This gate applies:** `cli/src/services/devices.ts` and `devices.spec.ts` change. Its receipt goes in the pull request's body before the tested commit is pushed.
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/services/devicesListener.spec.ts src/architecture.spec.ts`.
- `python3 devices/harness-device/firmware/test/test_touch_ui.py`, from the repository root (needs `cc`; about 10 s). It prints `touch UI: PASS`.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/cable/hosts/open.ts cli/src/cable/hosts/observed.ts cli/src/cable/hosts/codexQueue.ts cli/src/cable/hosts/claudeApp.spec.ts devices/harness-device/firmware/version.txt devices/harness-device/firmware/main/cable_client.h` prints nothing.
- Not needed: `npm run test:harnessd`, the serial and PTY specs, `cargo test` in `device-app`, `make desktop-test`. No path of theirs changes.

**1. A fake Codex hook puts its agent on a "Codex" page (tester)**
- Build and run, on this Mac, at the final head: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/dialCodexApp.e2e.ts`. `E2E_BUNDLE=1` builds the daemon that ships; `TMPDIR=/tmp` keeps its socket path under the limit. About a minute.
- Why on a Mac as well as on GitHub: the Codex pane exists on macOS only, so only here is the listed agent one a tap could open, and the "nothing reaches `open`" claim one that could fail.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6):
  - a throwaway home, data folder and Codex home, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal;
  - no backend, no account, no secret;
  - the Codex session is a hook run by hand with `__CFBundleIdentifier=com.openai.codex` and a rollout in the throwaway Codex home. No Codex and no app runs.
  - Nothing taps, rests or reports an app in front, so nothing reaches `open`. Before and after the run, `pgrep -fl "/Applications/ChatGPT.app"` reads the same.
- A person sees: one test passes, none skipped. On failure the daemon's log is printed; it holds no `[device] open` line.
- On GitHub, by hand, once at the final head: Actions → CLI end to end → Run workflow, branch `feat/dial-codex-app` (`.github/workflows/cli-e2e.yml`). Every shard passes, and the summary lists `e2e/dialCodexApp.e2e.ts`. The link goes in the pull request.
  - What else it shows: `dialAppFilter`, `dialAppFilterOnDial`, `dialClaudeAppFollow`, `dialPaneFollow`, `deviceCodex`, `deviceClaudeOrca`, `deviceWithoutApp` and `devicesProcess` pass over 17 app ids, the bounded frame and the moved Claude app adapter.
  - Isolation: the suite's own, as above.
- Later pull requests: the file joins the nightly run by itself (the suite takes `e2e/**/*.e2e.ts`). No workflow changes, and no proposal is needed.

**2. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run the specs of Tasks 1 to 6 on Linux; `firmware-checks` runs `test_touch_ui.py` with the firmware's other host tests. Nothing is started by hand.

**3. Numbers:** none to take. No hot path gains work: `appList` reads at most 17 rows it already held, and the link runs only on a tap or a rest.

**4. On a dial, by a tester:** none. No firmware is flashed, and the fake dial hears the frames a dial does.

**5. Diego's own check, on his Mac and his dial. Holds the merge.**
- **The owner's, not a tester's:** it needs his login, his Codex app with his own sessions, his dial and his eye. The PM asks him once the pull request is ready. No tester and no agent runs it, and nobody opens his app for him.
- What runs: the daemon built from the pull request's head (`make install-cli` in that checkout). The dial keeps the firmware it has.
- With the Codex app open on its sessions, he sees:
  1. a "Codex" page on the dial, in the app list and on the face, with those sessions;
  2. a tap on one opens that chat in the app;
  3. with the app in front, a rest on another session shows it in the app.
- Known and accepted, from the spec: an agent the dial cannot talk to says "See it in Terminal" until the next firmware release.

**6. Against production:** none.
