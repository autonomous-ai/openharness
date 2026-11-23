# Dial usage counts: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From real use and with counts only, the daily review answers how many signed-in computers use a dial (and how
many outside the Harness app), how fast a new dial gets its first agent, which engines and hosts it shows, whether it
finds the hooked agents, whether voice and taps reach them, what voice costs per account-day, whether the dial shortens
an agent's wait for its person, and whether dial users come back.

**Architecture:** The devices component counts its day into a state file of its own, `dial-usage.json`
(`cable/dialUsageFile.ts`, written by `cable/dialUsage.ts` from hooks in `services/devices.ts`, `cable/cableSession.ts`,
`cable/cableHost.ts` and `cable/hosts/observed.ts`). The gateway reads that file at its existing report tick
(`gateway/dialUsage.ts`), adds what it has not sent yet to its signed-in daily report (`gateway/productUsage.ts`), and
derives at each day's close what only it knows (outside the app, returns, the wait comparison). The backend accepts the
dial's names, counts voice seconds at `/api/voice/stt` per account-day, with the dial's clips apart (the devices'
upload sends one fixed header, `x-harness-voice-surface: dial`), and `usage:daily` gains a `dial` section. Desktop's
and the phone's "See what's shared" each gain one line. The names live in `lib/dialUsageContract.ts`, which the core's
process never loads, and its byte-identical backend copy.

**Tech Stack:** TypeScript (Node 24). CLI: Vitest (unit, `test:core` 100% per file for `src/services/`, e2e on the real
daemon with a fake dial and the in-memory backend). Backend: Fastify, Zod, Prisma on MongoDB, Vitest (unit and the
integration suite on a real Mongo). Desktop and phone: Flutter widget tests.

**Spec:** `docs/plans/2026-11-23-dial-usage-counts-design.md` (approved 2026-11-23, Phases 1 and 2 in one pull request,
size full). Base: `main` at `fc16e78f94`, branch `feat/dial-usage-counts`. Line numbers below are on `fc16e78f94`.

Paths: `DC` `cli/src/lib/dialUsageContract.ts`, `DF` `cli/src/cable/dialUsageFile.ts`, `DU` `cli/src/cable/dialUsage.ts`,
`CS` `cli/src/cable/cableSession.ts`, `CH` `cli/src/cable/cableHost.ts`, `HD` `cli/src/cable/hosts/hostDetect.ts`,
`OB` `cli/src/cable/hosts/observed.ts`, `DV` `cli/src/services/devices.ts`, `GD` `cli/src/gateway/dialUsage.ts`,
`GP` `cli/src/gateway/productUsage.ts`, `BT` `backend/src/types/dialUsage.ts`, `BP` `backend/src/lib/productUsage.ts`,
`BV` `backend/src/lib/voiceUsage.ts`, `BR` `backend/src/analytics/dailyDialReview.ts`, `PD`
`desktop/lib/settings/sections/privacy_section.dart`, `PM` `mobile/lib/phone/privacy_shared_fields.dart`. A CLI spec
is the file with `.spec.ts` in place of `.ts`; a backend test is `.test.ts` (`DCS`, `GDS`, `BRT`, …).

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | The vocabulary | `DC`, `DCS` | none | medium | `DCS` (module missing) |
| 2 | Backend takes the dial's names | `BT`, `backend/src/types/dialUsage.test.ts`, `backend/src/routes/productUsage.ts` and its test, `BP`, `backend/src/lib/productUsage.test.ts`, `backend/src/analytics/productHealth.ts` and its test | 1 | high | byte-identity test; route "dial counts only" case |
| 3 | Voice seconds at the route, the dial's apart | `backend/src/lib/voiceQuota.ts` and its test, `BV`, `backend/src/lib/voiceUsage.test.ts`, `BP`, `backend/src/lib/productUsage.test.ts`, `backend/src/routes/voice.ts`, `backend/src/routes/voice.test.ts` | 2 | xhigh | `voiceUsage.test.ts` (module missing); `voice.test.ts` dial and rest cases |
| 4 | The `dial` section of `usage:daily` | `BR`, `BRT`, `backend/src/productUsageReport.ts`, `backend/integration/dialUsageReview.test.ts` | 2, 3 | high | `BRT` (module missing) |
| 5 | The devices' file | `DF`, `DFS`, `cli/src/lib/stateWrites.guard.spec.ts` | 1 | xhigh | `DFS` (module missing) |
| 6 | What the devices count | `DU`, `DUS` | 1 | high | `DUS` (module missing) |
| 7 | Voice and tap outcomes from the cable | `CS`, `cli/src/cable/cableVoice.spec.ts`, `CH`, `cli/src/cable/cableHost.spec.ts` | 1 | high | `cableVoice.spec.ts` one-end cases; `cableHost.spec.ts` open cases |
| 8 | Held agents and the Other page's app | `HD`, `cli/src/cable/hosts/hostDetect.spec.ts`, `OB`, `cli/src/cable/hosts/observed.spec.ts` | 1 | high | `otherProduct` and `heldOnly` cases |
| 9 | Devices wiring, phase 1 | `DV`, `cli/src/services/devices.spec.ts` | 5, 6, 7, 8 | high | `devices.spec.ts` "dial-usage.json" cases |
| 10 | Devices wiring, phase 2 | `DV`, `cli/src/services/devices.spec.ts` | 9 | high | `devices.spec.ts` wait and interrupt cases |
| 11 | The gateway's merge | `GD`, `GDS` | 1 | xhigh | `GDS` (module missing) |
| 12 | The gateway reports it | `GP`, `cli/src/gateway/productUsage.spec.ts` | 11 | xhigh | `productUsage.spec.ts` dial cases |
| 13 | End to end, and the gateway pointed at the file | `cli/src/gateway/start.ts`, `cli/e2e/dialUsage.e2e.ts`, `cli/e2e/dialWindows.e2e.ts`, `cli/ci-e2e-durations.json` | 9, 12 | high | the new e2e cases (no dial names reported while `start.ts` names no file) |
| 14 | Docs | `docs/product-measurement.md`, `cli/AGENTS.md` | none | medium | none: docs, one commit |
| 15 | "See what's shared" names the dial and voice | `PD`, `desktop/test/privacy_section_test.dart`, `PM`, `mobile/test/privacy_page_test.dart` | none | medium | the two "names the dial and voice" widget tests |
| 16 | The dial's upload says it is the dial's | `CH`, `cli/src/cable/cableVoice.spec.ts` | 1 | medium | `cableVoice.spec.ts` "marks the upload as the dial's" |

**Shared files** (devcrew runs these one at a time): `BP` and `backend/src/lib/productUsage.test.ts` (2, 3);
`DV` and `cli/src/services/devices.spec.ts` (9, 10); `CH` and `cli/src/cable/cableVoice.spec.ts` (7, 16).

**Longest chain:** four tasks: 1 → 2 → 3 → 4, 1 → 5 → 9 → 10, and 1 → 11 → 12 → 13. Ready at once: 1, 14, 15.

## Global Constraints

- **No core change.** `git diff --stat fc16e78f94 -- cli/src/core cli/src/architecture.coreFiles.txt
  cli/src/lib/productUsageContract.ts cli/src/lib/productHealthContract.ts backend/src/types/productUsage.ts
  cli/src/backendSocket.ts cli/src/localWsServer.ts` prints nothing. `DC` imports nothing, and only `cable/`,
  `services/devices*.ts` and `gateway/` import it: `services/inline.ts` is the dynamic door the core's walk does not
  follow (`architecture.spec.ts` `IN_PROCESS_ONLY`), so on Windows, where the devices and the gateway run inside the
  core's process, no file joins `architecture.coreFiles.txt`. `product_observe` and `CoreApi.count` are not used.
- **Signed-in computers only; the unit is the computer.** The devices count only while `core.account.signedIn()`; the
  gateway sends only in its signed-in report, under the account's existing "Share product usage data" choice. Voice
  cost is per account-day, at `backend/src/routes/voice.ts`; the dial's clips are told apart by one fixed header
  (`DIAL_VOICE_SURFACE_HEADER`: `DIAL_VOICE_SURFACE`, no id), which only the devices' upload sends. Anything else (the
  phone, an older CLI, a missing, repeated or other value) is the rest.
- **Mixed releases.** An older backend ignores the unknown header (the CLI is a Node client: no CORS preflight); an
  older CLI sends none, so its clips count as the rest until it updates. The review says so beside the voice rows.
- **Never** an id, serial, MAC, account, machine name, window title, path, project, prompt, voice text or transcript, in
  the file, a report, a log line or a test fixture's expected output. Product names only from `DIAL_OTHER_APPS`, which
  ends in `unlisted` and `unknown`. A raw bundle id or `TERM_PROGRAM` stops at `otherProduct()` (`HD`).
