# Dial voice to Codex and other engines in Terminal.app, iTerm2 and Ghostty: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Words spoken at the dial reach the selected agent in iTerm2 or Ghostty ≥ 1.3 on macOS (any engine at its
prompt), and a Codex on any Codex home Harness trusts takes them through its own queue on every OS; when the target
cannot be proven, nothing is sent and the dial says `<name> did not answer.`

**Architecture:** Part A: `ObservedActions.codexHome` becomes `codexHomes()` (the daemon's `CODEX_HOME`, the adopted
homes and the linked profiles, each with its real path, from a new read-only reader in `lib/codexProfiles.ts`), the
deepest trusted home holding the rollout is the one `codex queue` runs under (`CodexQueue.send(…, home)`). Part B: a tabs
pane carries a proof (`pid` + `start` from the same `ps` read as its tty); a new `HO/tabsType.ts` gives the tabs adapter
`canType`/`type`, running the spec's seven checks through a two-step helper shared with VS Code (`HO/twoStep.ts`); the
devices write `write`/`enter` lines on the tabs stream and wait for the watch's `wrote` tell (`SV/devicesListener.ts`);
the watch passes them to Harness Device on macOS only (`devices/client.ts`); Harness Device runs them in order on its tab
thread through new fixed iTerm2 and Ghostty handlers (`DA/tabs.rs`, `DA/tabs_macos.rs`, `DA/watch.rs`, `DA/runner.rs`).

**Tech Stack:** TypeScript (Node 24) and Vitest with injected fakes and fake timers; Rust stable with `cargo test`
(objc2 / `NSAppleScript` on macOS); the dial app eval (tier A spec, tier B e2e files) as the no-drop gate.

**Spec:** `docs/plans/2026-11-25-dial-voice-codex-terminals-design.md` (approved; read it with this plan). Base:
`feat/dial-voice-codex-terminals` at `aebe0b6416` (the spec is its first commit, on `origin/main`). The planner commits
nothing: this plan is the main session's to commit.

Paths: `HO/` is `cli/src/cable/hosts/`; `SV/` is `cli/src/services/`; `EV/` is `cli/src/testing/dialAppEval/`; `DA/` is
`device-app/src-tauri/src/`. CLI commands run in `cli/`; Rust commands in `device-app/src-tauri/`.

## Decisions already made (PM, 2026-11-25): not reopened

1. Approach B. Part A: the queue under every trusted Codex home (daemon `env.CODEX_HOME`, adopted `codexHomeRoots`,
   linked profiles through a new read-only reader); never a home from a hook's path or `rolloutHome()`; the deepest home
   wins; both the listed and the real-path spelling are tried; the ChatGPT wake keeps `env.CODEX_HOME`; Orca's Codex
   homes stay out. Part B: iTerm2 `write` and Ghostty ≥ 1.3 `input text` + `send key "enter"` through Harness Device's
   fixed AppleScript handlers; Terminal.app ⛔; Linux Ghostty ⛔.
