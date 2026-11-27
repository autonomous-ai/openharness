# A Claude app session the scan found switches on a swipe before its first hook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** On macOS, a Claude Code session in the Claude app that only the open scan found (no hook yet) shows in the Claude app on a dial's rest and opens on a tap, by the `local_…` id its own process record holds.

**Architecture:**
- **The reader** (`cli/src/cable/hosts/record.ts`, replacing `recordName.ts`): `readRecord` answers `{ name?, hostSession? }` from the one record read the scan already makes.
- **The scan** (`observed.ts`) keeps `hostSession` on the entry until the first hook clears it; `locate()` hands it to every adapter on `Place.hostSession`.
- **The Claude app adapter** (`claudeApp.ts`) takes a pane from it when the scan's app is `'claude'`, and gets a `forward()` for a tap whose link failed, as `codexApp.ts` has.
- Devices process only: `cli/src/cable/hosts/` and `cli/src/services/devices.ts`. Nothing in `cli/src/core`, nothing stored, no new log line but `[device] open · claude · fallback`, which the opener already writes today for a hooked session.

**Tech Stack:** TypeScript daemon (Node, vitest), `cli/`.

**Spec:** `docs/plans/2026-11-18-dial-claude-app-swipe-before-hook-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core) and `cli/src/services/AGENTS.md`.

## Base

- Branch `fix/dial-claude-app-swipe-before-hook`, at `0306bc0837`, worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-claudeapp-swipe`. Nothing else has to merge first.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (this worktree's `cli/` has no `node_modules`). One process runs it, never two tasks at once.
- Names at the base (the tasks name functions, never lines):
  - `adapter.ts`: `Place`, `Pane`, `HostAdapter`. `appLink.ts`: `createAppLink`, `AppLinkDeps`, `AppLink.forward?`. `codexApp.ts`: `createCodexAppAdapter` (the `forward()` to copy). `hostDetect.ts`: `APP_BUNDLES.claude` (`com.anthropic.claudefordesktop`). `open.ts`: `openPath`. `orca.ts`: `RUN_TIMEOUT_MS`.
  - `claudeApp.ts`: `createClaudeAppAdapter`, `CLAUDE_SESSION`. `recordName.ts`: `readRecordName`, `RecordNameOptions`, `MAX_RECORD_BYTES`.
  - `observed.ts`: `ObservedDeps.recordName`, `Entry`, `locate`, `learnTty`, `pair`, `scanOnce`, `namesOf`, `ingest` (the hook path that sets `entry.paired = undefined`).
  - `services/devices.ts`: `observedSource` (its `recordName:` line), the `createClaudeAppAdapter` call beside `cmuxApp`.
  - Spec helpers: `claudeApp.spec.ts` `recorder`, `holding`, `place`, `pane`, `link`; `codexApp.spec.ts` `forward`, `FALLBACK` (shapes to copy); `recordName.spec.ts` `record`, `named`, `app`, `read`; `observed.spec.ts` `setup`, `fakeActions`, `flushed`, `ev`; `devices.spec.ts` `readers`, `start`, `orca`, `orcaRuns`, `logs`, and in `describe('the session the Claude app shows turns the dial …')` `dialWith`, `rest`, `continued`, `LOCAL`, `BUNDLE`, `wait`, `fakeListener`, `FRONT_SETTLE_MS`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The Claude app adapter places a scanned session and brings the app on a failed tap | `cli/src/cable/hosts/adapter.ts`, `claudeApp.ts`, `claudeApp.spec.ts`, `open.spec.ts`, `observed.spec.ts` (`fakeActions` only), `cli/src/services/devices.ts` (the adapter call only) | none | high | `claudeApp.spec.ts` |
| 2 The record reader gives the Claude app's session id | `cli/src/cable/hosts/record.ts` (new), `record.spec.ts` (new) | none | medium | `record.spec.ts` |
| 3 The scan places it until its first hook, wired | `cli/src/cable/hosts/observed.ts`, `observed.spec.ts`, `cli/src/services/devices.ts`, `devices.spec.ts`, `cli/src/cable/hosts/recordName.ts` and `recordName.spec.ts` (removed), `docs/specs/2026-11-15-dial-session-name.md` | 1, 2 | high | `observed.spec.ts`, `devices.spec.ts` |

Longest chain: 1 → 3 (or 2 → 3), two tasks. Tasks 1 and 2 share no file and start at once.

- Task 1 touches `observed.spec.ts` and `devices.ts` only because `createClaudeAppAdapter` now needs `log` and every call must pass it (`npm run typecheck` covers `src/**`); Task 3 edits both files again, so it waits for Task 1.
- Task 2 writes the new reader beside the old one, which `devices.ts` still imports: the tree stays green with no task touching `devices.ts` twice at once. Task 3 removes the old files in the same pull request (root `AGENTS.md`, "Nothing left behind").

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/*.ts` | **Devices service process** only | their specs (PR CI `cli-tests`) |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`, local) |
| `docs/specs/2026-11-15-dial-session-name.md` | Docs | review |

Not changed, and a diff in any is a finding: anything under `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `appLink.ts`, `open.ts`, `codexApp.ts`, `scannedApp.ts`, `hostDetect.ts`, `cli/hook/`; the order of `adapters` in `devices.ts`.

## Global Constraints

- **The id's source.** `hostSession` is the record's `hostSessionId` only when it is a string, `entrypoint === 'claude-desktop'` and the record's `sessionId` is the listed session's. Every other check of the reader stands: the record's path, the 16 KiB bound (`MAX_RECORD_BYTES`), JSON. It keeps nothing and logs nothing.
- **Both must say the Claude app.** A pane from `hostSession` only when `place.app === 'claude'` (the app the scan read from the parents, `scannedApp.ts`) and `hostSession` passes `CLAUDE_SESSION` (`/^local_[A-Za-z0-9-]{1,64}$/`). A record alone, or the app alone, places nothing. A Herdr pairing (`app: 'herdr'`) wins with no rule of its own.
- **Until the first hook.** The scan sets `entry.hostSession` before `pair()` and `learnTty()`; the first hook clears it beside `entry.paired = undefined`, before its `locate()`.
- **The link and the safety rules are unchanged:** `open -b com.anthropic.claudefordesktop claude://code/continue?session=<local_…>`; a rest only while the Claude app is in front; nothing typed (no `type`); the id checked in `paneOf` and again in each verb.
- **A failed tap link** brings the Claude app forward from the adapter: `open -b com.anthropic.claudefordesktop`, the line `[device] open · claude · fallback`. A rest never forwards.
- **Logs.** The scan's line keeps its counts (`n named` counts names only). No new line. No line holds the `local_…` id, the record path, a pid or a name.
- **Rule 7.** No file under `cli/src/core` changes.
- **macOS only** for the link; on Linux and Windows nothing runs, as today.

## Review Focus

1. **A hook that names no app, whose caller's parents say the Claude app** (`learnApp` answers `'claude'` after the walk): the scan's stale `local_…` id must not place it; only the hook's hints do. Pinned in Task 3 (`a first hook whose hints name no app takes the record's pane away`).
2. **The session `/clear`s, `/resume`s or is resumed in the CLI between the scan's owners and the record read** (record for another `sessionId`, or `entrypoint: 'cli'`): no `hostSession`. Pinned in Task 2.
3. **A hook that comes while the scan reads the record:** the hook's place stands, the record's id is never set. Pinned in Task 3.
4. **A tap whose link and forward both fail:** answers false, one fallback line, no id in it. Pinned in Task 1.
5. **The Claude app not in front at the rest:** no rest is offered and nothing runs. Pinned in Task 3.

---

### Task 1: The Claude app adapter places a scanned session and brings the app on a failed tap

**Layer:** devices service process. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/claudeApp.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/adapter.ts` (`Place` only)
- Modify: `cli/src/cable/hosts/claudeApp.ts`
- Test: `cli/src/cable/hosts/claudeApp.spec.ts`
- Modify: `cli/src/cable/hosts/open.spec.ts` (only the `inert` `createClaudeAppAdapter` call in `tapped`, which must pass `log: () => {}`; no test changes)
- Modify: `cli/src/cable/hosts/observed.spec.ts` (only `fakeActions`' `createClaudeAppAdapter` call, which must pass `log: () => {}`; no test changes)
- Modify: `cli/src/services/devices.ts` (only the `createClaudeAppAdapter` call: add `log`)

**Interfaces:**
- Produces: `Place.hostSession?: string`, doc comment: the Claude app's own id of a session the open scan found, from the session's record (`record.ts`), until its first hook; only the Claude app's adapter reads it.
- Produces: `createClaudeAppAdapter(deps: AppLinkDeps & { log(line: string): void }): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>>`.
  - `paneOf(place)`: the hook's hints first, unchanged (`__CFBundleIdentifier === APP_BUNDLES.claude` and a `CLAUDE_CODE_HOST_SESSION_ID` passing `CLAUDE_SESSION`); else, when `place.app === 'claude'` and `place.hostSession` passes `CLAUDE_SESSION`, `{ adapter: 'claude', id: place.hostSession }`; else none.
  - `createAppLink(deps, { session: CLAUDE_SESSION, url, bundle: APP_BUNDLES.claude, forward })`, `forward` as `codexApp.ts`'s: `deps.log('[device] open · claude · fallback')`, then `run(openPath(deps.bin), ['-b', APP_BUNDLES.claude], RUN_TIMEOUT_MS)`, answering `code === 0`.
  - The header comment: the id comes from a hook, or from the session's own record for one only the scan found. The "No forward of its own" comment is replaced by why it has one (a scanned session has no `entry.bundle` until its first hook, so the opener alone could not bring the app).
- In `devices.ts`: `createClaudeAppAdapter({ ...apps, bin: openBin, inFront: () => cableHost.latestFront() === 'claude', log })`.

Constants for the tests: `SESSION`, `OTHER`, `CLAUDE`, `OPEN` as at the base; `FALLBACK = '[device] open · claude · fallback'`; `forward: Call = { file: OPEN, args: ['-b', CLAUDE], timeoutMs: 10_000 }`; `scanned = (over: Partial<Place> = {}): Place => ({ host: 'terminal', app: 'claude', hints: {}, hostSession: SESSION, ...over })`.

- [ ] **Step 1: Write the tests in `claudeApp.spec.ts`.** `recorder` takes `log` into `Deps` and returns `logs`, as `codexApp.spec.ts`'s does.
  - `paneOf takes the id the scan read from the record of a session the Claude app runs`: `paneOf(scanned())` equals `pane(SESSION)`.
  - `paneOf refuses the record's id under any other app, with none, or in any other form`: for `app` of `'ghostty'`, `'terminal'`, `'herdr'`, `'codex'`, `'orca'`, `'unknown'`, `paneOf(scanned({ app }))` is undefined; `scanned({ hostSession: undefined })` is undefined; for each of `'local_'`, `'local_a/b'`, `'local_x&source=y'`, `` `local_${'a'.repeat(65)}` ``, `'session_abc'`, `'--args'`, `'8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'`, `paneOf(scanned({ hostSession }))` is undefined.
  - `the hook's hints win over the record's id`: `paneOf(scanned({ hints: { __CFBundleIdentifier: CLAUDE, CLAUDE_CODE_HOST_SESSION_ID: OTHER } }))` equals `pane(OTHER)`. The existing `paneOf takes a local_ session of the Claude app's own, …` test stays as it is.
  - Rewrite `focus runs the continue link alone` as `focus runs the continue link alone, and nothing is said`: exit 0 gives `true`, `calls` `[link(SESSION)]`, `logs` `[]`; Linux and a forged id run nothing, as at the base.
  - `a link that exits non-zero or times out brings the app forward once, in one line with no session id`: for codes `[1]` and `[null]`, `focus` is true, `calls` `[link(SESSION), forward]`, `logs` `[FALLBACK]`, no log contains `SESSION`.
  - `a link and an app that both fail answer false`: codes `[1, 1]` and `[null, null]`: false, `calls` `[link(SESSION), forward]`, `logs` `[FALLBACK]`.
  - The `HARNESS_OPEN_BIN %j` table, with codes `[1]`: `calls` is `[{ ...link(SESSION), file }, { ...forward, file }, { ...link(SESSION), file }]`.
  - `a link that exits non-zero, or never exits, is failed, and no app is brought forward` (a rest): also `logs` is `[]`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/claudeApp.spec.ts`. Expected: FAIL in the scanned `paneOf`, the hints-win, the failed-link and the `HARNESS_OPEN_BIN` tests (no pane from `hostSession`; a failed link answers false with no forward).
- [ ] **Step 3: Commit** `test(dial): the Claude app adapter places a session by its record's id, and a failed tap brings the app (red)`.
- [ ] **Step 4: Implement** `Place.hostSession` and `createClaudeAppAdapter` (Interfaces above), then pass `log` in `devices.ts`, `observed.spec.ts` `fakeActions` and `open.spec.ts` `tapped`.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, 100% for `services/devices.ts`. These pass with no edit: `open.spec.ts` (`a link that fails …`, the fallback line now written by the adapter into the same log), and `devices.spec.ts` `a Claude Code in the Claude app opens on its session; a link that fails still brings the app forward, said in one line with no id` (same runs, same one line).
- [ ] **Step 6: Commit** `dial: the Claude app adapter places a session by its record's id, and a failed tap brings the app forward`.

### Task 2: The record reader gives the Claude app's session id

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/record.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/record.ts` (from `recordName.ts`, which stays until Task 3 removes it)
- Test: `cli/src/cable/hosts/record.spec.ts` (from `recordName.spec.ts`, likewise)

**Interfaces:**
- Produces: `export interface SessionRecord { name?: string; hostSession?: string }`: a key is present only with a value.
- Produces: `export interface RecordOptions { records: readonly string[] }` (was `RecordNameOptions`, same doc).
- Produces: `export async function readRecord(owner: Pick<SessionOwner, 'pid' | 'record'> & { sessionId: string }, opts: RecordOptions): Promise<SessionRecord>`. Never rejects; `{}` wherever `readRecordName` answered `undefined` before parsing (path, size, read, JSON, not an object) and when `sessionId` is not the owner's. `name` exactly as `readRecordName`'s answer. `hostSession`: the record's `hostSessionId` as it is (no cleaning; `paneOf` checks its form) when it is a string and `entrypoint === 'claude-desktop'`, independent of the name.
- Produces: `MAX_RECORD_BYTES` unchanged.
- The doc comment lists the fields it reads: `name`, `nameSource`, `entrypoint`, `sessionId`, `hostSessionId`, and why `hostSessionId` (the Claude app's own id of the session, which Claude Code writes from the `CLAUDE_CODE_HOST_SESSION_ID` its hook sends; the link to the app names it; spec of 2026-11-18).

- [ ] **Step 1: Write `record.spec.ts`** from `recordName.spec.ts`: import `{ MAX_RECORD_BYTES, readRecord }` from `./record.js`; `describe('readRecord')`; the temp dir prefix `record-`. `LOCAL = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'`; `app` gets `hostSessionId: LOCAL`; `read` answers the `SessionRecord`.
  - Every existing name test asserts on `(await read(…)).name`, its expectation unchanged; the `gives none for %s` table asserts `name` is undefined.
  - The `reads nothing at %s` table and the over-16-KiB case write `app` (not `named`) and assert `toEqual({})`.
  - `a Claude app record gives its title and its host session`: `read(record(11, app))` equals `{ name: 'Tho', hostSession: LOCAL }`.
  - `a Claude app record whose name is refused still gives its host session`: `{ ...app, nameSource: 'derived' }` equals `{ hostSession: LOCAL }`.
  - `a CLI record gives no host session`: `{ ...named, entrypoint: 'cli', hostSessionId: LOCAL }` equals `{ name: 'Tho' }`.
  - `a Claude app record for another session gives neither`: `{ ...app, sessionId: 't' }` equals `{}`.
  - `an older Claude app record with no hostSessionId gives its name alone`: `{ ...app, hostSessionId: undefined }` equals `{ name: 'Tho' }`.
  - `it.each` of `hostSessionId` `7`, `null`, `true`, `{ id: LOCAL }`, `[LOCAL]`: equals `{ name: 'Tho' }`.
  - `the host session is taken as written, for the adapter to check`: `{ ...app, hostSessionId: ' local_a&x=1 ' }` gives `hostSession` `' local_a&x=1 '`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/record.spec.ts`. Expected: FAIL (no module `./record.js`).
- [ ] **Step 3: Commit** `test(dial): the record reader gives the Claude app's session id (red)`.
- [ ] **Step 4: Implement** `record.ts` (Interfaces above) from `recordName.ts`'s body. Leave `recordName.ts` and its spec untouched.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable/hosts/record.spec.ts src/cable/hosts/recordName.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `dial: the record reader gives the Claude app's session id`.

### Task 3: The scan places it until its first hook, wired

**Layer:** devices service process. **Depends on:** 1 (`Place.hostSession`, the adapter's `paneOf`; it also edits `devices.ts` and `observed.spec.ts` after Task 1), 2 (`readRecord`, `SessionRecord`). **Effort:** `high` (`services/devices.ts` is in the 100% gate).

**Red tests:** `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`
- Modify: `cli/src/services/devices.ts` (`observedSource`'s reader line and its import)
- Test: `cli/src/services/devices.spec.ts`
- Remove (`git rm`): `cli/src/cable/hosts/recordName.ts`, `cli/src/cable/hosts/recordName.spec.ts`
- Modify: `docs/specs/2026-11-15-dial-session-name.md` (decision 5)

**Interfaces:**
- Consumes: `readRecord`, `SessionRecord`, `RecordOptions` (Task 2); `Place.hostSession`, the Claude app adapter's `paneOf` (Task 1).
- Produces in `observed.ts`:
  - `ObservedDeps.record?(owner: Pick<SessionOwner, 'pid' | 'record'> & { sessionId: string }): Promise<SessionRecord>` replaces `recordName`, `SessionRecord` a type-only import from `./record.js`. Doc: what a Claude Code session's own record gives (its name, the Claude app's id of it); one that rejects gives nothing; absent, the scan names by folder and places by its app alone.
  - `recordsOf(listing, owners): Promise<ReadonlyMap<string, SessionRecord>>` replaces `namesOf`: same one pass, Claude sessions only, in order, each in a `try`; a record with neither key is not kept; a rejection gives nothing and logs nothing.
  - `Entry.hostSession?: string`: the Claude app's id of a session the scan found, from its record, until its first hook; only `locate()` reads it.
  - `scanOnce`: `named` counts `record?.name` as today; `entry.hostSession = record.hostSession` when present, set after the app and before `pair()` and `learnTty()`.
  - `locate()`: `place` gains `hostSession: entry.hostSession`, as it passes `tty`.
  - The hook path (`ingest`): `entry.hostSession = undefined` beside `entry.paired = undefined`.
- Produces in `devices.ts`: `record: (owner) => readRecord(owner, { records: places.claude.records() })`, import from `../cable/hosts/record.js`, the comment above it unchanged in meaning.
- `devices.spec.ts`: `readers.name` becomes `readers.record = vi.fn(async (..._args: unknown[]): Promise<{ name?: string; hostSession?: string }> => ({}))`; `vi.mock('../cable/hosts/record.js', () => ({ readRecord: readers.record }))`; `beforeEach` resets it to `{}`.

Constants for `observed.spec.ts`: `CLAUDE_APP = 'com.anthropic.claudefordesktop'`, `LOCAL = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'`, `LOCAL_OTHER = 'local_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'`.

- [ ] **Step 1: Move the existing tests to `record`.** In `observed.spec.ts` every `recordName` dep becomes `record`, answering `{ name: … }` for a name and `{}` for none (`ObservedDeps['record']` in the `it.each` type); `recordName.mock.calls` becomes `record.mock.calls`, same arguments. In `devices.spec.ts`, `a session's name is read with the records folders …` uses `readers.record.mockResolvedValue({ name: 'Tho' })` and asserts `readers.record.mock.calls`, same arguments. No expectation changes.
- [ ] **Step 2: Write the new tests in `observed.spec.ts`,** in `describe('ObservedSource and a Claude app session the scan found (docs/plans/2026-11-18-dial-claude-app-swipe-before-hook-design.md)')`. Helper `scanned({ app = 'claude', record = { hostSession: LOCAL }, fakes = {}, over = {} })`: `fakeActions(fakes)`, `setup({ actions, apps: async () => new Map(app ? [[11, app]] : []), record: async () => record, ...over })`, session `'a'` open in `'terminal'`, owner `{ pid: 11, engine: 'claude', record: '/s/11.json' }`, a row with `cwd: '/x/a'`, then `scanOpen()`. `noClaude(t, agent)`: `hasPane` false, `focus` run, and `JSON.stringify(actions.open.mock.calls)` and `actions.claudeShow.mock.calls` hold no `LOCAL`.
  - `with the Claude app's parents and its record's id, it has the Claude pane before any hook`: `hasPane` true; `showPane` is `'ok'` and `claudeShow.mock.calls` equals `[[agent.id, LOCAL]]`; `focus` true and `open.mock.calls` equals `[[agent.id, { pane: { adapter: 'claude', id: LOCAL } }]]` with no `bundle`.
  - `with the Claude app not in front, no rest is offered and none runs`: `claudeInFront` false: `hasPane` false, `showPane` `'failed'`, `claudeShow` not called.
  - `the record's id under a Ghostty parent places nothing`: `app: 'ghostty'`: `noClaude`.
  - `the Claude app's parents with no id in the record place nothing`: `record: { name: 'Tho' }`: `noClaude`; the name is `'Tho'`.
  - `an app the scan did not learn places nothing`: `app: undefined`: `noClaude`.
  - `the first hook places it by its own hints: another local_ id wins`: ingest `turn-start` for `'a'`, `callerPid: 11`, hints `{ __CFBundleIdentifier: CLAUDE_APP, CLAUDE_CODE_HOST_SESSION_ID: LOCAL_OTHER }`; `showPane` gives `claudeShow` `[[agent.id, LOCAL_OTHER]]`.
  - `a first hook whose hints name no app takes the record's pane away` (Review Focus 1): ingest `turn-start` for `'a'`, `callerPid: 11`, `hostHints: {}`; `await flushed()` (the caller's walk answers `'claude'`); the agent's `app` is `'claude'` and `noClaude`.
  - `a Herdr pairing wins`: `over: { herdrTerminal: (pid) => (pid === 11 ? 't7' : undefined) }`: the agent has `app: 'herdr'`, `paneKeys: ['herdr-app:t7']`; `focus`'s target pane is `{ adapter: 'herdr-app', id: 't7' }`; no `LOCAL` in any call.
  - `a hook that came while the record was read keeps its own place` (Review Focus 3): `record` held on a promise, as the name test holds it; ingest a `turn-start` with `{ TERM_PROGRAM: 'ghostty' }` hints during the read; answer `{ hostSession: LOCAL }`; after the scan, one agent and `noClaude`.
  - `the scan's line is unchanged and no line holds the id`: `logs` equals `['[observed] scan · 1 found · 1 app known · 0 named · 0 answered · 0 ms']`; no line contains `LOCAL` or `local_`.
- [ ] **Step 3: Write the new test in `devices.spec.ts`,** in `describe('the session the Claude app shows turns the dial …')`: `a rest on a Claude app agent the scan found runs one continue link, with no hook sent`. Set up as `dialWith` does, without its two hooks: fake timers, `fakeListener`, `start({ faults: ['fleet'], listen: listener.listen, orca: { ...orca, platform: 'darwin' }, now: () => Date.now(), tty: async () => '/dev/ttys023' })`; `readers.known.set(S, 'terminal')`, `readers.owners.set(S, { engine: 'claude', pid: 4300, record: '/s/4300.json' })`, `readers.rows.set(S, { cwd: '/work/api', transcriptPath: null })`, `readers.working.set('/s/4300.json', false)`, `readers.apps.mockResolvedValue(new Map([[4300, 'claude']]))`, `readers.record.mockResolvedValue({ hostSession: LOCAL })`, with `S` a fresh UUID; `seen.host.watching!(true)`, `port.swarms(null)`; `vi.waitFor` until `host().listAgentSnapshot()` lists the agent (as `machineList` reads it); `listener.front('claude')`, `wait(FRONT_SETTLE_MS)`; `rest(observedAgentId('claude', S))`. `orcaRuns` equals `[continued(LOCAL)]` (no `open -b` of its own); no line of `logs` holds `LOCAL`.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts`. Expected: FAIL in the new tests marked above that expect a Claude pane, the hook-clears test, and the moved tests (the dep is still `recordName`, the mock still `recordName.js`); the "places nothing" tests may already pass.
- [ ] **Step 5: Commit** `test(dial): a Claude app session the scan found switches on a swipe before its first hook (red)`.
- [ ] **Step 6: Implement** `observed.ts` (Interfaces above) and the `devices.ts` wiring; `git rm cli/src/cable/hosts/recordName.ts cli/src/cable/hosts/recordName.spec.ts`. Update decision 5 of `docs/specs/2026-11-15-dial-session-name.md`: the devices read `name`, `nameSource`, `entrypoint` and `hostSessionId` (beside `sessionId`), by `cli/src/cable/hosts/record.ts`; `hostSessionId` only from a `claude-desktop` record, used only in the Claude app's link and never shown, logged, sent or stored; "(Widened 2026-11-18 for a swipe before the first hook, [design](../plans/2026-11-18-dial-claude-app-swipe-before-hook-design.md).)". Dated plans and designs in `docs/plans/` that name `recordName.ts` stay as written (PM, 2026-11-18).
- [ ] **Step 7: Run** `cd cli && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts && npm run typecheck && npm run test:core`, then `git grep -n "recordName\|readRecordName" -- cli docs/specs`. Expected: PASS, 100% for `services/devices.ts`, and the grep prints nothing.
- [ ] **Step 8: Commit** `dial: a Claude app session the scan found switches on a swipe before its first hook`.

## Verification

**Platforms the pull request names:** macOS, where the Claude app's link runs. Linux and Windows: nothing a person sees changes; the adapter's `platform: 'linux' | 'win32'` tests hold it (Task 1).

**End-to-end checks:** none. No end-to-end test may reach `/usr/bin/open` (the Claude app follow plan), and the link is covered by unit tests with a recording runner (Tasks 1 and 3). No temporary workflow.

**Never touched by a tester or a test:** the real Claude app, `/usr/bin/open`, `~/.claude` and its session records, Diego's daemon and dial, any backend, production.

**Required local gates**, run at the final head on this Mac and recorded in the pull request:
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit: it runs `cli-core` (`npm run test:core`, 100% per file under `src/core/` and `src/services/`), which applies because `cli/src/services/devices.ts` changes. Its receipt goes in the pull request's body before the tested commit is pushed.
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts`.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/cable/hosts/appLink.ts cli/src/cable/hosts/open.ts cli/hook` prints nothing.
- Not needed: `npm run test:harnessd`, desktop, firmware, device-app: no path of theirs changes.

**In PR CI, by itself:** `cli-typecheck` and `cli-tests` run every spec above on Linux.

**Numbers:** none to take. No hot path gains work: the record read is the same one read per session first listed; `paneOf` adds one comparison and one regex test per `locate()`.

**Diego's own check, after the merge** (he waived the pre-merge checks for today's dial work; his own Claude app sessions, his dial, his eye; no tester or agent runs it): restart the daemon on the merged build, swipe to a Claude app session he has not typed in since, with the Claude app in front: the app shows that session. A tap on it opens it too.

**Against production:** none.