- **The devices' file:** fixed names and numbers only, at most `DIAL_USAGE_DAYS` (35) UTC days and
  `DIAL_USAGE_FILE_MAX_BYTES` (128 KiB), older days dropped at each write, one write per `DIAL_USAGE_WRITE_MS` (5 s) at
  most, `atomicWriteFile(…, 'cache')`, one writer (the devices' process), listed in `stateWrites.guard.spec.ts`.
- **The gateway:** reads the file at its existing tick with `readState` after a size check, parses it only when its
  mtime or size changed, keeps only names in the vocabulary and logs nothing of what it drops. It remembers per day what
  it sent and the file's series, so a restart of either side never counts twice. No new endpoint, sender or timer.
- **Old backends:** dial counts travel in a report of their own; a 400 to a report of dial names only drops it
  without counting `health_cli_report_rejected` (as hn's and the Node counters do, `GP` 399-407).
- **Measures, verbatim from the spec:** per UTC day; computer counts first, event counts beside them. First agent:
  under 1 min, 1–3, 3–10, over 10, none within an hour, on the first connection ever and apart on each day's first.
  Delivered: the agent's turn began within 10 s. Wait: under 30 s, 30 s–2 min, 2–10 min, over 10 min, none. Proxies: a
  voice followed within 30 s by a voice to another agent; a delivered voice whose turn the person interrupts within
  10 s. Returns: N+1 / N+7 / N+28. Outside the app: Desktop not opened in the last 28 days. Voice per account-day:
  under 1 min, 1–5, 5–20, over 20.
- **Review:** day, 7-day and 28-day columns, outside the team first (`staff:` and `testing:` apart as today), any cell
  under 5 computers (and the event cells beside it) shown as `"<5"`, the signed-in-only and hooked-engines-only limits
  on its first lines. No cross products: engine, host and the release/OS margins are separate one-way splits.
- **"Host"** is the dial's own host id (`HostAgent.host`: tmux, zellij, orca, herdr, kitty, …, `harness` for Harness's
  agents); "the Other page" is `HostAgent.app === UNKNOWN_APP`. Both come from `APP_IDS` (`HD` 48), `terminal` read as
  `other` and `-` as `_`.
- **Comments say why** and name the spec or the incident. **Platforms:** macOS, Linux, Windows, the same names.

## The vocabulary (Task 1 writes it; every other task uses it)

Lists, in this order in `DC`:

- `DIAL_USAGE_ENGINES` = `ENGINES` of `engines/types.ts` 11-15 (claude … terminal, 17) then `'other'`.
- `DIAL_USAGE_HOSTS` = `harness, orca, herdr, rex, zellij, tmux, kitty, wezterm, iterm, terminal_app, ghostty, cmux,
  vscode, cursor, warp, claude, codex, opencode, other`.
- `DIAL_OTHER_APPS` = `zed, alacritty, hyper, tabby, jetbrains, rio, wave, nova, windsurf, unlisted, unknown`.
- `DIAL_RECOGNITION` = `placed, held, other, not_shown` (best first).
- `DIAL_VOICE_OUTCOMES` = `delivered, failed, held, cancelled`.
- `DIAL_VOICE_FAILURES` = `no_speech, transcribe_failed, route_failed, no_agent, window_busy, refused, send_failed,
  no_turn, unlisted`.
- `DIAL_OPEN_FAILURES` = `not_opened, desktop_not_started, desktop_no_window, unknown_agent, unlisted`.
- `DIAL_FIRST_AGENT_BUCKETS` = `under_1m, 1m_to_3m, 3m_to_10m, over_10m, none_1h`.
- `DIAL_WAIT_BUCKETS` = `under_30s, 30s_to_2m, 2m_to_10m, over_10m`.

Constants: `DIAL_USAGE_FILE = 'dial-usage.json'`, `DIAL_USAGE_FILE_VERSION = 1`, `DIAL_USAGE_DAYS = 35`,
`DIAL_USAGE_FILE_MAX_BYTES = 128 * 1024`, `DIAL_USAGE_MAX_COUNT = 100_000`, `DIAL_USAGE_AGENTS_MAX = 16`,
`DIAL_VOICE_SURFACE_HEADER = 'x-harness-voice-surface'`, `DIAL_VOICE_SURFACE = 'dial'` (Decision 4: the devices'
upload sends it, the backend's copy reads it; one fixed value, never an id).

Names (E engines, H hosts, A other apps, R recognition, O voice outcomes, VF/OF failures, FB/WB buckets). A **flag** is a
computer count: at most 1 a computer a day, and its name ends in `_installation_days` or `_installations`
(`DIAL_FLAG_METRICS`). Every other name is an event or agent count.

`DIAL_DEVICE_METRICS` (the devices count them; the gateway sends them as they come):

| Family | Names |
|---|---|
| Who | `dial_connected_installation_days`, `dial_used_installation_days`, `dial_first_use_installations` |
| First agent | `dial_first_agent_first_<FB>_installations`, `dial_first_agent_day_<FB>_installations` |
| Engines shown | `dial_engine_<E>_installation_days`, `dial_engine_<E>_agents` |
| Hosts shown | `dial_host_<H>_installation_days`, `dial_host_<H>_agents` |
| Hooked agents | `dial_hooked_<E>_installation_days`, `dial_hooked_<E>_<R>` |
| Other page | `dial_other_app_<A>_installation_days`, `dial_other_app_<A>_agents` |
| Voice | `dial_voice_installation_days`, `dial_voice_<O>`, `dial_voice_failed_<VF>`, `dial_voice_host_<H>_installation_days`, `dial_voice_host_<H>_<O>`, `dial_voice_redirected_30s`, `dial_voice_interrupted_10s`, `dial_voice_host_<H>_redirected_30s`, `dial_voice_host_<H>_interrupted_10s` |
| Tap to open | `dial_open_installation_days`, `dial_open_ok`, `dial_open_failed`, `dial_open_failed_<OF>`, `dial_open_host_<H>_installation_days`, `dial_open_host_<H>_ok`, `dial_open_host_<H>_failed` |

`DIAL_WAIT_RAW_METRICS` (in the file only, never sent): `dial_wait_dial_<WB>`, `dial_wait_elsewhere_<WB>`,
`dial_wait_none`.

`DIAL_DERIVED_METRICS` (the gateway adds them as a day closes, never in the file):
`dial_connected_outside_app_installation_days`, `dial_used_outside_app_installation_days`,
`dial_first_use_outside_app_installations`; `dial_d<1|7|28>_returning_installations` and
`dial_d<1|7|28>_returning_outside_app_installations`; `dial_used_week_installations`, `dial_used_28d_installations`,
`dial_used_outside_app_week_installations`, `dial_used_outside_app_28d_installations` (the period flags, Decision 3;
first use needs none: `dial_first_use_installations` and its outside-app twin fire once ever per computer, so their
7- and 28-day sums already count distinct computers);
`dial_wait_used_day_installation_days`, `dial_wait_used_day_dial_<WB>`, `dial_wait_used_day_elsewhere_<WB>`,
`dial_wait_used_day_none`, `dial_wait_unused_day_installation_days`, `dial_wait_unused_day_elsewhere_<WB>`,
`dial_wait_unused_day_none`; `dial_file_unreadable_installation_days`.

`DIAL_FILE_METRICS` = device ∪ wait raw. `DIAL_USAGE_METRICS` (what the backend takes) = device ∪ derived.
`DIAL_USAGE_MARGIN_METRICS` = `dial_connected_installation_days`, `dial_used_installation_days`,
`dial_used_outside_app_installation_days` (they get the release and platform margins). About 450 names; a computer
uses a few dozen a day.

Types: `DialUsageEngine`, `DialUsageHost`, `DialOtherApp`, `DialRecognition`, `DialVoiceFailure`, `DialOpenFailure`,
`DialFileMetric`, `DialUsageMetric`, and:

```ts
export interface DialUsageSink {
  /** Adds [n] (1) to [metric] on today's UTC day: a flag stays at 1, a count stops at DIAL_USAGE_MAX_COUNT. */
  add(metric: DialFileMetric, n?: number): void
  /** True the first time this computer ever reaches [mark]; kept in the file past its 35 days. */
  firstEver(mark: 'connected' | 'used'): boolean
}
export type DialVoiceEnd =
  | { outcome: 'sent'; agentId: string }
  | { outcome: 'failed'; code: DialVoiceFailure; agentId?: string }
  | { outcome: 'cancelled'; agentId?: string }
  | { outcome: 'other' }   // a draft, a form field, a search: use, not voice to an agent
export type DialOpenEnd = { outcome: 'ok' } | { outcome: 'failed'; code: DialOpenFailure }
```

## Review Focus

1. **A restart mid-day, of the gateway or of the devices, or a devices' file made again.** No flag is sent twice for a
   day, and a new series sends its own events once. Pinned in Task 11 (series cases) and Task 13 (restart case).
2. **Sharing turned off then on, a sign-out, or another account signing in.** Nothing the file held before is sent
   (the baseline); a first-ever state with no queue file still sends what the file holds. Pinned in Task 12.
3. **An older backend that refuses a report of dial names only (400).** It is dropped, no rejection is counted, and
   the next report goes. Pinned in Task 12.
4. **A dial that greets and restores its focus with no hand on it.** Connected, never used, and no first use spent.
   Pinned in Task 6 (`attached` alone) and Task 9 (the greet's own focus frame).
5. **A devices' file another build or a person shaped** (unknown names, fractions, negatives, a future day, 10 MB).
   Dropped name by name or whole, nothing of it logged, a whole drop counted once a day. Pinned in Tasks 5 and 11.

---

### Task 1: The vocabulary

**Files:** Create `DC`, `DCS`.

**Interfaces (produces):** every list, constant, name family and type in "The vocabulary" above, exactly. `DC` has no
`import` line: the backend's copy must be the same bytes.

- [ ] **Step 1: Write the failing spec `DCS`**

```ts
it('names every engine the daemon knows, then other', () =>
  expect(DIAL_USAGE_ENGINES).toEqual([...ENGINES, 'other']))
it('names every dial host, the unknown app as other', () =>
  expect([...DIAL_USAGE_HOSTS].sort()).toEqual(APP_IDS.map((id) => id === UNKNOWN_APP ? 'other' : id.replaceAll('-', '_')).sort()))
it('every name is unique, at most 64 characters, starts with dial_, and is no product usage name', ...)
it('the file holds the devices\' names and the waits; a report, the devices\' names and the gateway\'s', ...)
  // FILE = DEVICE ∪ WAIT_RAW, USAGE = DEVICE ∪ DERIVED, WAIT_RAW ∩ USAGE = ∅, DERIVED ∩ FILE = ∅
it('a flag is a computer count by its name', ...)
  // DIAL_FLAG_METRICS = (FILE ∪ USAGE).filter(/_installation(s|_days)$/), and every margin name is a flag
it('a report of the 64 longest names at DIAL_USAGE_MAX_COUNT fits the backend\'s 8 KiB body', () => {
  const counters = Object.fromEntries([...DIAL_USAGE_METRICS].sort((a, b) => b.length - a.length).slice(0, 64).map((m) => [m, DIAL_USAGE_MAX_COUNT]))
  const report = { schemaVersion: 1, revision: 2 ** 31, id: randomUUID(), day: '2026-11-23',
    context: { surface: 'cli', release: '10.10.100', platform: 'windows', channel: 'production' }, counters }
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(8192)
})
it('imports nothing, so the backend\'s copy is the same file', () =>
  expect(readFileSync(new URL('./dialUsageContract.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m))
it('marks the dial\'s voice with one fixed lower-case header and value', () => {
  expect(DIAL_VOICE_SURFACE_HEADER).toBe('x-harness-voice-surface')
  expect(DIAL_VOICE_SURFACE).toBe('dial')
})
```

- [ ] **Step 2: Run it:** `cd cli && npx vitest run src/lib/dialUsageContract.spec.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Write `DC`.** Lists `as const`; families built with `flatMap` over the lists, as `productUsageContract.ts`
  builds its own (`PRODUCT_USAGE_LAUNCH_METRICS`).
- [ ] **Step 4: Run** `npx vitest run src/lib/dialUsageContract.spec.ts src/architecture.spec.ts`. Expected: PASS, and
  `git diff --stat -- src/architecture.coreFiles.txt` prints nothing.
- [ ] **Step 5: Commit** (`feat(cli): the dial's usage vocabulary`).

### Task 2: Backend takes the dial's names

**Files:** Create `BT` (a copy of `DC`), `backend/src/types/dialUsage.test.ts`. Modify
`backend/src/routes/productUsage.ts` (20-24 the schema's enum, 74 `REPORT_METRICS`), `backend/src/routes/productUsage.test.ts`,
`BP` (100 `ingestProductUsage`'s report type), `backend/src/lib/productUsage.test.ts`,
`backend/src/analytics/productHealth.ts` (4 `allowed`), `backend/src/analytics/productHealth.test.ts`.

**Interfaces:** Consumes `DC`'s lists. Produces: the report route accepts any `DIAL_USAGE_METRICS` name beside
`PRODUCT_USAGE_METRICS`; `ingestProductUsage(userId, report: UsageReport)` with
`type UsageReport = Omit<ProductUsageReport, 'counters'> & { counters: Partial<Record<ProductUsageMetric | DialUsageMetric, number>> }`
declared in `BP` (not in `types/productUsage.ts`, whose bytes the CLI's core file shares);
`healthBreakdowns(context, metric)` also margins `DIAL_USAGE_MARGIN_METRICS`.

- [ ] **Step 1: Write the failing tests.**
  - `dialUsage.test.ts`: `'keeps the client and server dial vocabulary identical'`, as `productUsage.test.ts` 107-110
    reads `../../../cli/src/lib/dialUsageContract.ts` against `../types/dialUsage.ts`.
  - `routes/productUsage.test.ts`: `'takes a report of dial counts only and keeps each name'`
    (`{ dial_used_installation_days: 1, dial_voice_delivered: 3 }` → 200, `accepted: true`, both stored);
    `'keeps dial names beside product names'`; `'drops a dial name it does not know and keeps the rest'`
    (`dial_future_name` beside `dial_used_installation_days` → stored without it, `health_cli_report_unknown_metric: 1`).
  - `lib/productUsage.test.ts`: `'keeps a staff account\'s dial counts under staff:'`.
  - `productHealth.test.ts`: `'margins the dial\'s who-uses flags and no other dial name'`
    (`healthBreakdowns(production, 'dial_used_installation_days')` has the release and platform names;
    `'dial_voice_delivered'` has none).
- [ ] **Step 2: Run** `cd backend && npx vitest run src/types/dialUsage.test.ts src/routes/productUsage.test.ts src/lib/productUsage.test.ts src/analytics/productHealth.test.ts`.
  Expected: FAIL (no copy; dial names refused 400; no margins).
- [ ] **Step 3: Implement.** Copy `DC` to `BT` byte for byte. Union the two lists in the route's set and enum only.
- [ ] **Step 4: Run** the same tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(backend): take the dial's counts in the usage report`).

### Task 3: Voice seconds at the route, the dial's apart

**Files:** Modify `backend/src/lib/voiceQuota.ts` (`reserveInBucket` 143-240, `VoiceQuotaReservationResult` 19-22),
`backend/src/lib/voiceQuota.test.ts`, `BP`, `backend/src/lib/productUsage.test.ts`, `backend/src/routes/voice.ts`
(`transcribe` 108-164), `backend/src/routes/voice.test.ts`. Create `BV`, `backend/src/lib/voiceUsage.test.ts`.

**Depends on** Task 2: `BV` reads `DIAL_VOICE_SURFACE_HEADER`, `DIAL_VOICE_SURFACE` and `DIAL_USAGE_METRICS` from `BT`.

**Interfaces (produces):**
- `VoiceQuotaReservationResult.usedMsBefore: number`: the bucket's exact `usedMs` before this reservation (the same as
  after for a `pending` or `committed` one).
- `BV`: `export const VOICE_USAGE_METRICS = ['voice_dial_clips', 'voice_dial_audio_s', 'voice_dial_transcribe_ms',
  'voice_rest_clips', 'voice_rest_audio_s', 'voice_rest_transcribe_ms', 'voice_account_days',
  'voice_account_days_over_1m', 'voice_account_days_over_5m', 'voice_account_days_over_20m'] as const`,
  `type VoiceUsageMetric`, `type VoiceSurface = 'dial' | 'rest'`;
  `voiceSurface(header: string | string[] | undefined): VoiceSurface`: `'dial'` only for the exact string
  `DIAL_VOICE_SURFACE`, else `'rest'` (absent, repeated, any other value; the value is never logged or stored);
  `voiceIncrements(surface: VoiceSurface, beforeMs: number, clipMs: number, transcribeMs: number):
  Array<[VoiceUsageMetric, number]>`: one `voice_<surface>_clips`, its `_audio_s` (whole seconds, rounded up per clip as the quota charges), its `_transcribe_ms` (integers,
  at least 0), `voice_account_days` when `beforeMs === 0`, and each `_over_<t>` whose edge (60 000, 300 000,
  1 200 000 ms) lies in `(beforeMs, beforeMs + clipMs]`. The account-day buckets stay over the account's whole voice,
  dial and rest together: `beforeMs` is the account's shared daily quota bucket, and bucketing the dial's own seconds
  per account would need a new per-account record, which the spec's Design ("nothing new to delete on the backend")
  rules out. The buckets are read as differences (under 1 min = account_days − over_1m, …).
- `BP`: `recordVoiceUsage(userId: string, now: Date, increments: Array<[VoiceUsageMetric, number]>): Promise<void>`:
  nothing when `relayEnabled(userId)` is false; `staff:` before each name for an `@autonomous.ai` account, through the
  same `staffAccounts` cache `apartPrefixes` keeps (one `user.findUnique` for an account not seen); `relayTotals.add(day,
  name, value)`; never throws, and says `[product-usage] Some voice counts are unavailable.` at most once a minute. No
  `testing:` prefix: a clip carries no channel.
- The route calls it once a clip is transcribed and committed, only for a reservation whose state was `reserved`, with
  the surface from `voiceSurface(req.headers[DIAL_VOICE_SURFACE_HEADER])` and the transcription time measured around
  `transcribeWavWithDeepgram`; never awaited by the answer. The route's `logger.info('voice-stt', …)` line gains
  nothing.

- [ ] **Step 1: Write the failing tests.**
  - `voiceQuota.test.ts`: `'says the account\'s milliseconds before this clip'` (two reservations: 0, then the first's
    rounded length).
  - `voiceUsage.test.ts`: `'a first 30 s dial clip: one dial clip, its ms, one account-day, no edge'`; `'a rest clip
    counts under rest and moves the same account buckets'`; `'50 s to 70 s crosses 1 min only'`; `'0 to 25 min
    crosses all three'`; `'past 20 min crosses none'`; `'only the exact dial value is the dial'` (`'dial'` → dial;
    `undefined`, `'Dial'`, `' dial'`, `'phone'`, `['dial', 'dial']`, a 10 KB string → rest); `'no voice name is one a
    client may report'` (empty intersection with `PRODUCT_USAGE_METRICS` and `DIAL_USAGE_METRICS`).
  - `lib/productUsage.test.ts`: `'counts voice on its day, the team under staff:, nothing with sharing off'`;
    `'a failed read never reaches the route'`.
  - `voice.test.ts` (mock `recordVoiceUsage`): `'a transcribed clip with the dial\'s header records dial increments
    once'`; `'a clip with no header (the phone, an older CLI) records rest increments'`; `'a clip Deepgram fails
    records nothing'`; `'a refused clip (rate, quota, not WAV) records nothing'`; `'the header\'s value is never
    logged'` (a canary value, absent from every logger call).
- [ ] **Step 2: Run** `cd backend && npx vitest run src/lib/voiceQuota.test.ts src/lib/voiceUsage.test.ts src/lib/productUsage.test.ts src/routes/voice.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement** as the interfaces say. A clip given back (Deepgram failed) can let a later clip cross an
  edge again: say so in a comment; it is rare and only moves a bucket.
- [ ] **Step 4: Run** the same tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(backend): count transcribed voice per account-day, the dial's apart`).

### Task 4: The `dial` section of `usage:daily`

**Files:** Create `BR`, `BRT`, `backend/integration/dialUsageReview.test.ts`. Modify `backend/src/productUsageReport.ts`
(14 `metrics`, 29 the output).

**Interfaces:**
- Consumes: `BT`'s lists, `BV`'s `VOICE_USAGE_METRICS`.
- Produces: `DIAL_REVIEW_METRICS: string[]` (every dial and voice name, each also with `staff:` and `testing:`, and
  `health_cli_collector_days` with both prefixes), and `dailyDialReview(rows: Row[], breakdowns: Row[], now: Date)`:

```ts
{ limits: string[]            // first: signed-in only; second: hooked engines only; then computer-days, "<5"
  coverage: Cells             // health_cli_collector_days, outside the team
  outsideTeam: Section[]; team: Section[]   // team = staff: + testing:
  voice: { outsideTeam: VoiceSection; team: VoiceSection }
  margins: { platform: Margin[]; release: Margin[] } }
type Cells = { day: number | '<5'; d7: number | '<5'; d28: number | '<5' }
type Section = { name: string; rows: Array<{ name: string; computers: Cells; events?: Cells }> }
type VoiceTotals = { clips: Cells; audioMinutes: Cells; transcribeMinutes: Cells }
type VoiceSection = { note: string           // "Voice from older CLIs counts as the rest until they update."
  accountDays: { all: Cells; under1m: Cells; m1to5: Cells; m5to20: Cells; over20m: Cells }  // all voice on the account
  dial: VoiceTotals; rest: VoiceTotals }      // rest: the phone, older CLIs, any clip without the dial's header
```

  `day` is the last complete UTC day, `d7` and `d28` the 7 and 28 complete days before today. Sections, in order: Who
  uses a dial (with the outside-app twins; the dial-used and used-outside-app rows show the period flags as "distinct
  computers" in `d7` and `d28`, and the first-use rows their plain sums, labelled distinct too since a computer's first
  use counts once ever; the connected rows stay computer-days), First agent on the dial, Engines
  shown, Hosts shown, Hooked agents found (by engine: placed, held, Other, not shown), The Other page by app, Voice
  (outcomes, failure codes, by host), Tap to open (outcomes, codes, by host), Wait for the person (labelled: dial-used
  days against connected-but-unused days), Wrong agent (labelled proxies), Return (mature cohorts only, outside apart).
  An event row's `"<5"` follows its row's computer cells. A row with nothing in it is left out. Voice: account-day
  buckets as differences, labelled "all voice on the account, dial and the rest"; then the dial's clips, audio and
  transcription minutes (one decimal), and the rest's beside them; an account-day cell under 5 is `"<5"`; the dial's
  totals follow the same column's `dial_voice_installation_days` (under 5: `"<5"`), the rest's follow
  `voice_account_days`. Margins: `dial_used_installation_days` by platform and by release, only where the day's
  `health_cli_collector_days` margin is 20 or more, then `"<5"`; from the breakdown rows the report reads (its `days`).

- [ ] **Step 1: Write the failing tests `BRT`:** `'opens with the signed-in and hooked-engines limits'`;
  `'reads outside the team first and the team apart'`; `'shows <5 under five computers, and on the events beside
  them'`; `'adds seven and twenty-eight complete days, today left out'`; `'derives the voice buckets and hides them
  under five'`; `'shows the dial\'s voice apart from the rest, each hidden under its own five, with the older-CLI
  note'`; `'labels the period flags and first use as distinct computers, connected as computer-days'`;
  `'never crosses engine, host or margin'` (no row's name holds two of the lists);
  `'leaves out a row with nothing'`; `'suppresses a margin under 20 collector observations'`.
  Integration `dialUsageReview.test.ts`: on the suite's Mongo, `ingestProductUsage` a dial report from an outside
  account and from a staff account, one with a `development` context (kept nowhere), `recordVoiceUsage` two clips
  (one dial, one rest),
  `flushRelayUsage()`, read `productUsageTotal` with the report's own `where`, and check the section's outside and team
  cells.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/analytics/dailyDialReview.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `BR`, then add `DIAL_REVIEW_METRICS` to the report's `metrics` and `dial:` to its output.**
- [ ] **Step 4: Run** the unit test, `npm run typecheck`, and
  `npx vitest run --config vitest.integration.config.ts integration/dialUsageReview.test.ts` (it needs the suite's
  local Mongo; without one, `backend-integration` on PR CI is its run). Expected: PASS.
- [ ] **Step 5: Commit** (`feat(backend): a dial section in usage:daily`).

### Task 5: The devices' file

**Files:** Create `DF`, `DFS`. Modify `cli/src/lib/stateWrites.guard.spec.ts` (add `'cable/dialUsageFile.ts'` beside
`'cable/noticeFile.ts'`).

**Interfaces (produces):** modelled on `cable/noticeFile.ts` (debounced sync `atomicWriteFile`, `close()`).

```ts
export const DIAL_USAGE_WRITE_MS = 5_000
export interface DialUsageFileDeps {
  file: string
  now(): number                                  // wall-clock ms: the UTC day
  after(ms: number, run: () => void): () => void // devices.ts timerIn
  signedIn(): boolean
  hadDial(): boolean                             // readSetup(dataDir).dial (devices/dialSkillFiles.ts 245)
  log(line: string): void
}
export class DialUsageFile implements DialUsageSink { constructor(deps: DialUsageFileDeps); close(): void }
```

The file: `{ version: 1, series: number, connectedBefore: boolean, usedBefore: boolean, days: { [utcDay]: { [name]: number } } }`.
`series` is `now()` when the file is made: a new series tells the gateway these are new events. A missing file starts
a series with both `before` marks from `hadDial()`, so a computer that had a dial before this release spends no first
use. Read once at construction: over the size cap, not JSON, another version or shape starts a new series and logs
`[device] usage · dropped · <long|json|version|shape>`; an unreadable file (`readState` `unreadable`) is never written
over; known names, safe integers in (0, `DIAL_USAGE_MAX_COUNT`] and valid UTC days within 35 only. Each write keeps 35
days and the newest under the cap. Signed out, `add` and `firstEver` do nothing. A failed write logs
`[device] usage · not saved · <errorKind>` and the next change tries again.

- [ ] **Step 1: Write the failing spec `DFS`:** `'one write for many adds, DIAL_USAGE_WRITE_MS after the first'`;
  `'a flag stays 1; a count stops at DIAL_USAGE_MAX_COUNT'`; `'counts nothing signed out, and firstEver stays
  unspent'`; `'firstEver is true once, and stays false after a reload'`; `'keeps 35 UTC days and the newest under
  the cap'`; `'reads itself back: series, counts, marks'`; `'a new file takes its marks from hadDial'`;
  `'drops another shape whole with one word, and bad names or values one by one'`; `'never writes over an unreadable
  file'`; `'close writes what waits, then nothing'`; `'a failed write says its kind only'`; `'holds fixed names and
  numbers only'` (every key under `days` is in `DIAL_FILE_METRICS`, every value a number).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialUsageFile.spec.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `DF`.**
- [ ] **Step 4: Run** it and `npx vitest run src/lib/stateWrites.guard.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(cli): the devices' dial-usage.json`).

### Task 6: What the devices count

**Files:** Create `DU`, `DUS`.

**Interfaces (produces):**

```ts
export interface DialAgent { engine: string; host: string; page: string; held: boolean }   // raw ids; held: every pane held
export interface HookedAgent extends DialAgent { listed: boolean; otherApp?: DialOtherApp }  // listed: the dial's list has it
export interface DialUsageDeps {
  sink: DialUsageSink
  now(): number                                  // wall-clock ms
  after(ms: number, run: () => void): () => void
  describe(agentId: string): DialAgent | undefined
}
export function dialEngine(engine: string): DialUsageEngine   // listed, else 'other'
export function dialHost(id: string): DialUsageHost           // UNKNOWN_APP → 'other', '-' → '_', unlisted → 'other'
export function createDialUsage(deps: DialUsageDeps): {
  attached(on: boolean): void; agentsPresent(present: boolean): void; shown(agentId: string | null): void; used(): void
  voiceEnded(end: DialVoiceEnd): void; opened(agentId: string, end: DialOpenEnd): void
  turnStarted(agentId: string): void; turnAborted(agentId: string): void; hooked(agentId: string, agent: HookedAgent): void
  waitOpened(key: string, agentId: string): void; answeredOnDial(key: string): void; tapped(agentId: string): void
  waitEnded(key: string, end: 'answered' | 'gone'): void; stop(): void }
```

Rules (each pinned by a case below):
- `attached(true)`: `dial_connected_installation_days`; while attached, again at each UTC midnight (one timer).
- `used()` (a turn, a stroke, a tap, an answer, an app pick): `dial_used_installation_days`, and
  `dial_first_use_installations` when `firstEver('used')`. `voiceEnded` and `opened` count use themselves. An attach
  alone is never use.
- First agent: from the attach when an agent is present, else from `agentsPresent(true)`, to the first `shown(id)`;
  edges 60 000, 180 000, 600 000 ms; none by 3 600 000 ms is `none_1h`. The attach that spends `firstEver('connected')`
  counts in `first`; the day's first attach in `day`; a measurement under way survives a detach.
- `shown(id)`: engine and host flags; each agent once a day in `_agents`, at most `DIAL_USAGE_AGENTS_MAX` a name.
- `voiceEnded`: every agent-bound end counts the voice flags (and `_host_<h>_` from `describe`). `sent` waits 10 s for
  `turnStarted` (delivered) else `failed` `no_turn`; at most 16 wait, the oldest ending `no_turn`. `failed` `refused`
  to an agent whose `held` is true counts `held`. A `sent` to another agent within 30 s of the last `sent` counts
  `redirected_30s` on the first one's host. `turnAborted` within 10 s of a delivered turn's start counts
  `interrupted_10s`. `other` is use only.
- `opened`: the open flags, `ok` or `failed` and its code, by host.
- `hooked(id, agent)`: only while attached, once an agent a day: its engine's flag, and its state (`not_shown` unless
  `listed`; else `held`; else `other` on `UNKNOWN_APP`; else `placed`), and on `other` its app's flag and count.
- Waits: only while attached; one per key, at most 64 open; `waitEnded(answered)` counts `dial_wait_dial_<b>` when
  `answeredOnDial(key)` or `tapped(agentId)` came while it waited, else `dial_wait_elsewhere_<b>`; `gone` counts
  `dial_wait_none`; edges 30 000, 120 000, 600 000 ms; the last detach drops open waits uncounted (no close can be seen
  then).

- [ ] **Step 1: Write the failing spec `DUS`** with a sink that records adds, fake timers and `vi.setSystemTime`:
  `'connected on attach, and again past UTC midnight while attached'`; `'an attach alone is no use'`; `'each input is
  use; the first use ever once'`; `'first agent buckets at 59 999, 60 000, 180 000, 600 000 ms and none_1h'`;
  `'the first connection ever counts in both families, a later day's first in day only, a second attach in neither'`;
  `'engine and host of each agent shown, an agent once a day, at most 16'`; `'an unknown engine and host are other;
  terminal-app is terminal_app'`; `'delivered within 10 s, else no_turn; at most 16 wait'`; `'refused to a held agent is
  held'`; `'cancelled, failed by code, other'`; `'redirected within 30 s on the first voice\'s host'`; `'interrupted
  within 10 s of a delivered turn'`; `'opened ok and failed by code, by host'`; `'a hooked agent once a day at its
  state, Other by app, only while attached'`; `'wait buckets at 29 999, 30 000, 120 000, 600 000 ms'`;
  `'answered on the dial or after a tap is dial, else elsewhere; gone is none'`; `'a detach drops open waits'`;
  `'every name it adds is in DIAL_FILE_METRICS'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/dialUsage.spec.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `DU`.** Agent ids live only in its bounded in-memory maps and sets, cleared at the day's turn.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(cli): what the devices count of the dial`).

### Task 7: Voice and tap outcomes from the cable

**Files:** Modify `CS` (`CableHost` interface; `answerVoice` 2497-2752; `voice.abort` 2057), `cableVoice.spec.ts`,
`CH` (`CableHostWiring`; `openAgent` 1073-1101, `startDesktop` 1104-1119), `cableHost.spec.ts`.

**Interfaces:** Consumes `DialVoiceEnd`, `DialOpenEnd` from `DC`. Produces `CableHost.voiceEnded?(end: DialVoiceEnd)`,
`CableHostWiring.voiceEnded?(end: DialVoiceEnd)` and `CableHostWiring.openEnded?(agentId: string, end: DialOpenEnd)`.

Each voice turn reports exactly one end, at the exit that decides it: sent after `sendTurn` succeeded or the window
routed it (`inWindow.t === 'sent'`, its agent); `cancelled` for `voice.abort` and the window's cancel; `failed`
`window_busy` (abandoned), `no_speech` (both "Didn't catch that"), `transcribe_failed` (the transcript threw),
`route_failed` (the router threw), `no_agent` (none chosen, or the carried recipient gone), `refused` (`sendTurn`
answered `ok: false`, with its agent), `send_failed` (it threw); `other` for a draft, a form field and a search. A
person's tap (no `reason`) reports one open end: `ok` when the outside source opened it or the tap is handed to a
window; `not_opened`, `unknown_agent`, `desktop_not_started` (`launch()` false), `desktop_no_window` (the wait ran out).
A question screen that came up by itself reports nothing.

- [ ] **Step 1: Write the failing cases** in `cableVoice.spec.ts` (`'each voice turn reports one end: <exit>'`, one per
  exit above) and `cableHost.spec.ts` (`'a tap reports its open: <case>'`, and `'a question screen reports no open'`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableVoice.spec.ts src/cable/cableHost.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** One call per exit; `DaemonCableHost.voiceEnded` passes it to the wiring.
- [ ] **Step 4: Run** them and `npx vitest run src/cable`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(cli): the cable says how each voice and tap ended`).

### Task 8: Held agents and the Other page's app

**Files:** Modify `HD`, `hostDetect.spec.ts`, `OB` (the source's interface and `ingest` 881-1004), `observed.spec.ts`.

**Interfaces:** Consumes `DialOtherApp`. Produces `otherProduct(hints: Readonly<Record<string, string>>): DialOtherApp`
in `HD`, and on the observed source `heldOnly(agentId: string): boolean` (every pane it holds for the agent is `held`)
and `otherApp(agentId: string): DialOtherApp | undefined` (set from the hints of its latest hook while its app is
`UNKNOWN_APP`; only the product is kept, never the hint).

`otherProduct` reads `__CFBundleIdentifier`, then `TERM_PROGRAM`, by own keys only (`Object.hasOwn`): zed
`dev.zed.Zed`, `dev.zed.Zed-Preview`, `zed`; alacritty `org.alacritty` (the hook names it on Windows too, `notify.mjs`
678); hyper `co.zeit.hyper`, `Hyper`; tabby `org.tabby`, `Tabby`; jetbrains any bundle starting `com.jetbrains.`; rio
`com.raphaelamorim.rio`, `rio`; wave `dev.commandline.waveterm`, `waveterm`; nova `com.panic.Nova`; windsurf
`com.exafunction.windsurf`. Check each id against the app's published Info.plist or source and drop a row that cannot be
checked. Any other value is `unlisted`; neither hint is `unknown`.

- [ ] **Step 1: Write the failing cases:** `hostDetect.spec.ts` `'names the Other page\'s app from its fixed list'`
  (each row, the JetBrains prefix, `unlisted`, `unknown`, `constructor` → `unlisted`); `observed.spec.ts`
  `'heldOnly: every pane held'`, `'heldOnly is false with a pane that types or for an unknown agent'`,
  `'otherApp from the latest hook on the Other page, none on a host\'s page'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/hostDetect.spec.ts src/cable/hosts/observed.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** No new field on `HostAgent`, so nothing new reaches the dial, the listener or a log.
- [ ] **Step 4: Run** them and `npx vitest run src/cable/hosts`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(cli): held agents and the Other page's app, for the dial's counts`).

### Task 9: Devices wiring, phase 1

**Files:** Modify `DV`, `cli/src/services/devices.spec.ts`.

**Interfaces:** Consumes Tasks 5-8. Wires, inside `startDevices`, one `DialUsageFile` (`join(core.dataDir,
DIAL_USAGE_FILE)`, `after: timerIn('dialUsage')`, `signedIn: () => core.account.signedIn()`, `hadDial: () =>
readSetup(core.dataDir).dial`, `log`) and one `createDialUsage` with `describe(id)` from `cableHost.describe`,
`hostOf`, `appOf` (`harness` when none) and `observed?.heldOnly(id)`. Each call goes through `part.call('dialUsage', …)`
so a throw never reaches the dial:
- `watching` (1158): `attached(on)` and `agentsPresent(cableHost.agentTotal() > 0)`; the Harness agents' `changed`
  (520) and `outsideTurn` (1606) call `agentsPresent` again.
- `dialShows` (1169): `shown(cableHost.shownAgentId() ?? null)`.
- `turned` (1208), `scrolled` (1212), `tapped` (1191), `answer` and `answerReviewed` (1174-1175), `appPicked` (1257):
  `used()`.
- `voiceEnded` and `openEnded` (new wiring of Task 7): `voiceEnded(end)`, `opened(agentId, end)`.
- Turn starts: the `commander_event` `turn_started` card (2128), the observed `turn-start` hook (2359), and an outside
  listing going busy in `outsideTurn` (1644): `turnStarted(agentId)`. At the observed `turn-start`, after
  `observed.ingest`: `hooked(agentId, { …describe, listed, otherApp: observed.otherApp(agentId) })`, where `listed` is
  whether the registry holds a live row for the agent (`registry.entries()`, an `ended` or `resting` row not counted).
- The stop (2451): `usage.stop()` then the file's `close()`.

- [ ] **Step 1: Write the failing cases** with `start()`, a signed-in `fakeCore` and `seen.host`:
  `'writes the dial\'s day to dial-usage.json: connected on attach, used on a turn'`; `'counts nothing signed out'`;
  `'a greet\'s own focus is not use'` (Review Focus 4); `'counts the engine and host shown'`; `'a voice to a Harness
  agent is delivered by its turn_started card within 10 s'`; `'a voice to an outside agent is delivered by its
  turn-start hook'`; `'a refused voice to a held agent is held'`; `'a tap\'s open by host'`; `'a hooked agent\'s first
  turn-start of the day counts where it is'`; `'the stop writes what waits'`; `'dial-usage.json never names the agent,
  its folder or the dial'` (canaries in the agent's name, cwd, the dial's id and MAC).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t "dial-usage|dial usage"`. Expected: FAIL.
- [ ] **Step 3: Implement the wiring.**
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts` and `npm run test:core`. Expected: PASS, `DV` at 100%.
- [ ] **Step 5: Commit** (`feat(cli): the devices count the dial's day`).

### Task 10: Devices wiring, phase 2

**Files:** Modify `DV`, `cli/src/services/devices.spec.ts`.

**Interfaces:** Consumes Task 9's `usage`. Wires the waits and the interrupt:
- A Harness agent's question: opened where `cableQuestionFor` sets `questionsOpen` (2120), key
  `question:<agentId>:<requestId>`; the dial's `answer`/`answerReviewed` for it: `answeredOnDial`;
  `commander_question_close` (2106-2117): `answered`; `agent_deleted` (2143): `gone`.
- A notice: `notify` answered `shown` with kind `waiting` or `plain` (Decision 8), key `notice:<agentId>`.
  `endNotice` (1565) takes a cause, given at each of its callers: a tap (1191) `tapped` then `answered`; the next turn
  (2129, 2157, 2359, 1644) `answered`; its agent leaving the list (1617), `agent_deleted` (2143) and a replacing notice
  `gone`.
- An outside agent's wait (`shown`, `showWaits` 1496-1517): opened when it is added, `answered` when it goes while its
  agent is still listed, else `gone`; key `outside:<agentId>`.
- The observed `turn-aborted` hook (2356): `turnAborted(agentId)` (Decision 2).

- [ ] **Step 1: Write the failing cases:** `'a question answered on the dial is a dial wait'`; `'a question closed
  elsewhere is an elsewhere wait'`; `'a waiting notice ended by its next turn is elsewhere, by a tap is dial, by its
  agent leaving is none'`; `'a proceeding notice is no wait'`; `'an outside agent\'s wait'`; `'a turn aborted within
  10 s of a delivered voice'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t "wait|aborted"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts` and `npm run test:core`. Expected: PASS, `DV` at 100%.
- [ ] **Step 5: Commit** (`feat(cli): the dial's waits and interrupts`).

### Task 11: The gateway's merge

**Files:** Create `GD`, `GDS`.

**Interfaces (produces):**

```ts
export interface DialFileRead { series: number; days: Record<string, Partial<Record<DialFileMetric, number>>> }
export type DialRead = { state: 'ok'; file: DialFileRead } | { state: 'none' } | { state: 'bad' } | { state: 'same' }
export interface DialStamp { mtimeMs: number; size: number }
export function readDialFile(file: string, validDay: (day: string) => boolean, last?: DialStamp): { read: DialRead; stamp?: DialStamp }
export interface DialRecord { series: number | null; sent: Record<string, Partial<Record<DialFileMetric, number>>>
  closedThrough: string | null; baseline: boolean; usedDays: string[]; usedOutsideDays: string[] }
export function freshDialRecord(baseline: boolean): DialRecord
export function cleanDialRecord(value: unknown, validDay: (day: string) => boolean): DialRecord
export interface DialAdd { metric: DialUsageMetric; day: string; value: number }
export function mergeDial(record: DialRecord, file: DialFileRead, at: { closeBefore: string; desktopDays: readonly string[];
  validDay: (day: string) => boolean }): { record: DialRecord; adds: DialAdd[] }
```

- `readDialFile`: `statSync` (no file: `none`; same mtime and size as `last`: `same`; over
  `DIAL_USAGE_FILE_MAX_BYTES`: `bad`), then `readState(file, 'cache', jsonObject)`; version 1, a safe-integer series;
  each day valid, each name in `DIAL_FILE_METRICS`, each value a safe integer in (0, `DIAL_USAGE_MAX_COUNT`]; the rest
  dropped one by one, and nothing of it logged.
- `mergeDial`: with `baseline`, the file becomes `sent`, every day before `closeBefore` closed without a derivation,
  and nothing is added. A new series keeps the flags sent and forgets the event counts sent. Otherwise each
  `DIAL_DEVICE_METRICS` name adds what the file holds over what was sent, never below zero. Each day before
  `closeBefore` and after `closedThrough`, oldest first, closes: the outside-app twins when no `desktopDays` lies in
  D−27..D; for a used day, `dial_d<lag>_returning_…` on D−lag when `usedDays` holds it (outside apart from
  `usedOutsideDays`), and the period flags (Decision 3) against `usedDays` (Monday weeks; 28-day periods counted
  from 1970-01-05); the raw waits to `used_day` or `unused_day` with that group's flag; then its `sent` goes.
  `usedDays` and `usedOutsideDays` keep 35 days. A closed day's later changes add nothing.

- [ ] **Step 1: Write the failing spec `GDS`:** `'reads only the vocabulary and logs nothing'`; `'too large, not JSON,
  another version: bad'`; `'no file: none; unchanged: same, unparsed'`; `'a second merge of the same file adds
  nothing'`; `'a new series adds its events again but no flag already sent'`; `'a baseline adds nothing and closes
  what is past'`; `'a count that went down adds nothing'`; `'outside-app twins only with no Desktop day in D−27..D'`;
  `'returns on D−1, D−7, D−28, outside apart'`; `'waits go to the used or the unused day, with its flag'`; `'a closed
  day adds nothing more'`; `'sent holds only days not closed'`; `'the period flags once a week and once a 28-day
  period'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/gateway/dialUsage.spec.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `GD`.**
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(cli): the gateway's merge of the dial's day`).

### Task 12: The gateway reports it

**Files:** Modify `GP`, `cli/src/gateway/productUsage.spec.ts`.

**Interfaces:** Consumes Task 11. Produces `ProductUsageDeps.dialFile?: string` (no file read without it; Task 13 sets
it in `start.ts`). In `GP`:
- `State` gains `dial: DialRecord` and `desktopDays: string[]` (35 days, as `workDays`); `opened('desktop')` adds
  today. `fresh(revision, baseline = false)`; `choice()`'s reset (308), the `CHOICE_CHANGED` reset (397) and
  `stop(true)` (620) pass `true`; the load (154) keeps `dial` from the file, and a file whose `revision` is -1 with
  `dial.baseline` loads as `fresh(-1, true)`; a state that never had a file starts with `false`.
- Each tick, once enabled and before the report is built (after 361): `readDialFile` with the last stamp (kept in
  memory), `mergeDial` with `closeBefore` = the UTC day of now − 60 s, each add through a valued `add(metric, day,
  value)`; a `bad` read adds `dial_file_unreadable_installation_days`.
- `Counters`, `clean()` and the pending report take `DIAL_USAGE_METRICS` beside `PRODUCT_USAGE_METRICS` in a type of
  `GP`'s own. The report's groups (371-376): own, then dial (`dial_` names), then Node, then hn's. A 400 to a report of
  dial names only drops it like the Node one (404-407).

- [ ] **Step 1: Write the failing cases:** `'reports the dial\'s day in a report of its own'`; `'a restart sends
  nothing twice'`; `'off then on sends nothing counted before'`; `'an account change and a CHOICE_CHANGED take the
  file as sent'`; `'a first state with no queue file sends what the file holds'`; `'a 400 to dial names only is
  dropped, no rejection counted, and the next report goes'`; `'keeps Desktop\'s days 35 days for the outside flag'`;
  `'a bad file counts dial_file_unreadable once a day'`; `'with no dial file a tick only stats it'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/gateway/productUsage.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/gateway` and `npm run typecheck`. Then time it: `readDialFile` + `mergeDial`
  on a full 128 KiB file and on none, 1 000 runs each, median; put the numbers in the commit message.
  Expected: PASS.
- [ ] **Step 5: Commit** (`feat(cli): the gateway reports the dial's day`).

### Task 13: End to end, and the gateway pointed at the file

**Files:** Modify `cli/src/gateway/start.ts` (213-221). Create `cli/e2e/dialUsage.e2e.ts`. Modify
`cli/e2e/dialWindows.e2e.ts` (one case), `cli/ci-e2e-durations.json` (a hint for the new file).

**Interfaces:** Consumes the whole CLI side. `start.ts` passes `dialFile: join(env.ADAPTER_DATA_DIR, DIAL_USAGE_FILE)`
(the devices' `core.dataDir` is the same folder: `core/main.ts` 938, `devicesProcess.ts` 128). The e2e is built from
`e2e/productUsage.e2e.ts` (a `FakeBackend` with `productUsage`, a signed-in `session.json`) and
`e2e/devicesProcess.e2e.ts` (`desk.plug`, the fake dial, a window client).

- [ ] **Step 1: Write the failing cases.** `dialUsage.e2e.ts`: `'a dial plugged, turned and tapped reaches the
  signed-in report as counts only'`: a Claude agent in a folder named `PRIVATE_PROJECT_CANARY`, a window connected (so
  a tap is handed to it), a dial `E2E-A` / `e2:e0:00:00:00:0a`, `focus` then `agent.open`; until a report holds
  `dial_connected_installation_days: 1`,
  `dial_used_installation_days: 1`, `dial_engine_claude_installation_days: 1`, `dial_host_harness_installation_days: 1`,
  `dial_open_ok`; no report and no byte of `dial-usage.json` holds the canary, the agent id, the dial's id or MAC, or
  the machine name. `'a daemon restart sends no flag twice'`: restart, plug again, the day's sum of
  `dial_connected_installation_days` over every report stays 1. `dialWindows.e2e.ts`: `'signed in, the stand-in dial\'s
  attach reaches the report'` (the devices and the gateway inside the core's process on Windows).
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialUsage.e2e.ts` on the Mac (an
  isolated daemon: a throwaway home and data folder, its own port, never 18473). Expected: FAIL, no report holds a
  dial name, since the gateway is given no file.
- [ ] **Step 3: Set `dialFile` in `start.ts`.** A failure the run shows in another task's files is fixed there, and the
  commit says so.
- [ ] **Step 4: Run** it again. Expected: PASS. The Windows case runs in `windows-e2e` on PR CI.
- [ ] **Step 5: Commit** (`test(cli): the dial's counts end to end`).

### Task 14: Docs

**Files:** Modify `docs/product-measurement.md`, `cli/AGENTS.md`. No failing test: docs, one commit.

- [ ] **Step 1: `docs/product-measurement.md`:** a section "The dial's counts" after "The phone's counts": one table
  row per spec question (signal, then interpretation) with the names' families and every limit: signed in only, so it
  leans to voice users; the computer, not the dial; recognition covers hooked engines only and is read at each hooked
  agent's first turn of the day while a dial is attached; delivered means a turn
  began within 10 s, so words queued into a busy agent read `no_turn`; distinct agents are counted within a devices'
  run (a restart can count one again), at most 16 a name a day; waits are seen only while a dial is attached, and the
  comparison is dial-used days against connected-but-unused days (Decision 1); the interrupt proxy covers hooked
  agents only (Decision 2); the 7- and 28-day "distinct computers" of the dial-used, used-outside-app and first-use
  rows, computer-days elsewhere (Decision 3); voice: the dial's clips, audio and transcription time apart from the
  rest by the devices' one fixed header (`x-harness-voice-surface: dial`), the rest being the phone and any older
  CLI, which sends none, so the dial's share reads low until computers update; the account-day buckets cover all of
  an account's voice, dial and rest together, and transcription time is a total only (Decisions 4, 5); outside the
  app reads true only 28 days after a computer's update; a first agent measurement lost to a restart. In "Runtime and
  storage budget": the devices' file (35 days, 128 KiB, a write per 5 s at most, nothing while idle) and the gateway's
  read (a stat a tick, a parse when it changed). In "Rollout and privacy controls": backend first; an older backend
  refuses a report of dial names only, which the CLI drops without a rejection, and ignores the voice header; the
  "See what's shared" line on Desktop and the phone. In "Each daily review": the `dial` section.
- [ ] **Step 2: `cli/AGENTS.md`**, the devices row: the dial's day counts, fixed names and numbers only, at most 35 UTC
  days and 128 KiB, written at most every 5 s while signed in, in `dial-usage.json` (`cable/dialUsageFile.ts`), read by
  the gateway at its report tick (`gateway/dialUsage.ts`); the dial's voice upload marks itself with one fixed header.
- [ ] **Step 3: Commit** (`docs: the dial's usage counts`).

### Task 15: "See what's shared" names the dial and voice

**Files:** Modify `PD` (the "Shared fields" text, 203-231), `desktop/test/privacy_section_test.dart`, `PM` (`_sent`,
6-63), `mobile/test/privacy_page_test.dart`. Depends on nothing. Effort medium: one line of copy in each of two lists.

Both screens list what a report carries category by category (Desktop: bullets such as "Desktop and terminal app
opens", "Agent turns started, ended, or interrupted"; the phone: labelled lines "Activity", "Turns", "This phone", …),
so once dial counts and voice seconds are sent, each list would be incomplete: a wrong statement to the person
(Decision 6). The phone's line matters too: the phone's own voice seconds are now counted (as the rest).

Copy, exact (short; the existing lists' style):
- Desktop, a new bullet after `'• Launch, resume, restart, model change …'`:
  `'• Dial use: connections, agents shown by engine and host, voice and tap outcomes, wait buckets; seconds of voice transcribed, the dial\'s apart\n'`
- Phone, a new `_sent` entry after `This phone`:
  `(label: 'Dial and voice', text: 'Dial connections, agents shown by engine and host, voice and tap outcomes, wait buckets; seconds of voice transcribed, the dial\'s apart.')`

No design doc or gallery change: the line joins an existing text list and changes no UI element
(`desktop/design/desktop-design-system.md` has no entry for these lists). `mobile/` has no `AGENTS.md`; the root rules
apply.

- [ ] **Step 1: Write the failing widget tests**, each clicking through as a person does:
  - `desktop/test/privacy_section_test.dart`: `testWidgets('See what’s shared names the dial and voice', …)`: show the
    section with sharing on (the file's own `show` helper), `tap(find.text('See what’s shared'))`, `pumpAndSettle`,
    `expect(find.textContaining('Dial use:'), findsOneWidget)`,
    `expect(find.textContaining('seconds of voice transcribed'), findsOneWidget)`.
  - `mobile/test/privacy_page_test.dart`: `testWidgets('See what’s shared names the dial and voice', …)`: pump
    `PrivacyPage` as the file's first test does, tap `'See what’s shared'`, `pumpAndSettle`,
    `expect(find.text('Dial and voice'), findsOneWidget)`,
    `expect(find.textContaining('seconds of voice transcribed'), findsOneWidget)`.
- [ ] **Step 2: Run** `cd desktop && flutter test test/privacy_section_test.dart` and
  `cd mobile && flutter test test/privacy_page_test.dart` (one after the other, never two `flutter test` at once).
  Expected: FAIL, the text is not found.
- [ ] **Step 3: Add the two lines.**
- [ ] **Step 4: Run** the same two commands and `flutter analyze` in each folder. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(desktop,mobile): See what's shared names the dial and voice`).

### Task 16: The dial's upload says it is the dial's

**Files:** Modify `CH` (`transcribe`, 1408-1455: the `post` headers 1425-1429), `cli/src/cable/cableVoice.spec.ts`.
Depends on Task 1. Shares both files with Task 7 (devcrew runs them one at a time). Effort medium.

**Interfaces:** Consumes `DIAL_VOICE_SURFACE_HEADER`, `DIAL_VOICE_SURFACE` from `DC`. Produces: every upload to
`/api/voice/stt` from `DaemonCableHost.transcribe` carries `[DIAL_VOICE_SURFACE_HEADER]: DIAL_VOICE_SURFACE`, the 401
retry too; nothing else about the clip, the dial or the agent goes in a header. `wiring.transcribe` (the devices'
tests' stand-in) is unchanged. An older backend ignores the header; Task 3 reads it.

- [ ] **Step 1: Write the failing case** in `cableVoice.spec.ts`: `'marks the upload as the dial\'s, on the retry
  too, and with nothing else'`: a 401 then `ok()`; both calls' headers `toMatchObject({ 'x-harness-voice-surface':
  'dial' })`, and each call's header names are exactly `authorization`, `x-autonomous-env`, `content-type`,
  `x-harness-voice-surface`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableVoice.spec.ts`. Expected: FAIL, no such header.
- [ ] **Step 3: Add the header** to `post`'s `headers`, with a comment that it is how the backend counts the dial's
  voice apart (Decision 4) and carries no id.
- [ ] **Step 4: Run** it and `npx vitest run src/cable`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(cli): the dial's voice upload says it is the dial's`).

---

## Verification

**Local gates PR CI does not run** (from a clean tree at the final commit; paste the receipts in the PR body):
- `python3 scripts/local-checks.py --run`: it runs `npm run test:core` (for `cli/src/services/devices.ts`) and any other
  gate the paths need, and prints the receipts.
- `cd cli && npm run typecheck && npx vitest run src/architecture.spec.ts src/lib/stateWrites.guard.spec.ts`.
- `cd backend && npm run typecheck`.
- The core check of Global Constraints prints nothing.

**PR CI, selected by the paths, nothing dispatched by hand:** `cli-typecheck`, `cli-tests`, `backend-desk`,
`backend-integration` (with `integration/dialUsageReview.test.ts`), `windows-e2e` x64 (`cli/src/cable/` changed; it runs
`dialWindows.e2e.ts` with its new case), `dial-hosts` (`cli/src/cable/hosts/` changed), `linux-e2e` (the new
`dialUsage.e2e.ts`, and the dial app eval's five, which `cable/hosts/` and `services/devices.ts` select),
`desktop-tests` and `mobile-checks` (Task 15's widget tests), `process-checks`.

**End-to-end checks:**
1. **The dial's counts reach the report, counts only** (`cli/e2e/dialUsage.e2e.ts`). On the Mac:
   `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialUsage.e2e.ts`; on Linux it runs in `linux-e2e`. An
   isolated daemon (throwaway home and data folder, its own port, never the user's daemon on 18473; the guide is
   `docs/development.md` "Isolated end-to-end testing"), the in-memory `FakeBackend` with a made-up machine and token
   (no real account), a fake dial on a pseudo-terminal, a fake Claude Code. A person sees both cases pass; on failure
   the test prints the daemon log's last lines.
2. **Windows, with the devices and the gateway inside the core's process** (`cli/e2e/dialWindows.e2e.ts`'s new case):
   `windows-e2e` on PR CI, against its stand-in dial and the in-memory backend. No VM.
3. **Ingest to review on a real Mongo** (`backend/integration/dialUsageReview.test.ts`): `backend-integration` on PR
   CI, on the suite's disposable database with made-up accounts; a dial clip and a rest clip land in their own rows.
4. **"See what's shared" on both sides** (Task 15): the widget tests click through on `desktop-tests` and
   `mobile-checks`. For the PR's screenshots: Desktop on the Mac through `make terminal-local-manual` (its disposable
   local stack, a made-up account), Settings, sharing's "See what’s shared"; the phone on the iOS simulator, its
   Privacy page, "See what’s shared". A person sees the new line in each list.
5. **A real dial (optional, NOT needed for the merge; it needs harness-pm's approval first: it is Ken's dial, and his
   eye).** Checks 1-3 cover it with stand-ins. If approved: on the Mac, a second daemon with its own
   `ADAPTER_DATA_DIR` and port, signed in to the disposable stack of `make terminal-local-manual` with a test account,
   the dial plugged into it; turn, tap and speak (voice only if that local backend has a transcription key); then
   `cd backend && npm run usage:daily -- 28` with `DATABASE_URL` set to that local database: the `dial` section shows
   the computer as `"<5"`, and the dial's voice apart from the rest.

**Numbers for the PR** (code standard 4): Task 12's timings; the devices' writes during check 1 (at most one per 5 s
while the dial moves, none idle).

**PR-body notes:**
- Backend rules 3 and 5 (Decision 7): no collection, index or query shape is added; `usage:daily`'s existing read only
  takes a longer `in` list. The growth estimate comes from the vocabulary, no production read: the upper bound of new
  `product_usage_totals` rows a day is (names in `DIAL_USAGE_METRICS` × 3 prefixes) + (10 voice names × 2 prefixes,
  no `testing:`) + (3 margin names × the releases and platforms seen that day × 3 prefixes), each row kept 396 days by
  the existing TTL; the PR states that number and the realistic one (the few dozen names a computer uses a day).
- "See what's shared": the PR names `desktop/lib/settings/sections/privacy_section.dart` 203-231 and
  `mobile/lib/phone/privacy_shared_fields.dart` 6-63, which list categories, and the line each gained.
- Mixed releases: an older backend ignores the voice header; an older CLI sends none, so its clips count as the rest.
- Platforms: macOS, Linux, Windows (CLI), and Desktop and the phone (copy only).

**Production:** no check runs against it. Rollout: backend before CLI, as `docs/product-measurement.md` says.

## Decisions

harness-pm, 2026-11-23, answering the draft's open questions (the spec's "Settled while planning" holds the same):

1. **The wait comparison** is between days a dial was used and days it was connected but not used, labelled so in
   the review (Tasks 6, 10, 11, 4). A computer with no dial runs no devices component (`lib/commander.ts` 382-389,
   `cable/notices.ts` 127), so it cannot be measured without a core change.
2. **The interrupt proxy** counts hooked agents only, through their `turn-aborted` hook (Task 10); Harness's own
   agents' aborted turns emit `done` like a finished one (`lib/commander.ts` 537-541, 1146).
3. **Period flags** for the main rows: dial used and used outside the app get first use in the UTC Monday week and
   in a fixed 28-day period (Task 11), shown as distinct computers in the review's 7- and 28-day columns (Task 4).
   First use is covered without a flag of its own: it fires once ever per computer, so its sums are already distinct
   computers, and the review labels them so.
4. **Dial voice apart:** the devices' upload sends one fixed header, `x-harness-voice-surface: dial` (Tasks 1, 16),
   and the backend counts the dial's clips, audio and transcription time apart from the rest: the phone and anything
   without the header (Task 3), shown apart in the review (Task 4) and the docs (Task 14). An older backend ignores
   the header; an older CLI sends none, so its clips count as the rest.
5. **Voice cost:** audio seconds bucketed per account-day, transcription time a total only (Task 3). The account-day
   buckets cover the account's whole voice, dial and rest together: they come from the account's shared quota
   bucket, and a dial-only bucket would need a new per-account record, which the spec's Design rules out.
6. **"See what's shared":** both screens list specific categories (`desktop/lib/settings/sections/privacy_section.dart`
   203-231, `mobile/lib/phone/privacy_shared_fields.dart` 6-63), so each gains one line with a widget test that
   clicks through to it (Task 15).
7. **Backend rule 5:** a growth estimate from the vocabulary in the PR body, no production reads (Verification,
   PR-body notes).
8. **"Needs you" waits** are the `waiting` and `plain` notices, not `proceeding` (Task 10).

Also: any check with a real dial needs harness-pm's approval first (Verification, check 5).