2. All seven checks of the spec's table, before the words and again before the Enter; text → settle → recheck → Enter;
   "sent" only when Harness Device answers ok for the Enter; every failure sends nothing more and logs one fixed reason
   word (no text, tty, pid or id in any log, error or measure; never on the watch's stderr).
3. VS Code's two-step pattern (`HO/vscodeTerminals.ts` `type`) moves into one shared helper both adapters use, with the
   same `CONTROL`/`LONE_SURROGATE` clean and `INJECT_PASTE_DELAY_*` settle.
4. An engine whose hooks never report the end of a turn always reads busy and is never typed into.
5. Eval: only two harness edits beside `EV/baseline.json`, no scenario or check changed: the fake tabs stream ignores
   lines that are not selects (Task 11); the tier-A world answers the new `ps`/`lsof` probes "not readable" (Task 5 gives
   its `tty` no start, Task 10 gives its two new probes `undefined`), so `tabs` never types in the eval. Another
   hill-climb may touch `HO/`: keep edits focused.
6. No core change (`cli/src/core/`). `device-app/AGENTS.md` gains the spoken-text / terminal-write rule.
7. Diego's held manual check runs on his Mac before merge. Nothing scripts real iTerm2, Ghostty or Terminal, and no real
   Codex or Claude Code runs on this Mac (fakes only).

## What this plan decides from the spec's words

- **Where the typing lives.** The watch loads `HO/tabs.ts`, so the typing (two-step helper, process-table walk, `lsof`)
  goes in a new `HO/tabsType.ts`; `SV/devices.ts` spreads its `canType`/`type` onto the tabs adapter (adapter rule 2: a
  plain object a caller may spread). The line formats the devices, the watch and the adapter share go in a new
  `HO/tabsLines.ts`.
- **The proof.** `readTty` is replaced by `readTabTty` (`ps -o tty=,lstart= -p <pid>`, `psEnv()`), giving
  `{ tty, start? }`. The observed source keeps the start beside `ttyPid`; a place carries `proof: { pid: ttyPid, start }`
  only when both were read and the agent is not nested; `tabs.paneOf` copies it onto the pane.
- **The lstart parser** is `lib/lstart.ts` (`lstartMs`, `lstartGeneration` → `ps:<ms>`), exactly `Date.parse` as
  `listProcesses` does today, which moves onto it (Windows' rows keep today's values).
- **Reasons, check by check:** no line or a replaced/ended line → `no-stream`; no proof → `nested`; Terminal.app →
  `terminal-app`; another live agent on the tty → `shared`; `ps` unreadable, tty or start not the proof's, or
  `tpgid ≤ 0` → `process`; `pgid ≠ tpgid` → `background`; a stdin holder that is not the agent or an ancestor, or
  `lsof` / the table unreadable → `foreground-child`; `atPrompt()` false → `busy` (Open question 1); Harness Device's
  `ok:false` → `no-session` (Open question 2); no answer in `TYPE_ANSWER_MS`, a stream still draining past it, or a line
  over 64 KiB → `no-answer`. A text empty after the clean, or a tty already locked, answers `false` (the source's
  existing `no-answer`).
- **A draining stream.** A step (words or Enter) whose line is not writable waits on `ready(TYPE_ANSWER_MS)`, then runs
  checks 1 to 6 again before it writes: a line never goes on checks older than the wait.
- **Bounds the spec leaves to the code (AGENTS.md rule 4):** at most `WRITES_PENDING = 8` writes awaiting a `wrote` in
  the devices; at most `TYPING_QUEUED = 8` typings queued in Harness Device; past either, answered no at once.
- **Harness Device's order** on its tab thread: lines for the log, then the oldest typing, then the waiting select, then
  a poll (a typing's 500 ms bound is the tighter one). A new watch drops the typings still queued, and an answer goes
  only to the watch it came from (by the runner's watch number).
- **The linked reader** checks the file with `lstatSync` (a regular file, this account's, and off Windows not group- or
  world-writable, at most 1 MiB), then reads it with `probeState` (`readState`'s cache path would set an unparsable file
  aside: a read-only reader moves nothing). It never chmods.
- **A home given to `codex queue`** that is not absolute, or holds a NUL, is refused (`failed · refused`).
- **"Deepest"** is the trusted spelling with the most path segments once resolved; the spelling that matched is the
  `CODEX_HOME` the queue runs under.
- **Each `wrote` tell** goes from the watch at once, one tell each, never merged with another or held behind a gap.
- **Harness Device's late line** is `tabs: <iTerm2|Ghostty> <write|enter> dropped late`, once per dropped typing.

## Global Constraints

- Nothing under `cli/src/core/` changes; `cli/src/architecture.coreFiles.txt` is unchanged.
- Part B is macOS only. Linux and Windows: no agent has a proof (ttys are read only on darwin), the watch refuses
  `write`/`enter` lines off macOS, Harness Device's `NoTabs` answers no. Part A runs on macOS, Linux and Windows.
- Never: synthetic keystrokes, System Events, `do script`, `keystroke`, `key code`, or any write to Terminal.app.
- Log lines are fixed words: `[device] voice · tabs`, `[device] voice · refused (tabs · <reason>)`, and Harness
  Device's `tabs: <App> <write|enter> dropped late`. No text, tty, pid, id or path in a log line, error, measure or the
  watch's stderr.
- Bounds: `TYPE_LINE_MAX = 65_536` bytes, newline included, at the devices, the watch and Harness Device (`DA/cli.rs`
  `LINE_MAX`, unchanged); `MAX_TEXT = 20_000` UTF-16 units (`HO/orca.ts`; Rust counts `encode_utf16()`);
  `WROTE_MAX_BYTES = 64`; `WROTE_PER_SECOND = 10`; `WRITES_PENDING = 8`; `TYPING_QUEUED = 8`;
  `TYPE_ANSWER_MS = 3_000`; `LATE_WRITE = 500 ms`; `lsof` 2 s; `ps` 1 s and 256 bytes; `TRUSTED_HOMES_MS = 30_000`.
- Ids: 16 lowercase hex from `crypto.randomBytes(8)`; the Enter gets a new id.
- Clean and settle: `CONTROL` (`/\p{Cc}/gu`) → space, `LONE_SURROGATE` (`/\p{Cs}/gu`) → U+FFFD; settle
  `min(INJECT_PASTE_DELAY_MAX_MS, INJECT_PASTE_DELAY_BASE_MS + floor(len / 60))` (1500, 400).
- Every `ps` whose output is parsed runs with `psEnv()` (`lib/childLocale.ts`).
- No new copy: every refusal of part B says `<name> did not answer.`.
- `SV/` stays at 100% per file (`npm run test:core`).
- Tests use fakes only: no real Codex, Claude Code, iTerm2, Ghostty or Terminal is run or scripted, and
  `scratch_terminal_windows` is never run.
- Ask the PM for the Mac before running tier A's spec, any e2e file, `npm run test:core` or `local-checks.py --run`: one
  such run at a time on this Mac. Focused spec files run freely.
- Comments say why (cli/AGENTS.md rule 7); names follow `docs/naming-system.md`.

## Review Focus

1. **The terminal app quit between the words and the Enter.** An Apple Event to an app that is not running launches it.
   Task 14: with `running(app)` false at the Enter, no script call is made and the answer is `ok:false`.
2. **The longest text, counted alike on every hop.** The CLI counts UTF-16 units; a Rust `chars().count()` would refuse
   texts the devices sent. Tasks 1 and 12: 20,000 units of `é`, 10,000 `😀` (20,000 units) and 20,000 `中` pass, 20,001
   units do not, and the longest line stays under 64 KiB.
3. **A cleaned text passes, a forged one does not.** Tasks 1 and 12: U+2028, U+00A0 and U+FFFD pass; `\n`, U+007F and
   U+0085 are refused by the watch's and Harness Device's checks.
4. **Harness Device relaunched (a new watch) while a write waits.** Task 6: the old stream's pending sends answer
   `ended` and settle, the new `line()` is another object, a late `wrote` for an old id changes nothing. Task 14: an
   older watch's typing is answered to no watch.
5. **Two sends at once to agents in two tabs.** Task 10: each `write` and `enter` names only its own agent's tty, and the
   two do not wait for each other (the lock is per tty).

---

### Task 1: The tabs line formats (`HO/tabsLines.ts`)

**Effort:** high (the checks on outside lines that reach a terminal's script).
**Depends on:** none.
**OS:** pure functions, the same everywhere; only macOS ever sends or passes such lines.

**Files:**
- Create: `cli/src/cable/hosts/tabsLines.ts`
- Create: `cli/src/cable/hosts/tabsLines.spec.ts`

**Interfaces:**
- Consumes: `TAB_TTY`, `TabApp` (`HO/tabs.ts`); `MAX_TEXT`, `CONTROL` (`HO/orca.ts`, already in the watch's imports
  through `hostDetect.ts` → `hcClient.ts`).
- Produces:
  - `export const TYPE_APPS = ['iterm', 'ghostty'] as const; export type TypeApp = (typeof TYPE_APPS)[number]`
  - `export const WRITE_ID = /^[0-9a-f]{16}$/`, `TYPE_LINE_MAX = 65_536`, `TYPE_ANSWER_MS = 3_000`
  - `export type TabsWrite = { write: { app: TypeApp; tty: string; text: string } } | { enter: { app: TypeApp; tty: string } }`
  - `export type TabsTyping = { write: { id: string; app: TypeApp; tty: string; text: string } } | { enter: { id: string; app: TypeApp; tty: string } }`
  - `export function typingOf(value: unknown): TabsTyping | null` — exactly one top key and exactly the keys above; app
    in `TYPE_APPS`; tty passes `TAB_TTY`; id passes `WRITE_ID`; text non-empty, at most `MAX_TEXT` UTF-16 units, no
    `CONTROL` character.
  - `export function typingLine(typing: TabsTyping): string | null` — the JSON line with its `\n`, null past
    `TYPE_LINE_MAX` bytes.
  - `export function wroteOf(value: unknown): { id: string; ok: boolean } | null` — exactly `{ id, ok }`.
  - `export type WroteAnswer = 'ok' | 'refused' | 'unanswered' | 'ended'` — `refused`: the watch told `ok:false`;
    `unanswered`: no answer in `TYPE_ANSWER_MS`, a line over `TYPE_LINE_MAX`, `WRITES_PENDING` already waiting, or the
    stream not writable; `ended`: the stream ended first.
  - `export interface TabsLine { writable(): boolean; ready(ms: number): Promise<boolean>; send(line: TabsWrite): { answer: Promise<WroteAnswer>; settled: Promise<void> }; readonly ended: AbortSignal }`
    — `settled` resolves once the answer arrived or the stream ended, whichever first (the tty's lock waits on it).

- [ ] **Step 1: Write the failing tests** in `tabsLines.spec.ts`:
  - `typingOf` takes `{write:{id,app:'iterm',tty:'/dev/ttys003',text:'hi'}}` and `{enter:{id,app:'ghostty',tty}}` and
    returns an equal value; it refuses `terminal-app`, `vscode`, tty `/dev/ttys12345` and `/dev/pts/1`, ids of 15 and
    17 hex and upper case, `text: ''`, a text holding `\n`, U+007F or U+0085, an extra key at either level, an `enter`
    with `text`, a `write` and an `enter` together.
  - Review Focus 2: 20,000 `é`, 10,000 `😀` and 20,000 `中` pass; 20,001 units refused; `typingLine` of the 20,000 `中`
    write is under 64 KiB, and one of a 70,000-byte text is null.
  - Review Focus 3: texts holding U+2028, U+00A0 and U+FFFD pass.
  - `wroteOf` takes `{id, ok:true}` and `{id, ok:false}`; refuses `ok: 'true'`, a bad id, an extra key.
- [ ] **Step 2: Run them to verify they fail.** `npx vitest run src/cable/hosts/tabsLines.spec.ts` → FAIL
  (`tabsLines.js` not found).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement `tabsLines.ts`.** Header comment: these lines carry a person's words to a terminal; every hop
  checks them again, and the watch loads this file, so it imports only `tabs.ts` and `orca.ts`.
- [ ] **Step 5: Run to verify they pass.** `npx vitest run src/cable/hosts/tabsLines.spec.ts && npm run typecheck` → PASS.
- [ ] **Step 6: Commit:** `Dial: the lines that carry spoken words to a terminal tab, and their checks`.

### Task 2: One two-step helper for typed words (`HO/twoStep.ts`)

**Effort:** high (moves VS Code's safety-critical send onto shared code with unchanged behavior).
**Depends on:** none.
**OS:** VS Code's terminals on every OS; its behavior is unchanged on all three.

**Files:**
- Create: `cli/src/cable/hosts/twoStep.ts`
- Create: `cli/src/cable/hosts/twoStep.spec.ts`
- Modify: `cli/src/cable/hosts/vscodeTerminals.ts` (`type`, ~lines 527-563; `LONE_SURROGATE` and the `sending` set go)
- Test (unchanged, must pass): `cli/src/cable/hosts/vscodeTerminals.spec.ts`

**Interfaces:**
- Produces:
  - `export const LONE_SURROGATE = /\p{Cs}/gu`
  - `export function cleanWords(text: string): string | undefined` — `CONTROL` → space, lone surrogate → U+FFFD;
    undefined when empty or over `MAX_TEXT`.
  - `export function settleMs(words: string): number`
  - `export type StepAnswer<R> = { ok: true; held?: Promise<void> } | { ok: false; why: R; held?: Promise<void> }`
  - `export interface TwoSteps<R> { check(before: 'words' | 'enter'): Promise<R | undefined>; words(): Promise<StepAnswer<R>>; enter(): Promise<StepAnswer<R>> }`
  - `export interface TwoStep<K> { sending(key: K): boolean; send<R>(key: K, words: string, steps: TwoSteps<R>, failed: R): Promise<true | R> }`
  - `export function createTwoStep<K>(after: (ms: number, run: () => void) => unknown): TwoStep<K>` — a key already
    sending answers `failed` and runs no step; `check('words')` → `words()` → wait `settleMs(words)` → `check('enter')`
    → `enter()` → `true`; the first refusal stops it; a step that throws or rejects answers `failed`; the key stays
    locked until `send` ended **and** every `held` it was handed settled.

- [ ] **Step 1: Write the failing tests** in `twoStep.spec.ts` (fake `after` recording its ms):
  - `cleanWords('a\nb\tc\u001b[0m')` is `'a b c [0m'`; `'x\ud800y'` → `'x�y'`; `''` and `MAX_TEXT + 1` units →
    undefined; `MAX_TEXT` units kept.
  - `settleMs` of 0, 60 and 100,000 characters: 400, 401, 1500.
  - The order of calls for a send that goes through, and `after` asked once with `settleMs(words)`.
  - A `check('words')` refusal: its value, no `words()`; a `words()` refusal: its `why`, no `check('enter')`; a
    `check('enter')` refusal: no `enter()`.
  - A second send on a sending key answers `failed` and calls nothing; another key runs meanwhile.
  - A `held` promise keeps `sending(key)` true after `send` resolved, until it settles.
  - A step that throws, and one that rejects: `failed`, and the key is free after.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/cable/hosts/twoStep.spec.ts` → FAIL (module not found).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement `twoStep.ts`, then move `vscodeTerminals.ts` `type` onto it.** VS Code's `check` is
  `typeGuard` then `same() && atPrompt()`, and at `'enter'` a guard's `'background'` answers `'failed'` as today; its
  `words`/`enter` are `{ ok: window.stream.write(line) }`; `failed` is `'failed'`; `true` maps to `'typed'`. Its byte
  check of the line stays before the send.
- [ ] **Step 5: Run to verify.** `npx vitest run src/cable/hosts/twoStep.spec.ts src/cable/hosts/vscodeTerminals.spec.ts src/cable/hosts/vscode.spec.ts && npm run typecheck`
  → PASS, `vscodeTerminals.spec.ts` unchanged.
- [ ] **Step 6: Commit:** `Dial: one two-step send for typed words, which VS Code's terminals use`.

### Task 3: The linked Codex homes, read-only (`lib/codexProfiles.ts`)

**Effort:** xhigh (which homes' `config.toml` a `codex queue` may load: a trust decision).
**Depends on:** none.
**OS:** every OS; on Windows the mode bits are not checked (as `secureState.ts`), the data folder's place protects it.

**Files:**
- Modify: `cli/src/lib/codexProfiles.ts`
- Modify: `cli/src/lib/codexProfiles.test.ts`

**Interfaces:**
- Consumes: `probeState`, `jsonArray` (`lib/secureState.ts`); the module's `FILE`, `MAX_LINKED`, `linkedIn`.
- Produces:
  - `export function readLinkedCodexHomes(): string[]` — the rule in "What this plan decides"; anything else is `[]`.
  - `export const TRUSTED_HOMES_MS = 30_000`
  - `export function trustedCodexHomes(own: () => readonly string[], now: () => number, read: () => string[] = readLinkedCodexHomes, real: (path: string) => string | null = realOrNull): () => readonly string[]`
    — `own()` asked at every call (an adopted home counts at once), then the linked homes; each followed by its real path
    when that differs; no duplicates; the linked read and each path's real path held `TRUSTED_HOMES_MS` on `now`
    (monotonic).

- [ ] **Step 1: Write the failing tests** in `codexProfiles.test.ts`, in the suite's own data folder:
  - A `0o600` file of `['/a', '/b']` reads as both; a `0o640` one reads too and is still `0o640` after (the linker's
    reader would have made it `0o600`); `0o660` and `0o606` read as `[]` and keep their mode; a symlink at the file reads
    as `[]`; bytes that are not JSON read as `[]` and the file is still there, unrenamed; 300 entries give the first 256.
  - `trustedCodexHomes` with own `['/o']`, linked `['/l']` and `real('/o') = '/private/o'` gives
    `['/o', '/private/o', '/l']`; 100 calls within 30 s read the file once, a call at 30 s reads it again; `own` is asked
    at each call.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/lib/codexProfiles.test.ts` → FAIL (exports missing).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement both.** Comment: the queue loads the home's `config.toml`, so only Harness's own records name a
  home, and a list another account could write names none; `can()` asks every 1 s tick, hence the hold.
- [ ] **Step 5: Run to verify.** `npx vitest run src/lib/codexProfiles.test.ts && npm run typecheck` → PASS.
- [ ] **Step 6: Commit:** `Dial: the Codex profiles a person linked, read without touching their file`.

### Task 4: A tabs refusal's count, and the agents on one tty (`HO/types.ts`, `HO/observed.ts`)

**Effort:** high.
**Depends on:** none.
**OS:** counting on every OS; `othersOnTty` finds agents only where ttys are read (macOS).

**Files:**
- Modify: `cli/src/cable/hosts/types.ts` (`TypeResult`, new `TABS_REASONS`)
- Modify: `cli/src/cable/hosts/observed.ts` (`ObservedActions.count`, `countWord`, `send` ~lines 484-496, new `othersOnTty`)
- Modify: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Produces:
  - `export const TABS_REASONS = ['no-stream', 'nested', 'terminal-app', 'shared', 'process', 'background', 'foreground-child', 'busy', 'no-session', 'no-answer'] as const`
    (`busy`: Open question 1), `export type TabsReason`, `export function isTabsReason(word: unknown): word is TabsReason`
  - `TypeResult = boolean | 'busy' | 'waiting' | { refused: string } | { notSent: TabsReason }`
  - `ObservedActions.count` also takes `{ notSent: HostAdapter; reason: TabsReason }`; `countWord` says
    `refused (<adapter id> · <reason>)`.
  - `ObservedSource.othersOnTty(tty: string, pid: number): boolean` — a live entry whose `tty` is that tty and whose
    `ttyPid` is not `pid` (a nested one, whose `tty` is its client's, counts).

- [ ] **Step 1: Write the failing tests** in `observed.spec.ts` (`describe('ObservedSource actions')`):
  - A typer answering `{ notSent: 'shared' }`: the send answers `<name> did not answer.`, the count is exactly one
    `refused (tabs · shared)`, no `no-answer` beside it, and the dial prompt record is forgotten.
  - `{ notSent: 'oops' }` (outside the list) counts `no-answer` only.
  - `othersOnTty`: two live agents on `/dev/ttys003` (ttyPids 4101, 4102) → true for 4101; one → false; an ended one does
    not count; a nested one whose client tab is that tty counts.
  - Decision 4 pinned: an engine with no turn-end hook (e.g. `gemini`) heard at `turn-start` and nothing after, with a
    typer that types: the send answers busy and the typer is never called.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/cable/hosts/observed.spec.ts` → FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** `send` reads a `notSent` only off an object whose word passes `isTabsReason`, as it reads a
  refusal: fixed words alone reach the log.
- [ ] **Step 5: Run to verify.** `npx vitest run src/cable/hosts/observed.spec.ts && npm run typecheck` → PASS.
- [ ] **Step 6: Commit:** `Dial: a terminal tab's refused words are one fixed line, by reason`.

### Task 5: A tab's pane carries the proof of its process (`HO/tabs.ts`, `HO/observed.ts`)

**Effort:** xhigh (the identity every later check rests on).
**Depends on:** none.
**OS:** macOS only (`ttyOf` exists only on darwin). Linux and Windows: no agent has a proof, nothing else changes;
`listProcesses` gives the same values on every OS.

**Files:**
- Create: `cli/src/lib/lstart.ts`, `cli/src/lib/lstart.spec.ts`
- Modify: `cli/src/lib/sessionSearch/externals/support.ts` (`listProcesses`, ~line 222)
- Modify: `cli/src/cable/hosts/tabs.ts` (`readTty` → `readTabTty`; `runPs` uses `psEnv()` and is exported; `paneTab`
  exported; `paneOf` adds the proof; the header comment says what the file loads)
- Modify: `cli/src/cable/hosts/tabs.spec.ts`
- Modify: `cli/src/cable/hosts/adapter.ts` (`Proof`, `Place.proof`, `Pane.proof`)
- Modify: `cli/src/cable/hosts/observed.ts` (`ObservedDeps.tty`, `Entry.ttyStart`, `learnTty`, `placeOf`, `there()`)
- Modify: `cli/src/cable/hosts/observed.spec.ts`
- Modify: `cli/src/services/devices.ts` (`DevicesDeps.tty` ~line 201, `ttyOf` ~line 604)
- Modify: `cli/src/services/devices.spec.ts` (each `tty` fake answers `{ tty }`)
- Modify: `cli/src/testing/dialAppEval/tierA/world.ts` (`tty`, ~line 541: `{ tty: '/dev/<name>' }` with no start: the
  start probe is not readable there, Decision 5)

**Interfaces:**
- Produces:
  - `lib/lstart.ts`: `export function lstartMs(lstart: string): number | undefined` (`Date.parse`, finite);
    `export function lstartGeneration(lstart: string): string | undefined` (`ps:<ms>`).
  - `HO/tabs.ts`: `export interface TabTty { tty: string; start?: string }`;
    `export async function readTabTty(pid: number, run: RunPs = runPs): Promise<TabTty | undefined>` (one
    `ps -o tty=,lstart= -p <pid>`, 1 s, 256 bytes; rejects when the run failed; `??`, nothing or a tty `TAB_TTY` refuses
    → undefined; an unparsed start → `{ tty }`); `export const runPs: RunPs`; `export function paneTab(pane: Pane): Tab | null`.
  - `HO/adapter.ts`: `export interface Proof { pid: number; start: string }`; `Place.proof?: Proof`; `Pane.proof?: Proof`.
  - `ObservedDeps.tty?(pid: number): Promise<TabTty | undefined>`; `DevicesDeps.tty?: (pid: number) => Promise<TabTty | undefined>`.

- [ ] **Step 1: Write the failing tests:**
  - `lstart.spec.ts`: `lstartGeneration('Tue Nov 25 10:00:00 2026')` is `` `ps:${Date.parse('Tue Nov 25 10:00:00 2026')}` ``;
    `''`, `'garbage'` and `'Di. 25 Nov. 10:00:00 2026'` → undefined.
  - `tabs.spec.ts`: `readTabTty` asks `['-o', 'tty=,lstart=', '-p', '4101']` once with `{ timeout: 1000, maxBuffer: 256 }`;
    `'ttys003  Tue Nov 25 10:00:00 2026\n'` → `{ tty: '/dev/ttys003', start: lstartGeneration(…) }`; `'??  Tue …'` and
    `''` → undefined; `'ttys003  garbage'` → `{ tty: '/dev/ttys003' }`; a failed run rejects; a pid that is not a
    positive integer is not asked. Locale (skip on win32): with `process.env.LC_ALL = 'de_DE.UTF-8'` (restored after),
    the real `runPs(['-o', 'lstart=', '-p', String(process.pid)], …)` prints a start `lstartGeneration` reads.
    `paneOf` of a place with `proof` and no `outer` gives the pane that proof; with `outer`, or without `proof`, none.
  - `observed.spec.ts` (`describe('ObservedSource tabs')`): a hook from caller 4101 in iTerm2 with `tty` answering
    `{ tty: '/dev/ttys003', start: 'ps:1' }` gives its tabs pane `proof: { pid: 4101, start: 'ps:1' }`; a nested one's
    tabs pane has none; with a typer that waits between words and Enter, a hook from caller 4102 on the same tty
    (`start: 'ps:2'`) makes `atPrompt()` false and the send sends nothing more.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/lib/lstart.spec.ts src/cable/hosts/tabs.spec.ts src/cable/hosts/observed.spec.ts`
  → FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** `listProcesses` takes `started` and `generation` from `lstartMs`/`lstartGeneration`;
  `there()` compares the pane's adapter, id and proof (`pid` and `start`); the observed source keeps `ttyStart` from the
  same read as `tty`, cleared with it. Update `devices.spec.ts`'s fakes and `world.ts`'s `tty` to the new shape.
- [ ] **Step 5: Run to verify.** `npx vitest run src/lib/lstart.spec.ts src/lib/sessionSearch/externals/support.spec.ts src/cable/hosts/tabs.spec.ts src/cable/hosts/observed.spec.ts src/services/devices.spec.ts && npm run typecheck`
  → PASS.
- [ ] **Step 6: Commit:** `Dial: a terminal tab's pane names the process its tty was read for, and when it started`.

### Task 6: The tabs stream writes and hears `wrote` (`SV/devicesListener.ts`)

**Effort:** xhigh (pending answers, timeouts, the drain wait, a lock held past its answer).
**Depends on:** Task 1.
**OS:** the listener runs on every OS (Windows on its pipe); a write is sent only for a pane with a proof (macOS).

**Files:**
- Modify: `cli/src/services/devicesListener.ts` (`TabsStream`, `tabsStream`, ~lines 552-580; new constants)
- Modify: `cli/src/services/devicesListener.spec.ts`

**Interfaces:**
- Consumes: Task 1's `TabsLine`, `TabsWrite`, `WroteAnswer`, `typingLine`, `wroteOf`, `TYPE_ANSWER_MS`.
- Produces:
  - `export const WROTE_PER_SECOND = 10`, `WROTE_MAX_BYTES = 64`, `WRITES_PENDING = 8`
  - `TabsStream.line(): TabsLine | undefined` (the same object until its stream ends; another after a newer opens)
  - `TabsStream.wrote: ListenerHandler` (`{ type: 'wrote', id, ok }`: answers that pending id; an unknown or answered id
    is taken and changes nothing; a malformed body is `REFUSED`)
  - `export function tabsStream(deps?: { id?: () => string; after?: (ms: number, run: () => void) => () => void }): TabsStream`
    (defaults: `randomBytes(8).toString('hex')`, an unref'd `setTimeout`)

- [ ] **Step 1: Write the failing tests** in `devicesListener.spec.ts`, on a fake `ListenerStream` and fake `after`:
  - `line()` lifecycle as above; none with none open.
  - `send({ write })` writes exactly `{"write":{"id":<16 hex>,"app","tty","text"}}`; the Enter `{"enter":{"id","app","tty"}}`
    with another id.
  - `wrote` ok → `'ok'` and settled; ok false → `'refused'`; none in 3 s → `'unanswered'` with `settled` still pending,
    then settled by a late `wrote` (answer unchanged) or by the stream's end; a stream that ends first → `'ended'`.
  - Unknown, answered and other-stream ids: taken, nothing answered. Extra key, 15-hex id, `ok: 1`: `REFUSED`. The
    longest well-formed body is under `WROTE_MAX_BYTES`; the handler declares 64 bytes and 10 a second.
  - A line over `TYPE_LINE_MAX` → `'unanswered'`, nothing written. A ninth pending send → `'unanswered'`, nothing
    written.
  - While a select drains: `writable()` false, `send` → `'unanswered'` with nothing written; `ready(500)` resolves true
    at the drain, false at 500 ms, false at the stream's end.
  - Review Focus 4: a newer stream replaces the old: the old's pending sends answer `'ended'` and settle, `line()` is the
    new object, a late `wrote` for an old id changes nothing, and selects go to the new stream.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/services/devicesListener.spec.ts` → FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** One `onWritable` per stream wakes the `ready` waiters; the pending map is keyed by id and
  holds its stream. Comment why the lock waits on `settled`: Harness Device's script thread can hold a write for minutes
  behind a consent prompt, and a late write must never meet another send's Enter.
- [ ] **Step 5: Run to verify.** `npx vitest run src/services/devicesListener.spec.ts && npm run typecheck` → PASS.
- [ ] **Step 6: Commit:** `Dial: the tabs stream carries a spoken text and its Enter, and hears whether each was written`.

### Task 7: The watch passes writes on macOS and tells `wrote` (`devices/client.ts`)

**Effort:** high.
**Depends on:** Task 1.
**OS:** write and enter lines go on only on macOS; on Linux and Windows the watch prints none of them.

**Files:**
- Modify: `cli/src/devices/client.ts` (`DialWatchDeps.tell`, `printSelect`, `openStream`'s `lines(…)`, the stdin handler)
- Modify: `cli/src/devices/client.spec.ts`

**Interfaces:**
- Consumes: Task 1's `typingOf`, `wroteOf`, `TYPE_LINE_MAX`.
- Produces: `DialWatchDeps.tell` also takes `{ type: 'wrote'; id: string; ok: boolean }`. Stdout gets each passed
  typing as `JSON.stringify(typing)`; stdin's `{"wrote":{"id","ok"}}` (that key alone) is told at once.

- [ ] **Step 1: Write the failing tests** in `client.spec.ts` (a new `describe('harness hardware watch: spoken words')`):
  - On `platform: 'darwin'`, a stream `write` line prints exactly that line; an `enter` too; a write line just under
    64 KiB prints, one over prints nothing and the next line still prints.
  - A select padded past 96 bytes prints nothing; a select prints `{"select":…}` as today.
  - On `'linux'` and `'win32'`: write and enter lines print nothing.
  - `terminal-app`, `/dev/pts/1`, a 15-hex id, `text: ''`, a text with `\n`, an extra key: nothing.
  - Stdin `{"wrote":{"id":…,"ok":true}}` → one tell `{ type: 'wrote', id, ok: true }`; two in a row → two tells in order;
    with an extra key, or a bad id → no tell.
  - Through all of the above, `printError` is never called.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/devices/client.spec.ts` → FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** Stream lines are read up to `TYPE_LINE_MAX`; a select line keeps its own 96 bytes after the
  read. Comment: the watch's stderr is Harness Device's log line by line (`DA/cli.rs`), so nothing of these lines goes there.
- [ ] **Step 5: Run to verify.** `npx vitest run src/devices/client.spec.ts && npm run typecheck` → PASS.
- [ ] **Step 6: Commit:** `Dial: the watch hands spoken words to Harness Device on macOS, and tells back what was written`.

### Task 8: Typing into an iTerm2 or Ghostty tab (`HO/tabsType.ts`)

**Effort:** xhigh (the never-a-wrong-pane rule; concurrency with late answers and replaced streams).
**Depends on:** Tasks 1, 2, 4, 5.
**OS:** macOS only in effect (no proof elsewhere); `readTabProcess` and `readTtyReaders` are never asked off macOS.

**Files:**
- Create: `cli/src/cable/hosts/tabsType.ts`
- Create: `cli/src/cable/hosts/tabsType.spec.ts`

**Interfaces:**
- Consumes: `paneTab`, `runPs`, `RunPs` (Task 5); `Proof`, `Pane` (Task 5); `TypeResult`, `TabsReason` (Task 4);
  `createTwoStep`, `cleanWords` (Task 2); `TabsLine`, `TYPE_ANSWER_MS` (Task 1); `lstartGeneration` (Task 5);
  `parentChain`, `ProcessName` (`HO/scannedApp.ts`).
- Produces:
  - `export interface TabProcess { tty: string; pgid: number; tpgid: number; start?: string }`
  - `export async function readTabProcess(pid: number, run: RunPs = runPs): Promise<TabProcess | undefined>` — one
    `ps -o tty=,pgid=,tpgid=,lstart= -p <pid>`, 1 s, 256 bytes; undefined for a failed run, no row, two rows or a row it
    cannot read.
  - `export type RunLsof = (args: string[], bounds: { timeout: number; maxBuffer: number }) => Promise<{ code: number | null; stdout: string } | null>`
  - `export const READERS_TIMEOUT_MS = 2_000`
  - `export async function readTtyReaders(tty: string, run: RunLsof = runLsof): Promise<readonly number[] | undefined>`
    — `/usr/sbin/lsof -a -d 0 -t <tty>`, 2 s, 4 KiB, SIGKILL; exit 0 or 1: the pids printed (none → `[]`); anything else
    → undefined; a tty `TAB_TTY` refuses is never run.
  - `export interface TabsTypeDeps { line(): TabsLine | undefined; shared(tty: string, pid: number): boolean; process(pid: number): Promise<TabProcess | undefined>; readers(tty: string): Promise<readonly number[] | undefined>; processes(): Promise<readonly ProcessName[]>; after(ms: number, run: () => void): () => void }`
  - `export function tabsTyping(deps: TabsTypeDeps): Required<Pick<HostAdapter, 'canType' | 'type'>>` — `canType`: a
    line is open, the pane has a proof, its app is not `terminal-app`. `type`: the sequence of the spec with the reasons
    of "What this plan decides"; the line is the one taken at the start (check 1 compares by identity); the lock key is
    the tty; `write` → answer → settle → checks again → `enter` → answer; only `'ok'` for the Enter answers `true`.

- [ ] **Step 1: Write the failing tests** in `tabsType.spec.ts`, with a fake `TabsLine` (records lines, answers each
  send as told, can drain, end or be replaced), fake probes and fake `after`:
  - `readTabProcess` asks once with the args and bounds above and reads `'ttys003  4101  4101 Tue Nov 25 10:00:00 2026'`;
    `??`, no row, two rows, a failed run → undefined. `readTtyReaders` runs the args above; `'4101\n4100\n'` →
    `[4101, 4100]`; exit 1 with nothing → `[]`; exit 1 with pids → those pids; a timeout or spawn error → undefined.
  - `canType` true only for an open line, a proof and iTerm2 or Ghostty.
  - Each check failing writes no line and answers `{ notSent }` with its reason: no line, a line replaced during the
    probes (`no-stream`); a pane without proof (`nested`); Terminal.app (`terminal-app`); `shared` true (`shared`); `ps`
    undefined, tty differs, start differs, `tpgid: 0` (`process`); `pgid ≠ tpgid` (`background`); a reader outside the
    agent's chain, the agent not among the readers, readers undefined, a table that rejects (`foreground-child`, Open
    question 3); `atPrompt()` false after the probes (`busy`, Open question 1).
  - The full path: one `{ write: { app, tty, text } }`, its `'ok'`, `after` asked with `settleMs(text)`, every probe and
    `atPrompt` asked again, one `{ enter: { app, tty } }`, its `'ok'` → `true`.
  - Text `'refused'` → no Enter, `{ notSent: 'no-session' }` (Open question 2); `'unanswered'` → `no-answer`;
    `'ended'` → `no-stream`; the Enter's `'refused'` → `no-session`, nothing more.
  - A recheck failing (any check) → no Enter, its reason.
  - A late answer keeps the lock: the text's answer is `'unanswered'` at 3 s with `settled` pending; a second send on
    that tty answers `false` and writes nothing; once `settled` resolves, a third send writes.
  - A line replaced between the write and the Enter → no Enter, `no-stream`.
  - Draining: `writable()` false, `ready` true → the checks are asked again, then the line is written; `ready` false →
    nothing written, `no-answer` (`no-stream` when the line ended).
  - `'a\nb\u001b\ud800'` is written as `'a b �'` (with the space for ESC).
  - A probe or `send` that throws or rejects answers its reason or `false`; `type` never rejects.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/cable/hosts/tabsType.spec.ts` → FAIL (module not found).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement `tabsType.ts`.** Header comment: why each check exists (the spec's table, one line each: a
  `codex exec` from Claude's shell tool on the same tty, Ctrl-Z, Claude Code's Ctrl-G editor, `!` commands, a pty no
  session of the app holds), and that it logs nothing: its reasons travel in the result.
- [ ] **Step 5: Run to verify.** `npx vitest run src/cable/hosts/tabsType.spec.ts && npm run typecheck` → PASS.
- [ ] **Step 6: Commit:** `Dial: words for an agent at its prompt in an iTerm2 or Ghostty tab, after seven checks`.

### Task 9: Codex's queue under every home Harness trusts (part A)

**Effort:** xhigh (which home's config the queue loads; a hook never chooses it).
**Depends on:** Task 3.
**OS:** macOS, Linux and Windows alike: each gains the adopted and linked homes; on Windows `within` ignores case.

**Files:**
- Modify: `cli/src/cable/hosts/codexQueue.ts` (`CodexQueueDeps` loses `home`; `CodexQueue.send`)
- Modify: `cli/src/cable/hosts/codexQueue.spec.ts`
- Modify: `cli/src/cable/hosts/appWake.ts` (`AppWakeDeps.codexHome`; the send at ~line 178)
- Modify: `cli/src/cable/hosts/appWake.spec.ts`
- Modify: `cli/src/cable/hosts/observed.ts` (`ObservedActions.codexHomes`, `queueable` → `queueHome`, `send`)
- Modify: `cli/src/cable/hosts/observed.spec.ts` (`describe('ObservedSource and codex queue')`; the actions helper ~line 1563)
- Modify: `cli/src/services/devices.ts` (`createCodexQueue` ~576; the observed actions ~889-894; the app wake ~1052)
- Modify: `cli/src/services/devices.spec.ts`
- Modify: `cli/e2e/deviceCodex.e2e.ts`

**Interfaces:**
- Consumes: Task 3's `trustedCodexHomes`; `codexHomeRoots` (`lib/engineHomes.ts`).
- Produces: `CodexQueue.send(threadId: string, text: string, isApp: boolean, home: string): Promise<CodexQueueResult>`;
  `AppWakeDeps.codexHome: string`; `ObservedActions.codexHomes(): readonly string[]`;
  `ObservedSource` private `queueHome(e, actions): string | undefined`.

- [ ] **Step 1: Write the failing tests:**
  - `codexQueue.spec.ts`: two sends under `/h/a` then `/h/b` run with `CODEX_HOME` `/h/a` then `/h/b`; a relative home
    and one holding a NUL answer `failed · refused` and run nothing.
  - `appWake.spec.ts`: the wake's queue send gets the wake's `codexHome`.
  - `observed.spec.ts` with `codexHomes: () => ['/h/own', '/h/adopted', '/h/linked', '/real/linked']`: a rollout under
    `/h/adopted/sessions` queues with `/h/adopted`; under `/real/linked/sessions` with `/real/linked`; a rollout under
    `/h/hooked/sessions`, whose hook names that home, is not queue-able (no queue run, no voice letter without a typer);
    with `['/h/a', '/h/a/sessions/b']`, a rollout under `/h/a/sessions/b/sessions/…` queues with `/h/a/sessions/b`.
  - `devices.spec.ts`: the observed source's homes are `env.CODEX_HOME`, an adopted home and a linked profile (a `0o600`
    `codex-profiles.json` in the suite's data folder), never an Orca account's Codex home; the ChatGPT wake runs
    `codex queue` under `env.CODEX_HOME`.
  - `deviceCodex.e2e.ts`: a Codex session whose `CODEX_HOME` is a linked profile (its real path written to
    `codex-profiles.json`, `0o600`, before the daemon starts; `CodexOutside`'s `home` option) takes the words through one
    `codex queue` call whose `codexHome` is that profile; a session in a home neither adopted nor linked gets no
    `codex queue` call and the daemon's log says no `[device] voice · codex`.
- [ ] **Step 2: Run the unit specs to verify they fail.** `npx vitest run src/cable/hosts/codexQueue.spec.ts src/cable/hosts/appWake.spec.ts src/cable/hosts/observed.spec.ts src/services/devices.spec.ts`
  → FAIL. (The e2e file runs in Verification 3, on the PM's turn.)
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** Comment at `queueHome`: the home comes only from Harness's lists, a hook's path only picks
  among them, and the deepest one holding the rollout is the session's.
- [ ] **Step 5: Run to verify.** The Step 2 command and `npm run typecheck` → PASS.
- [ ] **Step 6: Commit:** `Dial: Codex in a home Harness adopted or a profile the person linked takes spoken words through its queue`.

### Task 10: The devices type into tabs (`SV/devices.ts`)

**Effort:** xhigh (devices-process wiring of a path that types; the wrong-session rule end to end).
**Depends on:** Tasks 4, 6, 8.
**OS:** macOS; on Linux and Windows the probes are wired but never asked (no proof).

**Files:**
- Modify: `cli/src/services/devices.ts` (`DevicesDeps.tabProcess`, `DevicesDeps.ttyReaders`; `tabsStream({ after })`
  ~580; the tabs adapter ~755 becomes `{ ...createTabsAdapter(…), ...tabsTyping(…) }`; the listener's handlers ~2707
  gain `wrote: tabs.wrote`)
- Modify: `cli/src/services/devices.spec.ts`
- Modify: `cli/src/testing/dialAppEval/tierA/world.ts` (`tabProcess: async () => undefined`, `ttyReaders: async () => undefined`)
- Modify: `cli/src/testing/dialAppEval/tierA/world.spec.ts`

**Interfaces:**
- Consumes: Task 8's `tabsTyping`, `readTabProcess`, `readTtyReaders`; Task 6's `line()`, `wrote`; Task 4's
  `othersOnTty`; `readProcessNames` (`HO/scannedApp.ts`); `timerIn`.
- Produces: `DevicesDeps.tabProcess?: (pid: number) => Promise<TabProcess | undefined>`;
  `DevicesDeps.ttyReaders?: (tty: string) => Promise<readonly number[] | undefined>`; the tabs adapter's
  `shared: (tty, pid) => observed?.othersOnTty(tty, pid) ?? true`.

- [ ] **Step 1: Write the failing tests:**
  - `devices.spec.ts`, through the listener's own handlers (a fake watch opens `tabs`, posts `wrote`), fake timers,
    `orca: onMac`, agents in plain iTerm2 tabs with proofs, probes answering foreground and the agent alone on stdin:
    - the dial's words give one write line naming the agent's tty, its `wrote` ok, the settle, one enter line, its
      `wrote` ok, and the dial is told sent; the log says `[device] voice · tabs` and holds no tty and no word of the text;
    - wrong session: with A and B in two tabs, words for A never produce a line naming B's tty; with A's probe answering
      another start, no line at all and `[device] voice · refused (tabs · process)`;
    - Review Focus 5: sends to A and to B at once: each write and enter names its own tty, and B's write goes before A's
      Enter;
    - a probe saying `pgid ≠ tpgid` → no line, `refused (tabs · background)`; a Terminal.app agent → no line,
      `<name> did not answer.`;
    - the listener's handlers include `wrote` (64 bytes, 10 a second).
  - `world.spec.ts`: the world's `tty` answers no start and its `tabProcess` and `ttyReaders` answer undefined, so an
    iTerm2 agent's tabs pane has no proof and takes no words.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/services/devices.spec.ts src/testing/dialAppEval/tierA/world.spec.ts`
  → FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement the wiring** (one line per dep; no logic in the wiring).
- [ ] **Step 5: Run to verify.** The Step 2 command and `npm run typecheck` → PASS. Ask the PM for the Mac, then
  `npm run test:core` → every file at 100%.
- [ ] **Step 6: Commit:** `Dial: the devices type spoken words into an iTerm2 or Ghostty tab through Harness Device`.

### Task 11: The eval's fake tabs stream records selects only (`EV/tierA/steps/iterm.ts`)

**Effort:** medium (one function of the eval harness, Decision 5's first edit).
**Depends on:** none.
**OS:** tier A on every OS; iTerm2's scenarios are darwin's.

**Files:**
- Modify: `cli/src/testing/dialAppEval/tierA/steps/iterm.ts` (`openTabs`'s `write`, ~line 85)
- Modify: `cli/src/testing/dialAppEval/tierA/steps/iterm.spec.ts`

- [ ] **Step 1: Write the failing test** in `iterm.spec.ts`: a `{ write: {…} }` and an `{ enter: {…} }` line written on
  the stream `openTabs` opened are taken (`true`) and record nothing in `world.streams`; a select is recorded as today.
- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/testing/dialAppEval/tierA/steps/iterm.spec.ts` → FAIL.
- [ ] **Step 3: Commit the red test.**
- [ ] **Step 4: Implement:** a line `tabOf` refuses is taken and not recorded.
- [ ] **Step 5: Run to verify.** The Step 2 command → PASS.
- [ ] **Step 6: Commit:** `Dial eval: tier A's tabs stream records selects only`.

### Task 12: Harness Device reads typing lines and queues them (`DA/tabs.rs`)

**Effort:** xhigh (the last check before a terminal's script; consent; late writes).
**Depends on:** none.
**OS:** compiles and is tested on every OS (PR CI's Linux and Windows legs); only macOS has scripts that write.

**Files:**
- Modify: `device-app/src-tauri/src/tabs.rs`

**Interfaces:**
- Produces:
  - `pub const LATE_WRITE: Duration = Duration::from_millis(500)`, `pub const MAX_TEXT: usize = 20_000`,
    `pub const TYPING_QUEUED: usize = 8`
  - `pub enum Typing { Write { id: String, app: TabApp, tty: String, text: String }, Enter { id: String, app: TabApp, tty: String } }`
    with `id()`, `app()`, `tty()`
  - `pub fn typing_of(line: &str) -> Option<Typing>` (the rules of Task 1's `typingOf`; text counted in `encode_utf16()`
    units, refused on any `char::is_control`)
  - `pub fn wrote_line(id: &str, ok: bool) -> String` (`{"wrote":{"id":"…","ok":…}}`)
  - `pub enum Written { Done, NoSession }`
  - `TabScripts::write_text(&self, app: TabApp, tty: &str, text: &str) -> Result<Written, TabError>` and
    `TabScripts::send_enter(&self, app: TabApp, tty: &str) -> Result<Written, TabError>`, each with a default body
    `Ok(Written::NoSession)`: an app with no write handler (Terminal, every app off macOS, `NoTabs`) writes nothing.
  - `pub enum Next { Run(Typing), Refused { line: String, log: Option<String> } }`
  - `TabFollow::typed(&mut self, typing: Typing, at: Instant) -> Option<String>` (a `wrote` false line at once when the
    queue is full or the app is off), `TabFollow::next_typing(&mut self, now: Instant) -> Option<Next>` (the oldest:
    past `LATE_WRITE` → refused with the late line; app off, or no poll or select of it answered without error in this
    run → refused, no log), `TabFollow::written(&mut self, typing: &Typing, done: Result<Written, TabError>) -> Out`
    (`Out.line` is the `wrote` line, ok only for `Done`; `Denied`, `NoTty`, `NoScripting` turn the app off as today).
    `polled` and `selected` mark an app whose answer was `Ok(_)`; `watching` drops the typings queued.

- [ ] **Step 1: Write the failing tests** in `tabs.rs`'s `mod tests`:
  `a_write_line_is_read_only_when_its_app_tty_id_and_text_pass`, `terminal_never_takes_a_write`,
  `an_enter_line_has_no_text`, `a_line_with_another_key_is_dropped`,
  `the_longest_text_is_counted_in_utf16_units_as_the_cli_counts_it` (Review Focus 2),
  `a_text_the_devices_cleaned_passes_and_a_control_character_does_not` (Review Focus 3),
  `the_wrote_line_is_one_short_line`, `a_typing_runs_only_for_an_app_whose_poll_or_select_answered`,
  `an_app_turned_off_answers_no`, `a_typing_that_waited_past_500_ms_is_dropped_unrun_with_one_fixed_line`,
  `typings_run_in_order_and_a_select_keeps_its_own_slot`, `a_full_queue_answers_no_at_once`,
  `a_new_watch_drops_the_typings_waiting`, `done_answers_ok_and_no_session_answers_no`, and `no_log_line_holds_a_tty`
  extended to the write lines and their text.
- [ ] **Step 2: Run to verify they fail.** `cargo test --locked --lib tabs::` → FAIL (does not compile).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** Module comment: a spoken text is as private as a tty; it goes to a fixed handler's
  parameter and nowhere else.
- [ ] **Step 5: Run to verify.** `cargo test --locked --lib` → PASS (`cd ../ui && npm run build` first if `ui/dist` is
  missing).
- [ ] **Step 6: Commit:** `Harness Device: the lines that carry spoken words to a tab, in their own ordered queue`.

### Task 13: The iTerm2 and Ghostty write handlers (`DA/tabs_macos.rs`)

**Effort:** xhigh (the scripts that put words in a terminal).
**Depends on:** Task 12.
**OS:** macOS only (the module compiles there alone; tested by hand on a Mac, Verification 2).

**Files:**
- Modify: `device-app/src-tauri/src/tabs_macos.rs`

**Interfaces:**
- Consumes: Task 12's `Written`, the trait methods, `tty_ok`.
- Produces: `MacTabs::write_text` / `send_enter`: Terminal → `Ok(Written::NoSession)` with no event; iTerm2 and Ghostty
  call handlers `write_text(t, s)` and `send_enter(t)` with the tty and the text as two `Arg::Text` parameters, Ghostty
  after `scripted()`; `true` → `Done`, `false` → `NoSession`.
  - `ITERM`: every `«class cwin»` (no `«property pvis»` filter), every `«class Trmt»`, every `«class Trms»` whose
    `«property Stty»` is `t`; anything but exactly one → `false`; then `«event Itrmsntx»` to it with `«class Text»` `s`
    and `«class Wtnl»` false (codes from `iTerm2.sdef`: `write` `Itrmsntx`, `text` `Text`, `newline` `Wtnl`). The Enter:
    the same search, then the same event with the text `character id 13` and `«class Wtnl»` false.
  - `GHOSTTY`: every terminal of every window whose `«property Gtty»` is `t`, exactly one, then `input text` `s` to it;
    the Enter `send key "enter"` to it. Codes taken from `Ghostty.sdef` at the `v1.3.0` tag (ghostty-org/ghostty).
  - Both inside `with timeout of 2 seconds`, each first asking `running of application id app_id`.

- [ ] **Step 1: Write the failing tests** in `tabs_macos.rs`'s `mod tests`:
  `iterm_and_ghostty_have_the_write_handlers_and_terminal_none`,
  `the_write_handlers_search_every_window_and_write_to_exactly_one` (their bodies hold no `«property pvis»`, and a
  `is not 1 then return false` comes before the write event), `iterms_write_never_adds_a_newline`,
  `no_source_types_keys_or_runs_a_command` (no `dosc`, `do script`, `System Events`, `keystroke`, `key code`),
  `a_write_passes_its_tty_and_text_as_parameters` (a stand-in source with no event, as `ECHO`/`ANSWERS` do),
  `terminal_answers_no_session_with_no_event`, and extend `every_source_compiles`,
  `each_source_tells_only_its_own_app_within_the_call_timeout`, `a_tty_that_fails_the_check_is_never_sent` and
  `the_fixed_sources_hold_no_tty_and_read_nothing_but_ttys_and_selection` (its allowed events gain the two writes).
- [ ] **Step 2: Run to verify they fail, on a Mac.** `cargo test --locked --lib tabs_macos::` → FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** Comment on each handler: why every window (a hidden window's session is still the agent's),
  why exactly one (check 7: a pty no session of the app holds is not its pane), why `newline` false (the Enter is its own
  write, after the settle).
- [ ] **Step 5: Run to verify, on a Mac.** `cargo test --locked --lib` → PASS. Never `--ignored`.
- [ ] **Step 6: Commit:** `Harness Device: fixed iTerm2 and Ghostty handlers write spoken words to the one session of a tty`.

### Task 14: The watch's typing lines run on the tab thread (`DA/watch.rs`, `DA/runner.rs`)

**Effort:** xhigh (the tab thread's order, its locks, answers to the right watch).
**Depends on:** Task 12.
**OS:** every OS compiles and tests it (`cfg(all(test, unix))` for the fake CLI on Linux and macOS); off macOS
`tabs::system()` is `NoTabs`, which answers no.

**Files:**
- Modify: `device-app/src-tauri/src/watch.rs` (`spawn_watch` takes a `typing` callback; `Watch::wrote`)
- Modify: `device-app/src-tauri/src/runner.rs` (`Call::Typing`, `Tabs::next`, `follow_tabs`, `spawn_watch`)

**Interfaces:**
- Consumes: Task 12's `typing_of`, `Typing`, `Next`, `TabFollow::{typed, next_typing, written}`, the trait methods.
- Produces: `spawn_watch(cli, log, send, select, typing: impl Fn(Typing) + Send + 'static)`;
  `Watch::wrote(&self, line: &str)`; a typing's immediate answer from `typed()` goes back to its watch at once; the tab
  thread writes `Next::Refused`'s line (and logs its late line) or runs `Next::Run` with `write_text` / `send_enter`
  (after `running(app)`; not running → answered no, no event), and writes each answer to the watch whose number queued
  it, if it is still the current one.

- [ ] **Step 1: Write the failing tests:**
  - `watch.rs`: `a_write_line_reaches_the_typing_and_is_no_status`, `an_enter_line_too`,
    `the_longest_write_line_reaches_the_typing` (64 KiB, as `cli.rs` hands it), `a_wrote_answer_reaches_the_watch`.
  - `runner.rs` (fake `Scripts` gains `write_text`/`send_enter`, recorded as calls): a write after an ok poll runs
    `write_text` once and the watch's stdin gets `{"wrote":{…,"ok":true}}`; `NoSession` → `ok:false`; Review Focus 1:
    `running` false at the Enter → no call, `ok:false`; no ok poll or select yet → no call, `ok:false`; a write that
    waited past 500 ms behind a gated call → no call, `ok:false`, the log `tabs: iTerm2 write dropped late`; a write and
    a select waiting together → the write first; two writes in arrival order; Review Focus 4: an older watch's write is
    answered to no watch; no log line holds the tty or the text.
- [ ] **Step 2: Run to verify they fail.** `cargo test --locked --lib watch:: runner::` → FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** The `Tabs` lock is never held across a script call, a write or `send` (as today).
- [ ] **Step 5: Run to verify.** `cargo test --locked --lib` → PASS.
- [ ] **Step 6: Commit:** `Harness Device: spoken words run in order on the tab thread and are answered to their watch`.

### Task 15: The rules and the devices row (`device-app/AGENTS.md`, `cli/AGENTS.md`)

**Effort:** medium (docs). No failing test: it changes no behavior; one commit.
**Depends on:** none (it names only what this plan fixes).
**OS:** none.

**Files:**
- Modify: `device-app/AGENTS.md` ("Rules a change keeps": the "Fixed scripts" bullet and a new bullet beside it and the
  privacy bullets)
- Modify: `cli/AGENTS.md` (the `devices` row of the processes table: its voice clause, "a Codex session in Harness's own
  Codex home takes it in every state through `codex queue` …")

- [ ] **Step 1: Write `device-app/AGENTS.md`.** A bullet **Spoken text and terminal writes.**: a text reaches a terminal
  only through the fixed `write_text`/`send_enter` handlers of iTerm2 and Ghostty in `tabs_macos.rs`, as a handler
  parameter after the watch's and the app's checks; never Terminal; never keystrokes, System Events or `do script`;
  exactly one session or terminal of that tty, in every window; a typing older than 500 ms on the tab thread is dropped;
  only to an app whose poll or select answered in this run; answered only to the watch it came from; never logged (the
  late line names the app alone). "Fixed scripts" says a tty and a text reach a script only as parameters.
- [ ] **Step 2: Write `cli/AGENTS.md`'s clause:** a Codex session whose rollout is in a Codex home Harness trusts (its
  `CODEX_HOME`, a home it adopted, a profile the person linked; never Orca's) takes it through `codex queue` under that
  home (`cable/hosts/codexQueue.ts`); an agent at its prompt in a plain iTerm2 or Ghostty tab on macOS takes it through
  Harness Device's write handlers after seven checks (`cable/hosts/tabsType.ts`).
- [ ] **Step 3: Commit:** `Docs: the rules for spoken words in a terminal tab, and the devices row`.

### Task 16: End to end: voice into a plain iTerm2 tab against a fake Harness Device (`cli/e2e/dialTerminalVoice.e2e.ts`)

**Effort:** high.
**Depends on:** Tasks 7, 10.
**OS:** macOS only (`describe.skipIf(process.platform !== 'darwin')`); on PR CI's Linux leg every case skips.

**Files:**
- Create: `cli/e2e/dialTerminalVoice.e2e.ts` (no harness change: `IsolatedDaemon`, `Desk`, `FakeBackend`, `Outside`
  with iTerm2's hints, as `dialTerminalFollow.e2e.ts` and `deviceCodex.e2e.ts` use them)

- [ ] **Step 1: Write the test.** The real daemon; a fake Claude Code without its mod in a pseudo-terminal tab with
  `TERM_PROGRAM=iTerm.app` and iTerm2's bundle id (`Outside.start`, its tab's shell if check 5 needs one); the real
  `harness hardware watch --json` under the daemon's environment only (never this Mac's daemon, port 18473); the test
  plays Harness Device: `{"front":"com.googlecode.iterm2"}` on stdin, each `{"write":…}` on stdout kept and answered
  `{"wrote":{id,ok:true}}`, each `{"enter":…}` typed into the tab as the kept text and Enter (`Outside.type`) and
  answered ok. Cases:
  - the dial's words: one write line naming the agent's tty (`/dev/` + `ps -o tty=` of its pid) and the text, one enter
    line with another id, at least 395 ms after the write's answer; `UserPromptSubmit` ran once; the daemon's log says
    `[device] voice · tabs`; the dial is told sent;
  - the write answered `ok:false`: no enter line, `refused (tabs · no-session)`, the dial told `<name> did not answer.`;
  - `Outside.background()` (Ctrl-Z): no write line, `refused (tabs · background)`;
  - the daemon's log and the watch's stderr hold no tty and no word of the text.
- [ ] **Step 2: Run it, on the PM's turn.** `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialTerminalVoice.e2e.ts`
  → PASS (it is new: no red commit; a case that fails is a finding for the task it tests).
- [ ] **Step 3: Commit:** `Dial e2e: spoken words reach an agent in a plain iTerm2 tab through a stand-in Harness Device`.

---

## Verification

Every check runs on the final head, after the final review's fixes. Isolation: no real Codex, Claude Code, iTerm2,
Ghostty or Terminal is run or scripted on this Mac; the unit specs use fakes in the suite's throwaway home and data
folder (`vitest.setup.ts`); the e2e files and both eval tiers run their own isolated daemons, homes, data folders,
ports (never 18473), private tmux and herdr, fake apps and `FakeBackend` (test accounts only). No production backend.
One eval or e2e run at a time on this Mac, each only on the PM's turn; no `test:core` or `local-checks.py` while one runs.

1. **Unit, typecheck and coverage, on this Mac.** `npm run typecheck`; `npx vitest run` over every spec the tasks name;
   then, on the PM's slot, `npm run test:core` (required: `SV/` changed; PR CI does not run it) and, from the repo root on
   a clean tree, `python3 scripts/local-checks.py --run` (it lists `cli-core` for these paths); its fence goes in the PR
   body before the push. Seen: all green, every `SV/` file at 100%.
2. **Harness Device on macOS, on this Mac** (PR CI compiles only its Linux and Windows code, never `tabs_macos.rs`):
   `cd device-app/ui && npm run build`, then `cd ../src-tauri && cargo test --locked`. Never
   `-- --ignored scratch_terminal_windows` (it drives the real Terminal). Seen: green. `scripts/e2e/macos.sh` is not
   required: it checks installs, starts, the tray and updates, which this change leaves alone, and the tab thread's new
   lines are covered by `runner.rs`'s fakes.
3. **CLI end to end, on this Mac, on the PM's turn:** `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialTerminalVoice.e2e.ts e2e/deviceCodex.e2e.ts e2e/dialTerminalFollow.e2e.ts`
   (the new flow; part A's queue under a linked profile; the tab follow, whose `ps` read changed). Fakes only. Seen:
   green. On GitHub, `linux-e2e` runs the first two on its own (the first skips there); `dialTerminalFollow` is macOS
   only and has no workflow.
4. **Both eval tiers, the tester on this Mac, one run, on the PM's turn:**
   `OUT=$(mktemp -d); DIAL_EVAL_OUT="$OUT" TMPDIR=/tmp caffeinate -i npm run eval:dial-apps -- --update-baseline`.
   It runs tier A's spec, then tier B's files (`dialAppEvalClaude`, `Chatgpt`, `Vscode`, `Cursor`, `Orca`, `Iterm`
   (macOS only) and the held-out file, which nobody opens, nor its scenarios or evidence). The gate, from
   `$OUT/report.md` and `report.json`:
   - `Gate: passed`, 0 wrong-session sends. One wrong send: stop and ask the PM before any baseline is kept;
   - no app's score below its `baseline.json` value on `main`. A lower score only from timed checks or `grade.ts`
     `RACED_B`'s keys is the runner's noise by the eval's rules; a pass/fail check that was 1 and is below 1 is a drop;
   - expected: tier A unchanged (no proof there), unless part A's real-path spelling now queues a Codex whose rollout
     the scan named by its real path (an improvement). Tier B on macOS runs the real `ps`/`lsof` and a watch no Harness
     Device answers: an agent in a plain fake-iTerm2 tab that neither the mod nor the queue takes now gets a voice letter
     and a write line that ends in `no-answer` after 3 s. Any such difference is reported to the PM with the run;
   - `git diff cli/src/testing/dialAppEval/baseline.json`: empty → nothing to commit; changed with the gate passed, no
     drop and the PM's go → an implementer commits it alone as `Dial eval: baseline after voice into terminal tabs`; any
     failed line above → `git checkout -- cli/src/testing/dialAppEval/baseline.json` and the failure is a finding.
   The tester reports the score table, the held-out count as printed, and that diff.
5. **Numbers for the PR (hot path rule 4), on this Mac:** a throwaway script in the scratchpad (not committed) times
   `trustedCodexHomes` with three own homes and four linked: 1,000 calls within the hold, and one call past it. Seen:
   the median and worst of each, in the PR. `canType` is a few comparisons per look; no number needed.
6. **PR CI, on its own, nothing started by hand:** `cli-typecheck`, `cli-tests` (four shards, tier A on Linux),
   `companions`, `pty-checks`, `dial-hosts` (`HO/` changed), `linux-e2e` (the dial app eval's six files, `deviceCodex`,
   `dialTerminalVoice`), `windows-e2e` on x64 (`cli/src/cable/`, `cli/src/devices/` changed: part A's queue specs there),
   `device-app-checks` and `device-app-e2e` (`linux.sh`, `windows.ps1`), `cross-read-scan`, `process-checks`. Seen: each
   green. A failed job is read, fixed and pushed once; `ci.yml`'s `workflow_dispatch` only as the rerun of a recorded
   flaky test.
7. **Held for Diego, before merge (needs Diego himself: his Mac, his own iTerm2 and Ghostty, his own Codex and Claude Code
   logins, his eye).** On his Mac, from this branch: the branch's CLI and daemon (`cd cli && npm ci && npm run build`, run
   as his dev daemon), and Harness Device's debug bundle (`cd device-app/ui && npm run build`,
   `cd ../src-tauri && cargo tauri build --debug`), the installed Harness Device quit first; macOS asks once to let
   Harness Device control iTerm2 and Ghostty: allow. Then the spec's steps:
   1. iTerm2: Codex, idle, in a plain tab. Speak at the dial. The words appear and **Enter submits them** as one turn.
   2. The same in Ghostty ≥ 1.3. Also note whether `input text` brings Ghostty forward.
   3. Claude Code without the mod in iTerm2: the same.
   4. iTerm2 with Broadcast Input on, over two panes: the words reach the one session only. If not, iTerm2 becomes ⛔
      (a finding for the PM).
   5. Negatives: Codex in tmux inside iTerm2 is not typed by `tabs`; Codex with `!sleep 30` running is refused; Claude
      Code with its Ctrl-G editor open is refused; Terminal.app with cursor-agent says "did not answer"; the agent quit,
      leaving a shell in its tab: nothing typed.
   He reports each step's result for the PR. No agent runs this check, reads his terminals or his logs.
8. **Production:** none.

## What the pull request says

- Platforms: part A on macOS, Linux and Windows (`codex queue` under every trusted home); part B on macOS only (iTerm2,
  Ghostty ≥ 1.3); Terminal.app and Linux Ghostty unchanged ("did not answer"); Windows has none of the three apps.
- Data: the spec's "What travels where" (nothing stored; the text in memory for one write, on this computer only).
- The eval: the two harness-only edits (Task 11's fake tabs stream; Tasks 5 and 10's world probes reading "not
  readable"), no scenario or check changed; the score table and `baseline.json`'s diff, or "unchanged".
- Receipts: `test:core` and `local-checks.py`'s fence; `cargo test --locked` on macOS; the three e2e files on macOS;
  check 5's numbers; Diego's held check, step by step.

## Proposals (not in this branch)

- A by-hand macOS workflow running the macOS-only dial e2e files (`dialTerminalFollow`, `dialTerminalVoice`,
  `dialAppEvalIterm`) and Harness Device's macOS `cargo test`, so later pull requests that touch tabs get them on GitHub.
- A stand-in Harness Device in tier B's driver that answers write lines, so the eval scores the tabs route (an eval
  change: the PM's decision).

## Decisions on the open questions (PM, 2026-11-25)

All three as recommended, already written into the tasks:

1. `atPrompt()` false at the probes or the recheck answers `{ notSent: 'busy' }`: log `refused (tabs · busy)`, dial
   "did not answer". No interface change.
2. Harness Device's `ok:false` counts `no-session`; no answer, a stream draining past 3 s or a line over 64 KiB counts
   `no-answer`; an ended stream `no-stream`. No reason in the `wrote` protocol.
3. Check 5: the agent's own pid must be among the processes whose stdin is the tty; an empty list, a failed or
   timed-out `lsof`, or an unreadable table fails `foreground-child`.
