# Harness Device: the agent tells the dial when it needs you — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code or Codex session that needs the person runs `harness device notify "<one line>"` and the dial rings with that line, pinned; and the Harness Device menu chooses whether an ordinary finished turn still beeps (Notifications: Full or Needs you).

**Architecture:**
- **The notice.** `harness device notify` cleans the line and posts it to the devices' own listener (`services/devicesListener.ts`), the door a tool on this computer already uses, so the core routes nothing and a computer with no dial starts no process. The devices process ties the call to an agent by the engine session id the caller's shell names, bounds it, and shows it as a question the dial only shows (`SHOWN_ONLY_PREFIX`), on a path of its own past `heldOnTab()`.
- **The setting.** One value in `dial-notify.json` in the daemon's data dir, read where `services/devices.ts` sends `cable.summary`: in Needs you an `alert` for an ordinary turn becomes `list`. The watch's line carries it out on the local `dial_status` frame; the watch's stdin carries a change in, to the same listener.
- **No approval prompt.** `harness device notify` joins the one allow-list (`HarnessAllowance`) as exactly three words. `harness device codex enable` writes the `dial` skill into the Codex home.
- **The app** mirrors Sound (#4360): a Notifications submenu drawn from the watch's line, a click written as fixed text on the watch's stdin, and Codex rows and a one-time offer that mirror Claude Code's.

**Tech Stack:** TypeScript CLI and daemon (Node, vitest, `cli/`); Rust and Tauri 2 (`device-app/src-tauri`); plain TypeScript window (`device-app/ui`).

**Spec:** [docs/plans/2026-11-16-dial-agent-notify-design.md](2026-11-16-dial-agent-notify-design.md). Mirrors [Sound's spec](2026-11-16-device-app-sound-design.md) and [plan](2026-11-16-device-app-sound-plan.md) (commit `7a790f8eca`).

## Base

- Branch `feat/dial-agent-notify`, from `main` at `5840f0786f`. This branch is pull request 1 of the spec's Release order: nothing under `plugins/` changes.
- Before the first task: `cd cli && npm ci` and `cd device-app/ui && npm ci && npm run build` (this worktree has neither `node_modules` nor `ui/dist`; the app's binary embeds `ui/dist`).
- Tauri's dependencies take minutes to compile: one `CARGO_TARGET_DIR` outside the repository compiles them once (`device-app/AGENTS.md`).
- Tasks name code by name, never by line. If a name below is gone, stop and report.
- Never touched by a task or a test: the person's daemon (port 18473), `~/.harness`, its LaunchAgent, `Harness.app`, `~/.claude`, `~/.codex`, and the dial on `/dev/cu.usbmodem*`. A tester touches them only in checks 5 and 6, by the procedure in Verification, "The live daemon, for checks 5 and 6", and puts them back as they were.

## Words

- **notice**: the one line an agent sends with `harness device notify`.
- **mode**: the Notifications setting, `full` or `you`.
- Listener messages (`POST /` on the devices' socket): `{"type":"notice","text",…}` answered `{"result":…}`; `{"type":"notify","mode"}` answered `{"mode":…}` or `{"error":…}`.

## Layers

| Files | Layer and process | Gate |
|---|---|---|
| `cli/src/lib/dialNotice.ts`, `lib/notifyTier.ts`, `cable/notifyMode.ts`, `cable/notices.ts`, `cable/cableHost.ts` | The devices process (pure parts; `dialNotice.ts` also in the `harness` command) | their specs (PR CI `cli-tests`) |
| `cli/src/services/devicesListener.ts`, `services/devices.ts` | The devices process | their specs; `npm run test:core`, 100% per file (local gate) |
| `cli/src/engines/facets/hooks.ts`, `engines/kit/hookSettings.ts`, `engines/{claude,codex}/hookContract.ts` | Declared data the core applies at each daemon start | `hookSettings.spec.ts`, `removeHooks.spec.ts` |
| `cli/src/devices/{client,listenerClient,notice,codexSkill}.ts`, `deviceClaude/command.ts`, `cli.ts` | The `harness` command's own process | their specs; `cli/e2e` |
| `device-app/src-tauri/src/*.rs`, `device-app/ui/src/*` | Harness Device, a process of its own | `cargo test --locked` (PR CI on Linux, macOS by hand); the window's vitest |

Nothing under `cli/src/core/` changes and `cli/src/architecture.coreFiles.txt` gains no line. The four allow-list files are on that list already: they change as data, by one rule.

## Global Constraints

- **The line.** One line, at most 120 characters after trimming; control characters and line breaks out; longer is cut with `…`. It is data: drawn as text, never interpreted.
- **Answers** of `harness device notify`, exit 0 for each: `shown`, `no dial`, `limited`.
- **Limits.** Per agent: one notice a minute; the same text again within 10 minutes is refused. Per computer: 20 notices an hour. A notice for an agent with a pending card replaces that card.
- **What rings.** A notice, a question, a permission ask and a failed turn ring in both modes. In Needs you only an `alert` for an ordinary finished turn (`rule:turn`, here or decided upstream) becomes `list`, logged `rule:needs-you`. Default **Full**.
- **The allow rule** covers exactly `harness device notify`: Claude Code `Bash(harness device notify:*)` and the launcher's full-path spelling; Codex `prefix_rule(pattern=["harness", "device", "notify"], decision="allow")`. Never the whole `device` word. A person's deny or ask rule keeps it out.
- **Local.** The mode and the notice stay on this computer: not in `harness_devices_changed`, not in `harness_devices_list`, not a dial setting.
- **Logs.** `[device] notify · <engine> · shown|no dial|limited`. Never the line, a session id, a folder or a path.
- **The watch.** Out: `"notify":"full"|"you"` on the status line. In: exactly `{"notify":"full"}` or `{"notify":"you"}` on stdin; one change in flight, the latest waits, 12 s bound, one stderr line a failure.
- **Copy** (`docs/naming-system.md`): `Notifications`, `Full`, `Needs you`; `Codex: On`, `Codex: Off`, `Turn off`, `Turn on…`; the offer `Let Codex reach your dial?` / `Codex can ring the dial when it needs you: a VPN, a sign-in, a decision.` / `Not now`, `Turn on`.
- **`device-app/AGENTS.md`:** thin over the CLI; fixed arguments and fixed stdin lines built in Rust; one log, redacted; no other component's path in a Rust string.
- **Repo rules.** A test that fails first. No fixed sleeps. Comments say why. Tests use throwaway homes and data folders.
- **Platforms.** The command, the allow rule and the skill: macOS and Linux. Windows, and Harness OS (services inside the core): the devices have no listener there, so the command answers `no dial` (a known gap the spec names); the allowance is not installed on Windows today. Harness Device: macOS, and Linux in CI.

## Review Focus

1. **The skill's front matter.** The description holds `: `, which ends a plain YAML scalar: written unquoted, Codex never loads the skill and nothing says so. Task 14 (`the skill's front matter is YAML a loader reads`).
2. **A line with letters the round dial cannot draw** (an emoji, Chinese). The firmware refuses a whole question over one such letter (`cable/roundGlyphs.ts`): the card must still show, each such letter as `?`. Task 8 (`letters the round dial cannot draw become ?`).
3. **A `state.json` the released app wrote** (no `askedCodex`). It must keep the answers it holds: read as unreadable, the app offers sign-in and Claude Code again. Task 19 (`a_state_file_from_before_codex_keeps_its_answers`).
4. **An agent that pastes a command's output as the line** (100 KB, many lines, unquoted, starting with a dash). One line of 120 characters is sent, exit 0, never an error. Task 13 (`a long, many-line or unquoted text is one line`).
5. **A person's own skill named `dial`, or an edited copy.** `enable` never writes over it and `disable` never deletes it. Task 14 (`a skill Harness did not write is left alone`).

Also pinned, beside the five: a newer CLI's unknown `notify` value leaves the line a status (Task 16); a pending card is asked again when a dial attaches (Tasks 8 and 10); a mode that cannot be saved leaves the check where it was (Tasks 3, 9, 12).

## Decided (Ken and the orchestrator, 2026-11-16)

Not reopened: the agent itself decides and sends the notice, with no model and no watcher; Claude Code and Codex; failed turns, questions, permission asks and notices ring in both modes; only `rule:turn` alerts drop to `list` in Needs you; the setting lives in Harness Device, stored per computer in the daemon's data dir; default Full; every "my call" in the spec.

Answered by the orchestrator on the draft (2026-11-16), now in the spec too: the door (decision 1), what closes the card (decision 4), the card's words (decision 3), the submenu's conditions (Task 16), the compound command tried by hand (Task 4, Verification check 5), and the Codex skill's place, checked against Codex 0.167.1 (decision 12, Task 14).

## Decided here, where the spec left it to the builder

1. **The door.** The notice and the mode both go to the devices' own listener, as `cli/src/services/AGENTS.md` says of what a tool on this computer tells the devices alone. No name is added to `DEVICES_REQUESTS` or anywhere in `cli/src/core/api.ts`: no feature goes into the core, and a request routed by the core would start the devices' process on a computer with no dial. Where that listener does not run (Windows, and a daemon that runs its services inside the core, as on Harness OS), the command answers `no dial`: a known gap the spec names.
2. **Whose notice.** The command reads its own environment only: Claude Code's `CLAUDE_CODE_SESSION_ID` (with `CLAUDECODE=1`), else Codex's `CODEX_THREAD_ID` (the spec's "CODEX_THREAD"), and the name of the folder it runs in. The devices tie it, in this order: a Harness agent whose bound engine session it is (the Harness agent id, the one `harness whoami` names; by session, as a `%N` of the person's own tmux can equal one of Harness's); an outside agent any source lists with that engine and session (observed or herdr); else a card under the folder's name, or `An agent`, on `observedAgentId(engine, sessionId)`.
3. **The card.** A shown-only question: id `shown:<uuid>`, `questions: [{ key: 'notice', q: <the line>, options: ['In <app>'] }]`, the app named by `hostDisplayName`. The ` · answer in <app>` a waiting prompt's line ends with is left off: `askedLine` would cut the agent's line to 99 bytes.
4. **The card goes** when that agent's next turn starts (an observed session's `turn-start` hook, a Harness agent's `turn_started` frame, a herdr-only agent going from not busy to busy), when the person taps "In <app>" to open the agent in its app (`agent.open` with no reason), or when its agent leaves the list. Opening the alert to read it (`question.read`) does not close it. At most 20 are pending; the oldest goes for a twenty-first.
5. **`no dial` and `limited` use none of the budget**: only a shown notice is counted.
6. **The file** is `dial-notify.json` in the daemon's data dir: `{"mode":"you"}`. Missing, unreadable or anything else reads as `full`.
7. **The fleet path** needs no change on the other machine: its card reaches this computer's `dispatch` with the tier that machine decided, and is lowered here as an upstream tier is.
8. **An upstream `alert` is an ordinary turn** unless the card says `failed`: the recaps ask the rules with `failed`, `subagent` and `onScreen` all false (`services/recaps.ts`).
9. **The watch line** says `notify` only while `attached` is true, so `{"attached":false}` stays the line it is.
10. **The app reads `notify` leniently**: an unknown value is no mode, and the line is still a status. A line that is no status looks like a silent watch to the keep-alive.
11. **No new action name.** The Codex screen reuses `turn_on`, `not_now` and `retry`: the reducer keys on the screen shown. `device-app/AGENTS.md`'s "one of six action names" and `the_window_may_ask_six_things` stay as they are. (The brief expected new actions; none is needed.)
12. **`harness device codex status --json`** is `{ supported, installed, enabled }`: `supported` macOS or Linux; `installed` Codex is on this computer (`installedEngineBin('codex')`), as the spec's "when Codex is on this computer"; `enabled` the skill Harness wrote is in the Codex home. The Codex home is Harness's own setting (`env.CODEX_HOME`, `~/.codex` by default), as the device-codex spec chose. The path is `$CODEX_HOME/skills/dial/SKILL.md`, checked against Codex 0.167.1, the version on this Mac (Verification check 5). (Claude Code's `installed` is its plugin's, not the engine's: `deviceClaude/plugin.ts`. That difference is reported to the orchestrator and is not this plan's to change.)
13. **The skill is Harness's when its file is exactly the text this release writes.** A later release that changes the text lists the earlier ones. The skill's body is the spec's five points, as Task 14 words them; pull request 2 copies that text for Claude Code.
14. **Codex's working and failed screens** read `Codex`, as Claude Code's read `Claude Code`; a change that fails and says nothing reads `Could not change Codex.`

## Open questions

One, about checks 5 and 6: Verification, "Open question".

## Design check (docs/feature-design-rules.md)

1. **Growth.** One file of one value, written over. In memory: at most 20 pending cards and 20 counted notices, gone with the devices' process.
2. **Concurrency.** One writer, the devices' process; a write is a temp file and a rename. The watch holds one change in flight.
3. **Read cost.** The file is read once as the devices start (1 KiB at most). A status frame grows by one key.
4. **Scale.** 20 notices an hour; the listener takes one `notice` a second on a connection.
5. **Compatibility.** An older app ignores `notify` on the line; an older CLI prints none, so no submenu; an older daemon's listener answers 404, so a click is `notify: NO_ANSWER` and `harness device notify` is `no dial`. Readers of `dial_status` (Desktop and the phone's `dial_status.dart`, the watch) read named keys.
6. **Migration and rollback.** None. A rolled-back daemon ignores the file and beeps as before.
7. **Audience.** The listener's socket is this account's alone (0600). The line is in no log and no stored record.
8. **Identity.** The command runs as the agent's own OS user and uses no login.
9. **Failure.** No dial: `no dial`. Over a limit: `limited` and a log line. A mode not saved: `notify: WRITE_FAILED` in the app's log, the check stays. No answer in 12 s: `notify: NO_ANSWER`.
10. **Platforms.** Global Constraints.

Known gaps, as the spec names them or as they follow from decision 1: an agent on another of the person's machines rings only a dial on its own machine; Claude Code learns the skill in pull request 2; a devices' process that restarts forgets its pending cards and its counts; Windows and a daemon that runs its services inside the core (Harness OS) answer `no dial`.

## Tasks at a glance

| # | Task | Depends on | Effort |
|---|---|---|---|
| 1 | The line and the limits (`lib/dialNotice.ts`) | none | high |
| 2 | Needs you in the tier rules (`lib/notifyTier.ts`) | none | medium |
| 3 | The stored mode (`cable/notifyMode.ts`) | none | high |
| 4 | The allow-list rule | none | xhigh |
| 5 | The cable host's two hooks (`cable/cableHost.ts`) | none | medium |
| 6 | `askDevices` (`devices/listenerClient.ts`) | none | medium |
| 7 | The listener's `notice` and `notify` | 1, 3 | high |
| 8 | The notice desk (`cable/notices.ts`) | 1 | high |
| 9 | The devices: the mode | 2, 3, 7 | high |
| 10 | The devices: notices | 5, 7, 8, 9 | xhigh |
| 11 | The watch's line says `notify` | 3 | medium |
| 12 | A `notify` line on the watch's stdin | 6, 9, 11 | xhigh |
| 13 | `harness device notify` | 1, 6, 10, 14 | high |
| 14 | `harness device codex` | none | xhigh |
| 15 | App: `Effect::SetNotify` and `Watch::notify` | none | high |
| 16 | App: the Notifications submenu and its click | 15 | high |
| 17 | App: a `notify:` line of the watch reaches the log | none | xhigh |
| 18 | App: Codex's status and switch (`codex.rs`) | 16 | medium |
| 19 | App: the Codex rows and the offer | 18 | high |
| 20 | Window: the Codex screen | none | high |
| 21 | The docs | none | medium |

Longest chain: 3 → 7 → 9 → 10 → 13. A dependency on a task that shares a file is real too: 9 and 10 share `services/devices.ts`; 11 and 12 `devices/client.ts`; 14 and 13 `deviceClaude/command.ts` and `cli.ts`; 15, 16, 18 and 19 `types.rs`.

---

### Task 1: The line and the limits

**Layer:** pure; the devices process and the `harness` command. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/lib/dialNotice.spec.ts` (new).

**Files:**
- Create: `cli/src/lib/dialNotice.ts`, `cli/src/lib/dialNotice.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const NOTICE_MAX_CHARS = 120
  /** One line a dial can show: each run of control characters (\p{Cc}), U+2028 and U+2029 is one space, runs of
   *  white space are one space, trimmed; past 120 code points, the first 119 and `…`. */
  export function noticeLine(text: string): string
  export const NOTICE_FOLDER_MAX = 64
  /** A folder's name for a card: through noticeLine's cleaning, 64 code points at most, no `…`; '' when nothing is left. */
  export function noticeFolder(name: string): string
  export const NOTICE_SESSION = /^[A-Za-z0-9._-]{1,128}$/
  export interface NoticeAsk { text: string; engine?: 'claude' | 'codex'; sessionId?: string; folder?: string }
  export type NoticeResult = 'shown' | 'no dial' | 'limited'
  export const isNoticeResult: (value: unknown) => value is NoticeResult
  export const NOTICE_AGENT_MS = 60_000, NOTICE_SAME_MS = 600_000, NOTICE_HOUR_MS = 3_600_000, NOTICE_HOUR_MAX = 20
  export class NoticeLimits {
    constructor(now: () => number)              // monotonic ms
    /** True when [agent]'s [line] may ring now; it is then counted. A refusal counts nothing. */
    take(agent: string, line: string): boolean
  }
  ```
- `NoticeLimits` keeps one list of what it counted in the last hour, 20 entries at most: the three rules read it.

- [ ] **Step 1: Write the failing tests.**
  - `noticeLine is one trimmed line`: `'  Connect the VPN  '` → `'Connect the VPN'`; `'a\nb\r\n\tc'` → `'a b c'`; `'a\u0000b'` → `'a b'`; `'x y z'` → `'x y z'`; `' \n\t '` → `''`.
  - `noticeLine cuts past 120 characters, between characters`: 120 `a` unchanged; 121 `a` → 119 `a` and `…`; 200 `🙏` → 119 `🙏` and `…`, and `[...out].length` is 120.
  - `noticeFolder`: `'api'` → `'api'`; `'a\nb'` → `'a b'`; 100 `x` → 64 `x`; `'\u0007'` → `''`.
  - `isNoticeResult` takes the three words and nothing else (`'Shown'`, `''`, `1`).
  - `one notice a minute for an agent`: `take('a','x')` true; at 59 999 ms `take('a','y')` false; at 60 000 true.
  - `the same text again within ten minutes is refused`: `take('a','x')` at 0; at 61 000 `take('a','x')` false and `take('a','y')` true; at 600 000 `take('a','x')` true. Another agent's `take('b','x')` at 0 is true.
  - `twenty an hour for the computer`: twenty agents true; the twenty-first false; true once the first is 3 600 000 ms old.
  - `a refusal counts nothing`: `take('a','x')` at 0; `take('a','y')` at 30 000 false; `take('a','y')` at 60 000 true.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/dialNotice.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: an agent's notice is one line, and bounded`.

### Task 2: Needs you in the tier rules

**Layer:** pure; the devices process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/lib/notifyTier.spec.ts`.

**Files:**
- Modify: `cli/src/lib/notifyTier.ts`, `cli/src/lib/notifyTier.spec.ts`

**Interfaces:**
- Produces: `TierInput.needsYou?: boolean` (the dial's Notifications setting is Needs you). The decider's last rule: `input.needsYou ? rule('list', 'needs-you') : rule('alert', 'turn')`. Every rule before it is unchanged. The recaps pass none, so the phone and the windows are as before.

- [ ] **Step 1: Write the failing tests.**
  - `Needs you: an ordinary finished turn is a drawer row`: `needsYou: true` with a recap → `{ tier: 'list', by: 'rule:needs-you', detail: 'needs-you' }`, and the tally line `notify · <agent> · list · rule:needs-you · needs-you · 0ms`.
  - `Needs you lowers nothing else`: `failed: true` → `alert`, `rule:failed`; `subagent`, `onScreen` and an empty recap → `silent`, each by its own rule.
  - `needsYou` false or absent → `alert`, `rule:turn` (the existing cases pass unchanged).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/notifyTier.spec.ts`. Expected: FAIL (`alert` where `list` is expected).
- [ ] **Step 3: Implement.** The file's head comment says what Needs you does.
- [ ] **Step 4: Run** the same, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: Needs you makes an ordinary finished turn a drawer row`.

### Task 3: The stored mode

**Layer:** the devices process. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/cable/notifyMode.spec.ts` (new).

**Files:**
- Create: `cli/src/cable/notifyMode.ts`, `cli/src/cable/notifyMode.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NotifyMode = 'full' | 'you'
  export const isNotifyMode: (value: unknown) => value is NotifyMode
  export const NOTIFY_MODE_FILE = 'dial-notify.json'
  export class NotifyModeStore {
    constructor(file: string)       // read once, 1 KiB at most: {"mode":"you"}; anything else is 'full'
    get(): NotifyMode
    /** False when the file could not be written: the mode in force stays. The same mode again writes nothing. */
    set(mode: NotifyMode): boolean
  }
  ```
- The file is `{"mode":"<mode>"}` and a newline, mode 0600, written to a temp file beside it and renamed.

- [ ] **Step 1: Write the failing tests** (a throwaway folder each).
  - `full with no file`.
  - `a mode set is read by the next store`: `set('you')` true; the file is exactly `{"mode":"you"}\n`, mode 0600; `new NotifyModeStore(file).get()` is `'you'`; no temp file is left.
  - `the same mode again writes nothing`: the file's inode is unchanged.
  - `anything else reads as full`: `{not json`, `{"mode":"loud"}`, `["you"]`, a file of 2 KiB; a later `set('you')` writes it.
  - `a mode that cannot be written stays as it was`: the file's path is a folder → `set('you')` false, `get()` `'full'`.
  - `isNotifyMode` takes `'full'` and `'you'` only.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/notifyMode.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the Notifications setting is one value in the daemon's data folder`.

### Task 4: The allow-list rule

**Layer:** declared data the core applies. **Depends on:** none. **Effort:** `xhigh` (it widens what runs without a question).

**Red test:** `cli/src/engines/kit/hookSettings.spec.ts`.

**Files:**
- Modify: `cli/src/engines/facets/hooks.ts`, `cli/src/engines/kit/hookSettings.ts`, `cli/src/engines/claude/hookContract.ts`, `cli/src/engines/codex/hookContract.ts`
- Test: `cli/src/engines/kit/hookSettings.spec.ts`, `cli/src/engines/removeHooks.spec.ts`

**Interfaces:**
- Produces:
  - `facets/hooks.ts`: `export const HARNESS_AGENT_COMMANDS = [['device', 'notify']] as const`: commands of more than one word, each allowed as exactly its words, never its first word alone. `device` is not added to `HARNESS_AGENT_VERBS` or `HARNESS_SHELL_VERBS`. `HarnessAllowance`'s comment names `{command}` and `{words}`.
  - `kit/hookSettings.ts` `harnessRules`: a rule naming `{command}` (the words joined by a space) or `{words}` (each word a JSON string, joined by `, `) is made once for each of `HARNESS_AGENT_COMMANDS`. A command's rules of one kind are a group of their own, after the verbs' groups: a deny for it keeps out its two spellings and nothing else. `RULES_HEADER` names the commands after the verbs: `…, tell, browser, device notify)`.
  - `claude/hookContract.ts` rules gain `'Bash(harness {command}:*)'` and `'Bash({launcher} {command}:*)'`.
  - `codex/hookContract.ts` rules gain `'prefix_rule(pattern=["harness", {words}], decision="allow")'`, after the two there. No `{node} {cli}` spelling: the spec names one rule, and the skill names `harness`.

- [ ] **Step 1: Write the failing tests.** The spec's `claudeRules` gains the two rules last, and a `commands: false` skip; `codexRulesFile` gains the header's `, device notify` and the line `prefix_rule(pattern=["harness", "device", "notify"], decision="allow")\n` last.
  - `allows exactly harness device notify in Claude Code, by name and by the launcher's path`: after an install, the rules that hold `device` are exactly `['Bash(harness device notify:*)', 'Bash(<launcher> device notify:*)']`; no rule is `Bash(harness device:*)` or starts with `Bash(harness device claude`.
  - `a deny or an ask for harness device notify, or for all of harness device, keeps it out in both spellings and nothing else`: for `{ deny: ['Bash(harness device notify:*)'] }`, `{ ask: ['Bash(<launcher> device notify --json:*)'] }` and `{ deny: ['Bash(harness device:*)'] }`, the allow list is `claudeRules({ commands: false })`: `Bash(harness --help)` is still there.
  - `a deny for another device command leaves it`: `{ deny: ['Bash(harness device claude enable:*)'] }` → the allow list is `claudeRules()`.
  - `the rule is a prefix of three literal words in each engine`: the Claude Code rules end in `:*` and hold no other `*`, `;`, `&` or `$`; the Codex file holds no `prefix_rule` whose pattern is `["harness", "device"]` alone, and `"device"` is not in the verbs' list.
  - `harnessRules gives a command a group of its own`: the groups that hold `device` are `[['Bash(harness device notify:*)', 'Bash(<launcher> device notify:*)']]`; no rule holds `{command}`, `{words}` or `undefined`.
  - The existing Codex and Claude Code cases pass with the new `claudeRules` and `codexRulesFile`.
  - `removeHooks.spec.ts`, `takes Harness out of every engine's files and leaves everything else`: a settings file that holds the two notify rules loses them, and a person's `Bash(npm test:*)` stays.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/engines/kit/hookSettings.spec.ts src/engines/removeHooks.spec.ts`. Expected: FAIL (no notify rule is written).
- [ ] **Step 3: Implement.** The comment on `HARNESS_AGENT_COMMANDS` says why three words: `harness device claude enable` and the rest of `device` still ask.
- [ ] **Step 4: Run** the same, then `npx vitest run src/agentClient/mcp.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: harness device notify runs without a question, as exactly three words`.

### Task 5: The cable host's two hooks

**Layer:** the devices process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/cableHost.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts`, `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Produces, on `CableHostWiring`, both optional:
  - `tapped?: (agentId: string) => void`: a person's tap that opens an agent (`openAgent` with no reason), told as it is taken, before the open and whatever becomes of it. Never for a question screen that came up by itself.
  - `noticeFrom?: (agentId: string) => { name: string; engine: string; machine: string } | undefined`: who sent a notice no list holds. `describe` asks it last, after the outside agents and the fleet.

- [ ] **Step 1: Write the failing tests.**
  - `a tap is told before the open, a question screen is not`: the dial's "In <app>" tap is `openAgent` with no reason. `openAgent('a1')` calls `tapped('a1')` once, for an outside agent, a Harness agent and an id no list holds; `openAgent('a1', 'question')` calls none.
  - `an agent no list holds is described by its notice`: with `noticeFrom` answering `{ name: 'api', engine: 'codex', machine: 'Mac' }` for `'n1'`, `describe('n1')` is that; an agent a list holds is described as before and `noticeFrom` is not asked; with no wiring `describe('n1')` is `undefined`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: FAIL (`tapped` is never called).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the host tells a tap, and names who sent a notice`.

### Task 6: `askDevices`

**Layer:** the `harness` command. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/devices/listenerClient.spec.ts`.

**Files:**
- Modify: `cli/src/devices/listenerClient.ts`, `cli/src/devices/listenerClient.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ASK_ANSWER_MAX = 1024
  /** One message the listener answers with a JSON object: that object. Null, never a throw, for no listener, one not
   *  this account's own, any answer but a 200 whose body is a JSON object of at most ASK_ANSWER_MAX bytes, or none in time. */
  export async function askDevices(dataDir: string, message: { type: string } & Record<string, unknown>,
    options?: { platform?: NodeJS.Platform; fetch?: typeof fetch; timeoutMs?: number }): Promise<Record<string, unknown> | null>
  ```
  `timeoutMs` is 2000 unless given. The answer's body is always read or cancelled: an unread one holds one of the listener's 16 connections.

- [ ] **Step 1: Write the failing tests**, against the file's real listener on a throwaway socket, as `tellDevices`'s are.
  - `the answer's object on a 200`: `{"result":"shown"}` → `{ result: 'shown' }`.
  - `null for a 204, 400, 404, 413, 429 and 500`.
  - `null for a body that is not a JSON object, or is over 1024 bytes`: `[]`, `"x"`, `{not json`, an object of 2 KiB.
  - `null with no socket, a socket of another account, on Windows, and when the listener does not answer in time`; nothing is sent in the first three.
  - `more asks than the listener takes connections are all answered`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/listenerClient.spec.ts`. Expected: FAIL (no export `askDevices`).
- [ ] **Step 3: Implement.** The file's head comment names the third kind of message.
- [ ] **Step 4: Run** the same, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a tool reads the devices' answer to one message`.

### Task 7: The listener's `notice` and `notify`

**Layer:** the devices process. **Depends on:** Task 1 (`noticeLine`, `noticeFolder`, `NOTICE_SESSION`, the types), Task 3 (`isNotifyMode`). **Effort:** `high`.

**Red test:** `cli/src/services/devicesListener.spec.ts`.

**Files:**
- Modify: `cli/src/services/devicesListener.ts`, `cli/src/services/devicesListener.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const NOTICE_PER_SECOND = 1
  export const NOTICE_MAX_BYTES = 2048
  /** An agent's notice, from `harness device notify`: handed on as four typed fields, answered `{ result }`. It keeps
   *  nothing and logs nothing: the line is the agent's words. */
  export function noticeHandler(notify: (ask: NoticeAsk) => NoticeResult): ListenerHandler
  export const NOTIFY_PER_SECOND = 2
  export const NOTIFY_MAX_BYTES = 64
  /** The Notifications setting, from `harness hardware watch`: handed on, answered with what `set` answers. */
  export function notifyHandler(set: (mode: NotifyMode) => { mode: NotifyMode } | { error: string }): ListenerHandler
  ```
- `noticeHandler` refuses (`REFUSED`) unless: `text` is a non-empty string equal to `noticeLine(text)`; `engine` is absent, `'claude'` or `'codex'`; `sessionId` is absent, or passes `NOTICE_SESSION` with an `engine` beside it; `folder` is absent, or a non-empty string equal to `noticeFolder(folder)`. It hands on those four fields and nothing else of the message.
- `notifyHandler` refuses unless `mode` passes `isNotifyMode`.

- [ ] **Step 1: Write the failing tests** (the handlers alone, as `front`'s and `attach`'s are tested).
  - `notice hands on the four fields and answers the result`: `{ type: 'notice', text: 'Connect the VPN', engine: 'claude', sessionId: 's-1', folder: 'api', extra: 1 }` → `notify` is called with `{ text: 'Connect the VPN', engine: 'claude', sessionId: 's-1', folder: 'api' }`, and the answer is `{ result: 'shown' }`. With `text` alone → `{ text }`.
  - `notice refuses a line the command did not clean`: `''`, `'  x'`, `'a\nb'`, 121 `a`, `7`, no `text`.
  - `notice refuses a caller it cannot read`: `engine: 'gemini'`; a `sessionId` with no `engine`; `sessionId: 'a b'`; one of 129 characters; `folder: ''`, `'a\u0007'`, 65 `x`.
  - `the notice handler is its two limits and handle; the longest notice fits`: `maxBytes` 2048, `perSecond` 1; a message of 120 `🙏`, a 128-character session id and a folder of 64 `🙏` is under 2048 bytes.
  - `notify hands a mode on and answers what set answers`: `'you'` → `{ mode: 'you' }`; `set` answering `{ error: 'WRITE_FAILED' }` → that.
  - `notify refuses any other body`: `'loud'`, `true`, no `mode`.
  - `the notify handler is its two limits and handle`: `maxBytes` 64, `perSecond` 2; `{"type":"notify","mode":"full"}` fits.
  - Through a real listener: a `notice` is answered `200` with `{"result":"limited"}`, and a second in the same second on that connection is `429`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts`. Expected: FAIL (no export `noticeHandler`).
- [ ] **Step 3: Implement.** The file's head comment names the two messages.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts --coverage --coverage.include=src/services/devicesListener.ts --coverage.thresholds.lines=100 --coverage.thresholds.statements=100 --coverage.thresholds.functions=100 --coverage.thresholds.branches=100 --coverage.reporter=text && npm run typecheck`. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `Dial: the devices' listener takes a notice and the Notifications setting`.

### Task 8: The notice desk

**Layer:** the devices process. **Depends on:** Task 1. **Effort:** `high`.

**Red test:** `cli/src/cable/notices.spec.ts` (new).

**Files:**
- Create: `cli/src/cable/notices.ts`, `cli/src/cable/notices.spec.ts`

**Interfaces:**
- Consumes: `NoticeAsk`, `NoticeResult`, `NoticeLimits` (Task 1); `SHOWN_ONLY_PREFIX` (`cable/cableSession.ts`); `roundDrawable` (`cable/roundGlyphs.ts`); `hostDisplayName` (`cable/hosts/hostDetect.ts`).
- Produces:
  ```ts
  export interface NoticeCaller {
    agentId: string
    /** The host its app is named by; '' when nothing says. */
    host: string
    /** Only for a caller no list holds: what its card carries. */
    who?: { name: string; engine: string; machine: string }
  }
  export interface NoticesDeps {
    connected(): boolean
    resolve(ask: NoticeAsk): NoticeCaller
    /** A question to every dial, in its agent's order. */
    ask(agentId: string, id: string, questions: unknown): void
    close(agentId: string, id: string): void
    uuid(): string
    now(): number                    // monotonic ms
    log(line: string): void
  }
  export const NOTICES_PENDING_MAX = 20
  export class Notices {
    constructor(deps: NoticesDeps)
    notify(ask: NoticeAsk): NoticeResult
    /** Its agent's next turn started, the person opened it, or its agent left: its card goes. Nothing for an agent with none. */
    ended(agentId: string): void
    /** A dial attached: each pending card is asked again, under its id. */
    attached(): void
    /** Who a pending notice's caller is, when no list holds it. */
    from(agentId: string): { name: string; engine: string; machine: string } | undefined
  }
  ```
- `notify`, in this order:
  1. Not `connected()`: log, answer `no dial`. Nothing is resolved or counted.
  2. `resolve(ask)`; the limits refuse (`take(caller.agentId, ask.text)`): log, answer `limited`.
  3. A pending card of that agent is closed first. With 20 pending, the oldest is closed and dropped.
  4. `ask(agentId, 'shown:' + uuid(), [{ key: 'notice', q: roundDrawable(ask.text), options: ['In ' + hostDisplayName(caller.host)] }])`; log; answer `shown`.
- The log line is `[device] notify · ${ask.engine ?? 'agent'} · ${result}`.

- [ ] **Step 1: Write the failing tests** (the deps are plain fakes; the clock is moved by hand).
  - `a notice is one shown-only question: the line, and where to answer it`: `ask` is called once with `['a1', expect.stringMatching(/^shown:/), [{ key: 'notice', q: 'Connect the VPN so I can run the staging tests', options: ['In Orca'] }]]`; the answer is `shown`; the log is `['[device] notify · claude · shown']`.
  - `letters the round dial cannot draw become ?`: `'Kết nối VPN 🙏 接続'` → `q` is `'Kết nối VPN ? ??'`.
  - `no line of the log holds the text, a session id or a folder`, for `shown`, `limited` and `no dial`; with no engine the word is `agent`.
  - `with no dial nothing is asked, resolved or counted`: `no dial`; connected again, the same text is `shown`.
  - `over a limit nothing is asked and the pending card stays`: a second notice of the agent within the minute is `limited`; one `ask`, no `close`.
  - `a newer notice of the same agent takes the older card's place`: 61 s on, another text: `close('a1', <first id>)` comes before the second `ask`; `ended('a1')` then closes the second id only.
  - `ended closes a card once, and nothing for an agent with none`.
  - `a dial that attaches is asked each pending card again, under its id`: `attached()` asks the same ids and questions; an ended one is not asked.
  - `a caller no list holds is named while its card is pending`: `from(agentId)` is the `who` that `resolve` gave; `undefined` once ended, and for a caller with no `who`.
  - `the twenty-first pending card closes the oldest`: twenty agents, 61 minutes, one more → `close` of the first agent's id.
  - `a host nothing names reads Terminal`: `host: ''` → `options: ['In Terminal']`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/notices.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a notice is a card the dial pins, one for an agent`.

### Task 9: The devices: the mode

**Layer:** the devices process. **Depends on:** Task 2 (`needsYou`), Task 3 (`NotifyModeStore`), Task 7 (`notifyHandler`). **Effort:** `high`.

**Red test:** `cli/src/services/devices.spec.ts`, a new `describe('the Notifications setting (docs/plans/2026-11-16-dial-agent-notify-design.md)')`.

**Files:**
- Modify: `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `NotifyModeStore`, `NOTIFY_MODE_FILE`, `notifyHandler`, `TierInput.needsYou`.
- Produces, inside `startDevices`:
  - The store, at `join(core.dataDir, NOTIFY_MODE_FILE)`.
  - Every local `dial_status` frame carries the mode: `core.clients.sendLocal({ type: 'dial_status', payload: { ...status, notify: mode } })`. `core.clients.devicesChanged` is given the status without it, and the Devices tab's `status()` too.
  - The listener's handlers gain `notify: notifyHandler(…)`: it stores the mode; not saved → `{ error: 'WRITE_FAILED' }` and the log line `[device] notifications · not saved`; saved → the current status is sent again as a local `dial_status` with the new mode (no revision, no `devicesChanged`), the log line `[device] notifications · <mode>`, and `{ mode }`. A part that throws answers `{ error: 'FAILED' }`.
  - `dispatch`'s summary branch, in Needs you:
    - a card with a tier: `alert` and not `failed` → `list`, tallied `list · rule:needs-you · needs-you`; any other tier as today (`recaps · decided upstream`).
    - a card with none: `tierOf` is asked with `needsYou: true` (Task 2 lowers and tallies it). In Full it is asked with `needsYou: false`.
    - `onScreen`, a sub-agent, no dial, and the decider's own failure (`list`) are as today.
  - Nothing else is lowered: `turnError`, a question and a waiting prompt's card are as today.

- [ ] **Step 1: Write the failing tests.** `fakeListener` gains `notify(mode)`: the `notify` handler's answer.
  - `every dial status the windows and the watch hear says the mode, and the owner's other machines hear none`: the host's `dialStatus({ attached: true, id: 'usb-1' })` → `sendLocal` got `{ type: 'dial_status', payload: { attached: true, id: 'usb-1', notify: 'full' } }`; `devicesChanged` got `{ status: { attached: true, id: 'usb-1' }, revision: 1 }`; `harness_devices_list`'s status holds no `notify`.
  - `the listener's notify stores the mode, says the status again and answers it`: `notify('you')` → `{ mode: 'you' }`; `dial-notify.json` in the data folder is `{"mode":"you"}\n`; the last `sendLocal` is the current status with `notify: 'you'`; `devicesChanged` is not called again; the log holds `[device] notifications · you`. Devices started again on that folder say `notify: 'you'`.
  - `a mode that cannot be saved answers WRITE_FAILED and changes nothing` (the file's path is a folder): no `dial_status` is sent, and a summary still alerts.
  - `Needs you: a finished turn decided here is a drawer row` (`decideTier: null`): `calls('summary')` is `[['a1', 'The requested build is ready.', 'done', 'list', undefined, false]]`; the log holds `list · rule:needs-you · needs-you` and no `rule:turn` line.
  - `Needs you: a tier the recaps decided is lowered when it is an alert, and only then`: payload `tier: 'alert'` → `list`, tallied `rule:needs-you`; `'list'` → `list` and `'silent'` → `silent`, tallied `recaps`; `tier: 'alert', failed: true` → `alert`.
  - `Needs you: another machine's card is lowered here`: the fleet's `{ kind: 'summary', tier: 'alert' }` → `list`; one without a tier → `list`; `tier: 'silent'` → `silent`.
  - `Needs you: an agent outside a pane ends as a drawer row`: an observed session's `turn-stop` and its answer → `summary` with `list`.
  - `Needs you: a failed turn, a question and a waiting prompt ring as in Full`: a summary with `failed: true` and no tier → `alert`; `kind: 'error'` → `turnError`; a `commander_question` → `question`; an `asked` prompt → `question`.
  - `the decider is told the mode`: a `decideTier` spy is called with `expect.objectContaining({ needsYou: false })`, and `true` after `notify('you')`.
  - `a notify the dial's part cannot take answers FAILED` (`faults: ['dial']`).
  - `the devices open their listener once, with …`: the keys are `['front', 'attach', 'tab', 'tabs', 'dial', 'notify']`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t Notifications`. Expected: FAIL (no `notify` handler; a `dial_status` without `notify`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/services/devices.spec.ts src/services/devicesProcess.spec.ts --coverage --coverage.include=src/services/devices.ts --coverage.thresholds.lines=100 --coverage.thresholds.statements=100 --coverage.thresholds.functions=100 --coverage.thresholds.branches=100 --coverage.reporter=text && npm run typecheck`. Expected: PASS, 100%; the existing tier cases pass unchanged.
- [ ] **Step 5: Commit** `Dial: Notifications, Full or Needs you, kept by the devices and said with the dial's status`.

### Task 10: The devices: notices

**Layer:** the devices process. **Depends on:** Task 5 (`tapped`, `noticeFrom`), Task 7 (`noticeHandler`), Task 8 (`Notices`), Task 9 (the same files). **Effort:** `xhigh` (each agent's cards stay in order; a card's whole life).

**Red test:** `cli/src/services/devices.spec.ts`, a new `describe('an agent\'s notice (docs/plans/2026-11-16-dial-agent-notify-design.md)')`.

**Files:**
- Modify: `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `Notices`, `NoticeCaller`, `noticeHandler`, the wiring's `tapped` and `noticeFrom`.
- Produces, inside `startDevices`:
  - `const notices = new Notices({ connected: () => cable.isConnected, resolve, ask, close, uuid: randomUUID, now: monotonic, log })`. `ask` and `close` go through `inOrder(agentId, …)` to `cable.question` and `cable.questionClose`, never through `tell` or `showWaits`: a notice passes `heldOnTab()`, and `showWaits` closes only what `shown` holds.
  - `resolve`, read from what the devices hold, with no wait (the listener gives a connection 2 s):
    1. `engine` and `sessionId`, and a session of `core.agents.advertised()` with that engine and session → `{ agentId: <its agentId>, host: 'harness' }`.
    2. else an entry of `outsideEntries()` with that engine and session → `{ agentId: entry.agent.id, host: entry.agent.host }`.
    3. else, with both → `{ agentId: observedAgentId(engine, sessionId), host: '', who: { name: folder ?? 'An agent', engine, machine: core.machine.name() } }`.
    4. else → `{ agentId: observedAgentId('notify', folder ?? ''), host: '', who: { name: folder ?? 'An agent', engine: '', machine: core.machine.name() } }`.
  - The listener's handlers gain `notice: noticeHandler(…)`: `notices.notify` inside `part.call('notices', …)`; a part that throws answers `no dial`.
  - The cable host's wiring gains `noticeFrom: (agentId) => notices.from(agentId)` and `tapped: (agentId) => part.call('notices', () => notices.ended(agentId))`.
  - `notices.ended(agentId)` is also called: in `port.observed` for an event `turn-start`, with `observedAgentId(event.engine, event.sessionId)`, before the return for a switched-off observed source; in `toCable` for a `turn_started` frame and for `agent_deleted`; in `outsideTurn` for an entry of a source other than `observed` that was not busy and now is, and for each id that left the list.
  - `dialAttached(true)` calls `notices.attached()`.

- [ ] **Step 1: Write the failing tests.** `fakeListener` gains `notice(ask)`: the `notice` handler's answer. `LINE` is `'Connect the VPN so I can run the staging tests'`.
  - `an outside session's notice is a question on its own agent, answered in its app`: after `port.observed(hook('turn-start'))` (the describe's own `hook`, session `sess-1`, in Orca), `notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })` → `{ result: 'shown' }`; `calls('question')` is `[[observedAgentId('claude', 'sess-1'), expect.stringMatching(/^shown:/), [{ key: 'notice', q: LINE, options: ['In Orca'] }]]]`.
  - `a Harness agent's notice is tied to the agent, by the session the core bound to it`: `advertised` answers `[{ agentId: 'h1', sessionId: 's-h1', engine: 'claude' }]` → the question is on `'h1'`, `options: ['In Harness']`; a `codex` caller with that session id is not that agent.
  - `an agent herdr alone lists is tied by its session`: the question is on herdr's id for it.
  - `a caller no list holds still rings, under its folder or An agent`: `{ text: LINE, engine: 'codex', sessionId: 't-9', folder: 'api' }` → the question is on `observedAgentId('codex', 't-9')`, `options: ['In Terminal']`, and the host's wiring `noticeFrom` answers `{ name: 'api', engine: 'codex', machine: <the core's machine name> }` for it; with no folder, `An agent`; with `text` alone, the id is `observedAgentId('notify', '')`.
  - `it rings with a window open on its tab`: after `port.swarms({ active: 't1', swarms: [], tiles: [] })`, an outside agent's turn is still held (`calls('turnStarted')` is `[]`) and its notice is `shown`, with one `question`.
  - `its card goes when that agent's next turn starts`: an observed session's next `turn-start` → `questionClose` with the card's id; a Harness agent's `commander_event` `turn_started` → the same. A `needs-input`, an `asked` prompt opening and closing, a `processing` card and a summary close nothing.
  - `its card goes when the person taps "In <app>" on the dial`: the wiring's `tapped(id)` → `questionClose`.
  - `its card goes with its agent`: `agent_deleted` for `'h1'`; an observed session dropped from the list.
  - `a card for a session the observed source is switched off for still goes at its next turn` (`HARNESS_DEVICE_OBSERVED` off): `port.observed(hook('turn-start'))` closes it.
  - `a dial that attaches is asked the pending notices again`: the host's `watching(true)` → the same id and questions again.
  - `with no dial it answers no dial and asks nothing` (the fake cable not connected).
  - `the limits hold across callers of one agent`: the same session twice in a minute → `limited`, one `question`.
  - `a notices part that throws answers no dial` (`faults: ['notices']`).
  - `the devices open their listener once, with …`: the keys end `'notify', 'notice'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t notice`. Expected: FAIL (no `notice` handler).
- [ ] **Step 3: Implement.** The section's comment says why a notice has its own path past `heldOnTab()` (the spec's "Which agents it covers").
- [ ] **Step 4: Run** Task 9's step 4 command. Expected: PASS, 100%.
- [ ] **Step 5: Commit** `Dial: an agent's notice rings the dial, with or without a window`.

### Task 11: The watch's line says `notify`

**Layer:** the CLI's watch. **Depends on:** Task 3 (`isNotifyMode`). **Effort:** `medium`.

**Red test:** `cli/src/devices/client.spec.ts`, in `describe('harness hardware watch')`.

**Files:**
- Modify: `cli/src/devices/client.ts`, `cli/src/devices/client.spec.ts`

**Interfaces:**
- Produces: `dialWatchLine(payload: unknown): string`, same signature. The line gains `"notify":"full"|"you"` as its last key when `payload.attached === true` and `payload.notify` passes `isNotifyMode`. The dedupe on the whole line stays, so a change of mode prints a line.

- [ ] **Step 1: Write the failing tests.**
  - `an attached dial's line says the mode last`: `{ attached: true, id: 'usb-1', fw: '0.0.95', settings: { muted: false }, notify: 'you' }` prints `{"attached":true,"fw":"0.0.95","muted":false,"notify":"you"}`.
  - `a change of mode alone prints again`: the same with `notify: 'full'` prints `{"attached":true,"fw":"0.0.95","muted":false,"notify":"full"}`; the same again prints nothing.
  - `any other notify, or no dial, leaves the line as before`: `notify: 'loud'`, `7`, `null` and none print `{"attached":true,"fw":"0.0.95","muted":false}` once in total; `{ attached: false, notify: 'you' }` prints `{"attached":false}`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts -t mode`. Expected: FAIL (the line has no `notify`).
- [ ] **Step 3: Implement.** The comment above `dialWatchLine` names the second setting it prints, and where it comes from.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/devices/client.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: the watch's line says the Notifications setting`.

### Task 12: A `notify` line on the watch's stdin

**Layer:** the CLI's watch. **Depends on:** Task 6 (`askDevices`), Task 9 (the daemon's side, for the end-to-end case), Task 11 (the same file). **Effort:** `xhigh`.

**Red test:** `cli/src/devices/client.spec.ts`, a new `describe('harness hardware watch: Notifications')`; `cli/e2e/hardwareWatch.e2e.ts`, a new `describe`.

**Files:**
- Modify: `cli/src/devices/client.ts`
- Test: `cli/src/devices/client.spec.ts`, `cli/e2e/hardwareWatch.e2e.ts`

**Interfaces:**
- Consumes: `askDevices` (Task 6); the listener's `notify` (Tasks 7 and 9).
- Produces:
  - `DialWatchDeps.notifyMode?: (mode: NotifyMode) => Promise<Record<string, unknown> | null>`: hands the mode to the devices' listener and gives its answer. By default `askDevices(dataDir, { type: 'notify', mode }, { timeoutMs: NOTIFY_ANSWER_MS })`.
  - `const NOTIFY_ANSWER_MS = 12_000`. `SOUND_CODE` is the shape of both stderr codes.
  - A stdin line is a Notifications line when it parses to an object with the one key `notify` whose value passes `isNotifyMode`. It is read after the Sound line and before `front` and `tab`.

    | When | stderr line | Sent |
    |---|---|---|
    | The line is read before `connected` | `notify: NOT_CONNECTED` | nothing; the line is dropped |
    | The last status did not say `attached: true` | `notify: NO_DIAL` | nothing; the line is dropped |
    | The answer is `{ mode }`, the mode sent | none | the waiting mode, if any |
    | The answer has an `error` of the code's shape | `notify: <error>` | the waiting mode, if any |
    | No answer (`null`: no listener, not taken, 12 s) | `notify: NO_ANSWER` | the waiting mode, if any |
    | Any other answer | `notify: FAILED` | the waiting mode, if any |
  - One change in flight; a line read meanwhile replaces the one waiting. Once the watch has ended, an answer prints nothing and sends nothing.
  - Nothing of it goes on the core's socket, and no answer prints on stdout: the line moves with the next `dial_status`.
  - The comment on `DialWatchDeps.stdin` names the fourth line.

- [ ] **Step 1: Write the failing unit tests.** `attached()` as the Sound block's; the watch is given a `notifyMode` spy whose answers the test resolves; `mode(run, value)` emits `JSON.stringify({ notify: value }) + '\n'` on stdin.
  - `a notify line hands the mode to the devices' listener`: `mode(run, 'you')` → one call, with `'you'`; answered `{ mode: 'you' }`: `run.errors` is `[]` and `run.printed` is unchanged.
  - `lines that are not exactly one mode send nothing`: `{"notify":"loud"}`, `{"notify":true}`, `{"notify":"you","muted":true}`, `{"mode":"you"}`, `["you"]`, `{"notify":"you"`: no call, no error; the next good line sends one.
  - `while one is in flight the latest waits`: `you`, `full`, `you`, `full` → one call; answered → a second, with `'full'`; answered → still two.
  - `a refusal is one stderr line with its code`: `{ error: 'WRITE_FAILED' }` → `['notify: WRITE_FAILED']`.
  - `an answer that names no code prints FAILED`: `{ error: '/Users/person no\nnotify: OK' }`, `{ error: 'x'.repeat(200) }`, `{}`, and `{ mode: 'full' }` for a `'you'` sent, each in a watch of its own → `['notify: FAILED']`.
  - `no answer prints NO_ANSWER and sends what waited`: the spy resolves `null`.
  - `before the daemon has answered, or with no dial, nothing is sent`: a line before `connected` → `['notify: NOT_CONNECTED']`; after `{ attached: false }` → `notify: NO_DIAL` is added.
  - `stdin closing with a change in flight exits 0`: `run.done` is `0`; the late answer adds no line and no call.
  - `nothing of the setting goes on the core's socket`: `coreFrames(run)` is `['machine_select']`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts -t Notifications`. Expected: FAIL (the spy is never called).
- [ ] **Step 3: Write the failing end-to-end case** in `hardwareWatch.e2e.ts`: `describe('harness hardware watch with a dial: Notifications')`, the daemon and desk made as the Sound block's `fresh`, an agent outside a pane as `deviceWithoutApp.e2e.ts` starts one (`Outside.start`). One test, `the menu's mode is kept by the daemon, and a finished turn follows it`:
  1. Plug `E2E-A`, start the watch, wait until its last line's `notify` is `'full'`.
  2. Write `{"notify":"you"}\n`. Wait for a line whose `notify` is `'you'`. `dial-notify.json` in `d.dataDir` is `{"mode":"you"}\n`.
  3. The outside agent takes a prompt and ends its turn: the dial hears its `summary` with `tier: 'list'` and `quiet: true`.
  4. `d.restart()`, a new watch: its line says `notify` `'you'`.
  5. Write `{"notify":"full"}\n`, wait for `'full'`; the agent's next turn ends: its `summary` has `tier: 'alert'`.
  6. Unplug: the last line is `{"attached":false}`. `{"notify":"you"}\n` then adds `notify: NO_DIAL` to the watch's stderr, and the lines of stderr that start `notify: ` are `['notify: NO_DIAL']`.

  Each wait is on a line's value, never on a count of lines: the fake dial greets again every 15 s.
- [ ] **Step 4: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/hardwareWatch.e2e.ts`. Expected: the new case FAILS at step 2; the others pass.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run** steps 2 and 4's commands, then `cd cli && npx vitest run src/devices/client.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS; the Sound block passes unchanged.
- [ ] **Step 7: Commit** `Harness Device: a Notifications line on the watch's stdin changes the setting`.

### Task 13: `harness device notify`

**Layer:** the `harness` command. **Depends on:** Task 1, Task 6, Task 10 (the daemon's side, for the end-to-end file), Task 14 (the same `command.ts` and `cli.ts`). **Effort:** `high`.

**Red test:** `cli/src/devices/notice.spec.ts` (new); `cli/src/deviceClaude/command.spec.ts`; `cli/e2e/deviceNotify.e2e.ts` (new).

**Files:**
- Create: `cli/src/devices/notice.ts`, `cli/src/devices/notice.spec.ts`, `cli/e2e/deviceNotify.e2e.ts`
- Modify: `cli/src/deviceClaude/command.ts`, `cli/src/deviceClaude/command.spec.ts`, `cli/src/cli.ts`

**Interfaces:**
- Consumes: `noticeLine`, `noticeFolder`, `NOTICE_SESSION`, `NoticeAsk`, `isNoticeResult` (Task 1); `askDevices` (Task 6).
- Produces:
  ```ts
  // cli/src/devices/notice.ts
  export interface NoticeDeps {
    dataDir: string
    env: NodeJS.ProcessEnv
    cwd: string
    out(line: string): void
    err(line: string): void
    /** `askDevices` by default. */
    ask?: (message: { type: 'notice' } & NoticeAsk) => Promise<Record<string, unknown> | null>
  }
  /** Who calls, from this process's own environment and folder: nothing else of either leaves it. */
  export function noticeCaller(env: NodeJS.ProcessEnv, cwd: string): Pick<NoticeAsk, 'engine' | 'sessionId' | 'folder'>
  /** [words]: what follows `notify`. 0 with `shown`, `no dial` or `limited` on stdout; 1 with the usage when there is no text. */
  export async function runNotice(words: string[], deps: NoticeDeps): Promise<number>
  ```
  - The text is every word but `--json`, joined by one space, through `noticeLine`. `--json` prints `{"result":"<word>"}`.
  - `noticeCaller`: `claude` when `CLAUDECODE` is `'1'` and `CLAUDE_CODE_SESSION_ID` passes `NOTICE_SESSION`; else `codex` when `CODEX_THREAD_ID` does; `folder` is `noticeFolder(basename(cwd))`, left out when empty.
  - An answer that is not `{ result }` with one of the three words is `no dial`.
  - `runDeviceCommand` hands `notify` on before it drops the words that start with `-`: `argv[0] === 'notify'` → `runNotice(argv.slice(1), …)`. `DeviceDeps` gains `env` and `cwd`; `cli.ts` passes `process.env` and `process.cwd()`. `DEVICE_USAGE` gains `  harness device notify "<one line>" [--json]  for an agent: ring the dial when it needs the person to act`. `harness --help` does not name it: an agent learns it from the skill.

- [ ] **Step 1: Write the failing unit tests** (`ask` is a spy).
  - `the answer is printed, and the exit is 0`: `{ result: 'shown' }`, `'limited'` and `'no dial'` print that word; `null`, `{}` and `{ result: 'rm -rf' }` print `no dial`; with `--json`, `{"result":"limited"}`.
  - `a long, many-line or unquoted text is one line`: `['Connect', 'the', 'VPN']` sends `text: 'Connect the VPN'`; one word of 100 000 characters with line breaks sends 119 characters and `…`, exit 0; `['--force', 'push', 'needs', 'you']` sends `'--force push needs you'`; `--json` anywhere is the flag and never text.
  - `no text is the usage, and nothing is sent`: `[]`, `['--json']` and `[' \n ']` → exit 1, the usage on stderr, no `ask`.
  - `the caller is read from the command's own environment`: `CLAUDECODE=1` and an id → `claude`; the id without `CLAUDECODE` → none; `CODEX_THREAD_ID` → `codex`; both → `claude`; an id with a space, or of 200 characters → none; `cwd` `/Users/p/code/api` → `folder: 'api'`; `/` → no folder.
  - `nothing else of the environment leaves`: with `ORCA_PAIRING_CODE=secret-1` set, the message's keys are `type`, `text` and the caller's, and its JSON holds no `secret-1`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/notice.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Write the failing command tests** in `command.spec.ts` (a real devices listener on a throwaway socket, as the file's `link` cases make one):
  - `device notify reaches the devices' listener and prints its answer`: the listener gets `{ type: 'notice', text: 'Connect the VPN', … }` and answers `{"result":"shown"}`; stdout is `shown`, exit 0.
  - `with no listener it prints no dial, exit 0`.
  - `the usage names notify`.
- [ ] **Step 4: Write the failing end-to-end file**, `cli/e2e/deviceNotify.e2e.ts`: the real daemon (`IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })`), a `Desk` on `HARNESSD_TEST_DIAL_PORT`, the real command (`CLI_ENTRY` as `hardwareWatch.e2e.ts`'s, run with `d.env`, the caller's variables and its folder as `cwd`).
  - `an outside Claude Code session's notice is its own card`: an `Outside` in `fix-login` under Ghostty; the command with `CLAUDECODE=1` and its session id prints `shown`, exit 0; the dial hears `{ t: 'question', agentId: engine.id, name: 'fix-login', id: /^shown:/, questions: [{ key: 'notice', q: LINE, options: ['In Ghostty'] }] }`. The same line again prints `limited`, and the dial hears no second question. The dial reads the card (`dial.send({ t: 'question.read', agentId: engine.id, requestId: 'read-1' })`, as `deviceClaudeOrca.e2e.ts` does): the `question.state` holds the line. The person's next prompt (`engine.type`) → the dial hears `question.close` with that id, and no `question.close` came before that prompt: reading the card does not close it. The daemon's log holds `[device] notify · claude · shown` and no line holds `LINE`.
  - `a Codex session's notice is its own card` (`CodexOutside`, `CODEX_THREAD_ID`).
  - `a Harness agent's notice is tied to the agent`: an agent made as `deviceWithoutApp.e2e.ts`'s `create`; the command with its row's `sessionId` → the question's `agentId` is the Harness agent's id.
  - `a session nobody lists still rings, under its folder`: a random session id, run in `scratch` → `name: 'scratch'`.
  - `it rings with a window open on its tab` (the file's `onTab`, as `deviceWithoutApp.e2e.ts`'s).
  - `with the dial unplugged it prints no dial`.
  - `with no dial on this computer it prints no dial and starts nothing` (`CABLE_DISABLE: 'true'`): the daemon's log holds no `asking for the devices' process` after the command.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts -t notify` and `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts`. Expected: FAIL (the usage is printed, exit 1).
- [ ] **Step 6: Implement.**
- [ ] **Step 7: Run** steps 2 and 5's commands, then `cd cli && npx vitest run src/deviceClaude src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 8: Commit** `Dial: harness device notify, the agent's one line to the dial`.

### Task 14: `harness device codex`

**Layer:** the `harness` command. **Depends on:** none. **Effort:** `xhigh` (it writes into the person's Codex home). The skill's place, `$CODEX_HOME/skills/dial/SKILL.md` (`~/.codex` by default), is checked against Codex 0.167.1, the version on this Mac (Verification check 5); no minimum version is enforced.

**Red test:** `cli/src/devices/codexSkill.spec.ts` (new); `cli/src/deviceClaude/command.spec.ts`.

**Files:**
- Create: `cli/src/devices/codexSkill.ts`, `cli/src/devices/codexSkill.spec.ts`
- Modify: `cli/src/deviceClaude/command.ts`, `cli/src/deviceClaude/command.spec.ts`, `cli/src/cli.ts`

**Interfaces:**
- Produces:
  ```ts
  // cli/src/devices/codexSkill.ts
  export const DIAL_SKILL_DESCRIPTION = 'The person has a Harness dial on their desk. Use it when you need them to do something you cannot: give information, act outside your reach (connect a VPN, sign in, plug in a device), or decide.'
  export const DIAL_SKILL: string                      // the whole file, below
  export interface CodexSkillDeps { home: string; installed: boolean; platform: NodeJS.Platform }
  export interface CodexStatus { supported: boolean; installed: boolean; enabled: boolean }
  export type CodexResult = { ok: true } | { ok: false; error: string }
  export function codexSkillPath(home: string): string  // <home>/skills/dial/SKILL.md
  export function codexStatus(deps: CodexSkillDeps): CodexStatus
  export function codexEnable(deps: CodexSkillDeps): CodexResult
  export function codexDisable(deps: CodexSkillDeps): CodexResult
  ```
- `DIAL_SKILL`, byte for byte. The description is `JSON.stringify(DIAL_SKILL_DESCRIPTION)`: a quoted YAML scalar. The block's two-space indent below is this list's, not the file's: the file's first line is `---`, the command's line starts with four spaces, and the file ends with one newline.
  ```text
  ---
  name: dial
  description: "The person has a Harness dial on their desk. Use it when you need them to do something you cannot: give information, act outside your reach (connect a VPN, sign in, plug in a device), or decide."
  ---

  When you need the person to act, ring their dial:

      harness device notify "<what you need, in one line>"

  - Never for progress, and never for "done": only when the person must act.
  - At most once for the same need.
  - Never put a secret, a token or a file's content in the line: anyone near the desk can read it.
  - Still write the full ask in your answer. The command prints `shown`, `no dial` or `limited`: whichever it prints, your answer carries the ask.
  ```
- The rules:
  - `supported`: macOS or Linux. `installed`: as given (the caller reads `installedEngineBin('codex')`). `enabled`: the file at `codexSkillPath(home)` is a regular file whose text is exactly `DIAL_SKILL` (one read, 16 KiB at most).
  - `enable`: not supported → `The dial reaches Codex on macOS and Linux.`; not installed → `Codex is not on this computer.`; the file is ours → ok, nothing written; nothing at the path → the folders are made (0700) and the file is written to a temp file and renamed (0600) → ok; anything else at the path (another text, a link, a folder) → `Codex already has a skill named dial that Harness did not write.`; a write that fails → `Could not write the Codex skill.`
  - `disable`: the file is ours → it is removed, and `skills/dial` too when that leaves it empty; never `skills`. Anything else → ok, nothing removed.
- `runDeviceCommand`: `codex status [--json]` prints the status (one line with `--json`, as Claude Code's); `codex enable` and `codex disable` exit 0, or 1 with the error on stderr. `DeviceDeps` gains `codexHome: string` and `codex(): boolean`; `cli.ts` passes `env.CODEX_HOME` and `() => installedEngineBin('codex') !== null`. `DEVICE_USAGE` gains the three lines.

- [ ] **Step 1: Write the failing tests** (a throwaway Codex home each).
  - `enable writes exactly the skill, once`: the file is `DIAL_SKILL`, mode 0600; `codexStatus` is `{ supported: true, installed: true, enabled: true }`; a second `enable` leaves the file's inode.
  - `the skill's front matter is YAML a loader reads`: the text between the two `---` lines, parsed with the `yaml` package, is `{ name: 'dial', description: DIAL_SKILL_DESCRIPTION }`; the body holds `harness device notify "<what you need, in one line>"`.
  - `disable removes exactly the skill`: the file and `skills/dial` are gone; `skills` and a sibling `skills/other/SKILL.md` stay; with a `skills/dial/notes.md` beside it, the folder stays.
  - `a skill Harness did not write is left alone`: a `skills/dial/SKILL.md` of another text, an edited copy of ours, and a link at that path: `enable` answers the `already has` error and the file is unchanged; `enabled` is false; `disable` is ok and removes nothing.
  - `a home with no skills folder gets one; a skills that is a file is one error`: `Could not write the Codex skill.`
  - `not on this computer, or on Windows`: the two errors; `status` says `installed: false` or `supported: false`, and nothing is written.
  - `command.spec.ts`: `device codex status --json` prints `{"supported":true,"installed":true,"enabled":false}`; after `device codex enable`, `enabled` is true; `device codex disable` then false; `device codex` alone prints the usage, exit 1; the usage names the three.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/codexSkill.spec.ts src/deviceClaude/command.spec.ts`. Expected: FAIL (no module; the usage is printed).
- [ ] **Step 3: Implement.** `command.ts`'s head comment names `harness device codex …`.
- [ ] **Step 4: Run** the same, then `npx vitest run src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: harness device codex writes the dial skill into Codex's home, and removes it`.

### Task 15: App: `Effect::SetNotify` and `Watch::notify`

**Layer:** Harness Device. **Depends on:** none. **Effort:** `high`.

**Red test:** `watch.rs` `a_notify_line_reaches_the_watch`; `runner.rs` `a_notifications_change_is_written_to_the_watch`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `device-app/src-tauri/src/watch.rs`, `device-app/src-tauri/src/runner.rs` (their tests are in the same files)

**Interfaces:**
- Produces:
  - `types.rs`: `#[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum NotifyMode { Full, You }`; `Effect::SetNotify(NotifyMode)`.
  - `watch.rs`: `pub fn notify(&self, mode: NotifyMode)`, beside `sound`, through the same `write`: `{"notify":"full"}` or `{"notify":"you"}`, two fixed strings.
  - `runner.rs`, in `Runner::run`: `Effect::SetNotify(mode)` calls `notify(mode)` on the watch running now, on the caller's thread; with no watch it does nothing. It returns `None` and sends no `Event`.

- [ ] **Step 1: Write the failing tests.**
  - `watch.rs` `a_notify_line_reaches_the_watch`: the script is `{"attached":true}`, `@record`. `watch.notify(NotifyMode::You)`, `watch.notify(NotifyMode::Full)`, `watch.stop()`: `fake.stdin()` is `[r#"{"notify":"you"}"#, r#"{"notify":"full"}"#]`. A `notify` after the end adds nothing.
  - `runner.rs` `a_notifications_change_is_written_to_the_watch`: `world()`, the `RECORDING` script, `SpawnWatch`; `run(Effect::SetNotify(NotifyMode::You))` and `…(Full)` both give `None`; after `StopWatch`, `w.fake.stdin()` is the same two lines; with no watch running nothing is added; no log line contains `notify`.
  - `runner.rs` `the_binary_gets_its_three_effects_back`: `others` gains `Effect::SetNotify(NotifyMode::You)`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib notif`. Expected: FAIL (no variant `SetNotify`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: a Notifications change is one fixed line on the watch's stdin`.

### Task 16: App: the Notifications submenu and its click

**Layer:** Harness Device. **Depends on:** Task 15. **Effort:** `high`.

**Red test:** `types.rs` `a_status_line_carries_notify`; `model.rs` `the_notifications_submenu`, `the_notifications_submenu_is_absent_when_there_is_nothing_to_change`; `app.rs` `a_notifications_click_tells_the_watch_and_draws_the_menu_again`; `main.rs` `every_menu_action_has_its_own_id`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `device-app/src-tauri/src/model.rs`, `device-app/src-tauri/src/app.rs`, `device-app/src-tauri/src/main.rs`
- Test only: `device-app/src-tauri/src/runner.rs`, `device-app/src-tauri/src/watch.rs` (every `DialStatus { … }` gains `notify: None`)

**Interfaces:**
- Consumes: `NotifyMode`, `Effect::SetNotify` (Task 15).
- Produces:
  - `types.rs`: `DialStatus.notify: Option<NotifyMode>`, read leniently: `"full"` and `"you"` are the two modes; any other value, of any type, is `None` and the line is still a status. `MenuAction::NotifyFull`, `MenuAction::NotifyYou`. `MenuItem::Submenu(String, Vec<MenuItem>)`.
  - `model.rs` `menu`: after the Sound row and before the separator, when `cli` is `Found`, `daemon` is `Up`, and the dial is attached, has no `updating` and has a `notify`: `Submenu("Notifications", [Check(NotifyFull, "Full", mode == Full), Check(NotifyYou, "Needs you", mode == You)])`. Absent otherwise, never greyed.
  - `model.rs` `menu_log`: a submenu is its label, a colon and its checked item's label: `Notifications: Full`, `Notifications: Needs you`.
  - `app.rs`: `Event::Menu(NotifyFull)` gives exactly `[Effect::SetNotify(NotifyMode::Full), Effect::Menu(<the last menu sent>)]`, and `NotifyYou` the same with `You`. No log line, nothing remembered: the check moves when the watch's next line says so.
  - `main.rs`: `menu_id` gives `"notify_full"` and `"notify_you"`; `menu_action` finds both; `native_menu` draws a `Submenu` as `tauri::menu::Submenu`, enabled, its items drawn by the rules the top level uses.

- [ ] **Step 1: Write the failing tests.**
  - `types.rs` `a_status_line_carries_notify`: `{"attached":true,"notify":"you"}` → `Some(You)`; `"full"` → `Some(Full)`; no key → `None`; `{"attached":true,"notify":"later"}`, `"notify":7` and `"notify":null` → a status with `None`.
  - `model.rs` `the_notifications_submenu`, with `notifying(mode) = DialStatus { notify: Some(mode), ..sound(Some(false)) }`: for `Full` the whole menu is `Dial connected · 0.0.95`, `Signed in`, `Claude Code: On`, `Turn off`, `Check(SoundOff, "Sound", true)`, `Submenu("Notifications", [Check(NotifyFull, "Full", true), Check(NotifyYou, "Needs you", false)])`, the separator, `Open Harness`, `Quit`. For `You` the checks are `false`, `true`. With `muted: None` the submenu is still there, after the Claude Code rows.
  - `model.rs` `the_notifications_submenu_is_absent_when_there_is_nothing_to_change`: no item is a `Submenu` for `dial: None`; `notify: None`; `attached: false`; `updating: Some("0.0.96")`; `daemon` `Starting`, `Stopped`, `Updating`; `cli` `Removed`, `Installing`, `InstallFailed`.
  - `model.rs` `the_menu_as_a_log_line` also gives `… | Turn off | Sound ✓ | Notifications: Full | Open Harness | Quit`, and `Notifications: Needs you`.
  - `app.rs` `a_notifications_click_tells_the_watch_and_draws_the_menu_again`: `found()`, a line with the dial attached and `notify: Some(Full)`, `menu = menu_of(…)`; for `(NotifyYou, You)` and `(NotifyFull, Full)`: `app.handle(Event::Menu(action))` equals `[Effect::SetNotify(mode), Effect::Menu(menu.clone())]`.
  - `app.rs` `the_check_follows_the_watch_not_the_click`: after `Event::Menu(NotifyYou)` the menu still checks `Full`, and there is no `menu:` log line; a line with `notify: Some(You)` checks `Needs you` and logs `… | Notifications: Needs you | Quit`; `Event::WatchExit(Some(3))` leaves no `Submenu`.
  - `main.rs` `every_menu_action_has_its_own_id`: ten actions, ten ids; `menu_action("notify")` is `None`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib`. Expected: FAIL (no field `notify`, no variant `Submenu`).
- [ ] **Step 3: Implement.** `model.rs`'s `the_whole_menu` and `the_sound_row` pass unchanged: their dials have no `notify`.
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: Notifications, Full or Needs you, in the menu`.

### Task 17: App: a `notify:` line of the watch reaches the log

**Layer:** Harness Device. **Depends on:** none. **Effort:** `xhigh` (what a log may carry).

**Red test:** `cli.rs` `only_three_shapes_of_stderr_are_logged_as_they_come`, `a_watch_logs_a_notify_code_as_it_comes_and_no_other_stderr`.

**Files:**
- Modify: `device-app/src-tauri/src/cli.rs` (its tests are in the same file)

**Interfaces:**
- Produces, private to `cli.rs`: `const NOTIFY_STDERR: &str = "notify: "`. `logged_stderr` is also true for `notify: ` followed by a code of the shape Sound's has (1 to 32 bytes, the first `A-Z`, the rest `A-Z`, `0-9` or `_`). `tail` holds the line so far to one byte past the longest such line. The comment on `LOGGED_STDERR` names the three shapes.

- [ ] **Step 1: Write the failing tests.**
  - `only_three_shapes_of_stderr_are_logged_as_they_come` (the two-shapes test, renamed, its cases kept). Also true: `notify: NO_DIAL`, `notify: WRITE_FAILED`, `notify: A`, `notify: ` and 32 `A`s. Also false: `notify: `, `notify:NO_DIAL`, ` notify: NO_DIAL`, `notify: no dial`, `Notify: NO_DIAL`, `notify: /Users/person`, `notify: person@example.com`, `notify: ` and 33 `A`s.
  - `a_watch_logs_a_notify_code_as_it_comes_and_no_other_stderr`: the fake prints `@err notify: WRITE_FAILED`, `@err notify: /Users/person/x`, `@err notify: Connect the VPN`, `started`, `@hang`. After a kill the log is `["harness hardware watch --json: notify: WRITE_FAILED", "harness hardware watch --json: killed by a signal"]`.
  - `the_replaced_line_is_found_across_reads_and_only_whole`: the chunks `notify: NO_` then `ANSWER\n` say `notify: NO_ANSWER` once.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib stderr`. Expected: FAIL (`notify: NO_DIAL` is not logged).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked --lib cli::`. Expected: PASS; the Sound cases pass unchanged.
- [ ] **Step 5: Commit** `Harness Device: the log carries the watch's notify: code, and no other stderr`.

### Task 18: App: Codex's status and switch

**Layer:** Harness Device. **Depends on:** Task 16 (the same `types.rs`). **Effort:** `medium`.

**Red test:** `codex.rs` `status_reads_the_three_fields`, `on_and_off_run_one_command_each`.

**Files:**
- Create: `device-app/src-tauri/src/codex.rs`
- Modify: `device-app/src-tauri/src/lib.rs`, `device-app/src-tauri/src/types.rs`

**Interfaces:**
- Produces:
  - `types.rs`: `#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)] #[serde(default)] pub struct CodexStatus { pub supported: bool, pub installed: bool, pub enabled: bool }`.
  - `codex.rs`, as `claude.rs`: `pub const FAILED: &str = "Could not change Codex."`; `pub fn status(cli: &dyn Cli) -> Option<CodexStatus>` runs `["device", "codex", "status", "--json"]` within `STATUS_DEADLINE` and reads the first JSON line that holds a boolean `supported`; `pub fn set(cli: &dyn Cli, on: bool) -> Result<(), String>` runs `["device", "codex", "enable" | "disable"]` within `CHANGE_DEADLINE`, its failure the CLI's last line, 200 characters at most, else `FAILED`.
  - `lib.rs`: `pub mod codex;`.

- [ ] **Step 1: Write the failing tests** (the fake CLI, as `claude.rs`'s).
  - `status_reads_the_three_fields`: `{"supported":true,"installed":true,"enabled":false}` → that status; `fake.calls()` is `["device codex status --json"]`.
  - `a_cli_without_the_command_has_no_codex`: no script, a usage text and `[]` → `None`.
  - `a_line_without_supported_is_not_a_status`: `{"error":"x"}`, `{}` → `None`.
  - `on_and_off_run_one_command_each`: `device codex enable`, `device codex disable`.
  - `a_failure_says_why`: `@err Codex is not on this computer.` and `@exit 1` → that text; `@exit 1` alone → `FAILED`; 300 `x` → 200 `x`.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib codex`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: Codex's status and switch, through the CLI`.

### Task 19: App: the Codex rows and the offer

**Layer:** Harness Device. **Depends on:** Task 18. **Effort:** `high`.

**Red test:** `model.rs` `the_codex_rows`, `screens_are_due_in_order`; `app.rs` `codex_turns_on_from_the_window`, `codex_turns_off_from_the_menu`, `the_first_screen_waits_for_all_three_answers`; `state.rs` `a_state_file_from_before_codex_keeps_its_answers`.

**Files:**
- Modify: `device-app/src-tauri/src/types.rs`, `device-app/src-tauri/src/model.rs`, `device-app/src-tauri/src/app.rs`, `device-app/src-tauri/src/runner.rs`, `device-app/src-tauri/src/main.rs`
- Test only: `device-app/src-tauri/src/state.rs`

**Interfaces:**
- Consumes: `codex::status`, `codex::set`, `CodexStatus` (Task 18).
- Produces:
  - `types.rs`: `Saved.asked_codex: bool`, `#[serde(default)]` (`askedCodex` in the file; a file without it reads `false`). `Screen::Codex` (`"codex"`). `AppState.codex: Option<CodexStatus>`. `MenuAction::CodexOn`, `CodexOff`. `Event::Codex(Option<CodexStatus>)`, `Event::CodexSet(Result<(), String>)`. `Effect::ReadCodex`, `Effect::SetCodex(bool)`. `Action` is unchanged.
  - `runner.rs`: `ReadCodex` answers `Event::Codex(codex::status(cli))`; `SetCodex(on)` answers `Event::CodexSet(codex::set(cli, on))` and logs `codex: <message>` on a failure.
  - `model.rs`: after the Claude Code rows, when Codex is `supported` and `installed`: `Codex: On` and `Action(CodexOff, "Turn off")`, or `Codex: Off` and `Action(CodexOn, "Turn on…")`. `due`: after Claude Code, `Screen::Codex` when Codex can be turned on here, is off, and `asked_codex` is false.
  - `app.rs`, each as Claude Code's:
    - every read asks `ReadCodex` beside `ReadAuth` and `ReadClaude`; the first screen waits for the three answers;
    - `Event::Codex` keeps the last answer when a read fails;
    - `CodexOn` shows the Codex screen; `CodexOff` runs `SetCodex(false)`; one Codex change at a time, apart from Claude Code's;
    - on the Codex screen: `TurnOn` at `Offer` and `Retry` at `Failed` run `SetCodex(true)` and show `Working`; `NotNow` remembers `asked_codex` and moves on;
    - `CodexSet(Ok)` reads Codex again, and for a turn-on remembers `asked_codex` and moves on; a failed turn-on shows `Failed` with its text; a failed turn-off shows nothing;
    - closing the window on the offer or the failure remembers `asked_codex`;
    - a CLI that goes away forgets Codex and its change.
  - `main.rs`: `menu_id` gives `"codex_on"` and `"codex_off"`.

- [ ] **Step 1: Write the failing tests.**
  - `types.rs` `state_json_keys`: the keys gain `"askedCodex": false`. `the_window_may_ask_six_things` passes unchanged.
  - `state.rs` `a_state_file_from_before_codex_keeps_its_answers`: `{"version":1,"cliSeen":true,"askedSignIn":true,"askedClaude":true,"loginItem":true}` loads with those four true and `asked_codex` false, and logs nothing.
  - `model.rs` `the_codex_rows`: on → `Codex: On`, `Turn off` after the Claude Code rows and before Sound; off → `Codex: Off`, `Turn on…`; not supported, not installed or `None` → no Codex row. `the_whole_menu` passes with `codex: None`.
  - `model.rs` `screens_are_due_in_order`: with Claude Code asked or on, Codex off and not asked → `Screen::Codex`; Claude Code due first when both are; Codex on, not installed, not supported or asked → not due.
  - `app.rs` `the_first_screen_waits_for_all_three_answers` (the both-answers test, renamed): no screen until `Event::Codex` has come too; a `None` answer counts.
  - `app.rs` `codex_turns_on_from_the_window`: on the offer, `Event::Act(Action::TurnOn)` → `SetCodex(true)` and `Working`; `CodexSet(Ok(()))` → `ReadCodex`, a `Save` with `asked_codex` true, the window hidden. `CodexSet(Err("x"))` → `Failed` with `["x"]`; `Retry` runs it again.
  - `app.rs` `codex_turns_off_from_the_menu`: `Event::Menu(CodexOff)` → `SetCodex(false)`; a second click while it runs adds none; `CodexSet(Ok)` → `ReadCodex`.
  - `app.rs` `later_and_not_now_are_remembered` and `closing_the_window_on_an_offer_is_later` also cover the Codex offer; `a_cli_that_goes_away_ends_what_needed_it` leaves no Codex row; `the_menu_reads_again_at_most_once_a_minute` expects `ReadCodex` with the other two.
  - `runner.rs`: `a_codex_change_runs_one_command_and_answers` (`device codex enable` in `fake.calls()`, `Event::CodexSet(Ok(()))`); a failure logs `codex: <message>`. `the_binary_gets_its_three_effects_back`: `others` gains `ReadCodex` and `SetCodex(true)`.
  - `main.rs` `every_menu_action_has_its_own_id`: twelve actions.
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib`. Expected: FAIL (no field `codex`, no variant `Codex`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: Codex in the menu, offered once`.

### Task 20: Window: the Codex screen

**Layer:** Harness Device's window. **Depends on:** none (the contract is `Screen` `"codex"`, phases `offer`, `working`, `failed`, and the six action names as they are). **Effort:** `high`.

**Red test:** `device-app/ui/src/screens.test.ts` `codex: Turn on, a failure, Retry; Not now`; `gallery.test.ts`.

**Files:**
- Modify: `device-app/ui/src/api.ts`, `device-app/ui/src/screens.ts`, `device-app/ui/src/gallery.ts`, `device-app/ui/src/screens.test.ts`, `device-app/ui/src/gallery.test.ts`

**Interfaces:**
- Produces:
  - `api.ts`: `Screen` gains `'codex'`.
  - `screens.ts` `FACES`:
    - `codex.offer`: heading `Let Codex reach your dial?`; one sentence, `Codex can ring the dial when it needs you: a VPN, a sign-in, a decision.`; buttons `Not now` (`not_now`), `Turn on` (`turn_on`, primary).
    - `codex.working`: heading `Codex`, the spinner, no button.
    - `codex.failed`: heading `Codex`, the error line, `Retry`.
  - `gallery.ts` `STATES` gains `Codex · offer`, `Codex · working` and `Codex · failed` (line `Could not change Codex.`): 14 states.

- [ ] **Step 1: Write the failing tests.**
  - `screens.test.ts` `codex: Turn on, a failure, Retry; Not now`, clicked through as a person does: the offer shows its heading, its sentence and `['Not now', 'Turn on']`; `Turn on` calls `act('turn_on')`; `working` shows the spinner and no button; `failed` with `['Could not change Codex.']` shows it and `['Retry']`, and `Retry` calls `act('retry')`; on the offer again, `Not now` calls `act('not_now')`; a `null` view draws nothing.
  - `gallery.test.ts`: `STATES` has 14, and `CONTRACT_PAIRS` gains `codex.offer`, `codex.working`, `codex.failed`.
- [ ] **Step 2: Run** `cd device-app/ui && npx vitest run`. Expected: FAIL (nothing is drawn for `codex.offer`).
- [ ] **Step 3: Implement.** `screens.ts`'s head comment says four screens.
- [ ] **Step 4: Run** `cd device-app/ui && npx vitest run && npm run typecheck && npm run build && npm run gallery`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device: the Codex offer in the window`.

### Task 21: The docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior. One commit.

**Files:**
- Modify: `docs/cli.md`, `docs/plans/2026-11-13-device-menubar-design.md`, `desktop/design/desktop-design-system.md`, `device-app/AGENTS.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md`

- [ ] **Step 1:** `docs/cli.md`, the command table, after the `harness flash` row:
  - `` | `harness device notify "<one line>" [--json]` | For an agent: ring this computer's dial when it needs the person to act. One line, 120 characters at most. Prints `shown`, `no dial` or `limited`, exit 0 for each. Claude Code and Codex run it without a permission question. | ``
  - `` | `harness device codex status [--json]` · `enable` · `disable` | Whether Codex has the `dial` skill, which tells it of the dial · write it into the Codex home · remove it. | ``
- [ ] **Step 2:** The menubar design's `### Menu` table: after the Claude Code row, `| Codex | "Codex: On" with **Turn off**, or "Codex: Off" with **Turn on…**; absent when Codex is not on this computer |`; after the Sound row, `| **Notifications** (submenu) | **Full** and **Needs you**, the one in force checked; only while Harness runs and the dial is attached and not updating ([design](2026-11-16-dial-agent-notify-design.md)) |`.
- [ ] **Step 3:** The design system's `## Harness Device`: it offers sign-in, Claude Code and Codex once; the window has four screens, Install, Sign in, Claude Code and Codex; and one bullet after Sound's: `- A choice among named options in the menu is one native submenu of check items, the one in force checked. Notifications is the first.` The gallery shows the Codex screen (Task 20).
- [ ] **Step 4:** `device-app/AGENTS.md`: the intro's "offers sign-in and Claude Code once" and "the window's three screens" name Codex and four screens. The rule "one of six action names" stays.
- [ ] **Step 5:** `cli/AGENTS.md`, the `devices` row of the processes table: an agent's notice (`harness device notify`), shown as a question the dial only shows, and the Notifications setting, kept in `dial-notify.json`. `cli/src/services/AGENTS.md`, the paragraph on the devices' listener: `notice` and `notify` beside `front`, `tab` and `attach`.
- [ ] **Step 6: Commit** `Dial: the notice and the Notifications setting in the docs`.

## Verification

**Platforms the pull request names:** the command, the allow rule and the skill on macOS and Linux (PR CI's unit suites on Linux; check 3 on this Mac and on Linux runners). Harness Device on macOS (checks 2 and 4 on this Mac) and Linux (PR CI). Windows: `harness device notify` answers `no dial` there and the allowance is not installed there; no workflow runs these specs there: reported as not run. Desktop, the phone, the website: no code changes.

**Temporary workflow:** none. The long check, the end-to-end suite, has its workflow (`.github/workflows/cli-e2e.yml`); Harness Device's tests run in PR CI (`device-app-checks`). The new `cli/e2e/deviceNotify.e2e.ts` is taken by the nightly CLI end to end run, so it keeps running for later pull requests.

**Turns.** The tester starts the one hand-started GitHub run (check 3) once, at the final head, without asking. Checks 5 and 6 run before the merge and wait for the orchestrator's go before the live daemon is stopped ("The live daemon, for checks 5 and 6").

**The pull request also says:** nothing under `cli/src/core` changes; the four allow-list files the core loads change by one rule; the app's log lets through one more shape of the watch's stderr (Task 17); screenshots of the submenu and the Codex offer (check 4).

**1. In PR CI, nothing started by hand.** `cli-typecheck` and `cli-tests` run Tasks 1 to 14's unit tests on Linux; `device-app-checks` runs Tasks 15 to 20's (the window's typecheck, vitest and bundle, then `cargo test` on Linux); `desktop-tests` runs by itself, as one doc under `desktop/` changes.

**2. Local gates,** recorded in the pull request (PR CI does not run them):
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit: it runs `cli-core` (`npm run test:core`, 100% per file for `services/devices.ts` and `services/devicesListener.ts`) and prints the receipt to paste.
- `(cd device-app/ui && npm ci && npm run build) && cd device-app/src-tauri && cargo test --locked`, on a Mac: PR CI compiles only the Linux code (`docs/validation-and-release.md`, "Harness Device on macOS").
- `git diff --stat 5840f0786f -- cli/src/core cli/src/harnessd cli/src/architecture.coreFiles.txt` prints nothing. If it prints a line, the branch broke its own rule: stop and report.

**3. The real daemon, a fake dial, the real command and watch**
- Run, on this Mac, at the final head: `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts e2e/hardwareWatch.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/deviceCodex.e2e.ts e2e/deviceHerdr.e2e.ts e2e/dialAppFilter.e2e.ts e2e/eagerHooks.e2e.ts`. The first two hold the new cases; the others run the cards, the waiting prompts, the watch and the hook settings this branch touches.
- Isolation (`cli/AGENTS.md` rule 6; `docs/development.md`, "Isolated end-to-end testing"): the suite's own `IsolatedDaemon` (`e2e/harness/daemon.ts`). A throwaway home, data folder, auth folder and computer id, its own port and tmux server, fake Claude Code and Codex engines, engine homes inside its root, signed out, the backend at `127.0.0.1:9`. The dial is a fake on a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`), which replaces the scan of `/dev`: no real port is opened. The person's daemon (18473), `~/.harness`, `~/.claude`, `~/.codex`, the real dial, Desktop and production are not touched.
- A person sees: every test passes. In the new cases the fake dial hears a `question` whose id starts `shown:`, with the agent's name and the line; a second same line prints `limited`; the next prompt closes the card; after `{"notify":"you"}` a finished turn's `summary` says `tier: "list"`, and the mode is still `you` after the daemon restarts.
- On GitHub, by hand, once at the final head: Actions → CLI end to end → Run workflow, branch `feat/dial-agent-notify` (`.github/workflows/cli-e2e.yml`). Eight Linux shards; every shard passes. Report the run link.

**4. The real app against the fake CLI: the submenu and the Codex offer**
- Why by hand: a native menu and a window need a Mac session and a person's eye. Nothing here reaches a daemon, a dial, Codex or an account.
- Build, at the final head: `(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)`. The app is the unbundled debug binary, `device-app/src-tauri/target/debug/harness-device`: never installed, no login item.
- Isolation: the recipe of `docs/plans/2026-11-13-device-menubar-plan.md` (Verification, "Isolation"), unchanged: a throwaway `$T` with its own home (`HOME` and `CFFIXED_USER_HOME`), a `PATH` of stubs (`open` and `curl` only record), `FAKE_HARNESS="$T/fake"`. `state.json` there is `{"version":1,"cliSeen":true,"askedSignIn":true,"askedClaude":true,"askedCodex":false,"loginItem":true}`: no login item is asked of macOS, and only the Codex offer is due. The released Harness Device, if it runs, is left alone.
- Scripts in `$T/fake`:
  - `auth_status_--json`: `{"loggedIn":true}`. No Claude Code script.
  - `device_codex_status_--json`: `{"supported":true,"installed":true,"enabled":false}`.
  - `device_codex_enable`: `@wait enabled`. `device_codex_disable`: empty.
  - `hardware_watch_--json`, a line each: `{"attached":true,"fw":"0.0.95","muted":false,"notify":"full"}`, `@wait you`, `{"attached":true,"fw":"0.0.95","muted":false,"notify":"you"}`, `@wait old`, `{"attached":true,"fw":"0.0.95","muted":false}`, `@wait none`, `{"attached":false}`, `@record`.
- Run, in the isolated shell: `HARNESS_DEVICE_CLI="$PWD/device-app/src-tauri/tests/fake-harness" device-app/src-tauri/target/debug/harness-device &`
- A person does and sees:
  1. The window opens on `Let Codex reach your dial?`, with `Codex can ring the dial when it needs you: a VPN, a sign-in, a decision.`, `Not now` and `Turn on`. Screenshot, light and dark.
  2. Click `Turn on`: a spinner under `Codex`. Write `{"supported":true,"installed":true,"enabled":true}` into `device_codex_status_--json`, then `touch "$T/fake/enabled"`: the window closes.
  3. The menu reads `Dial connected · 0.0.95`, `Signed in`, `Codex: On`, `Turn off`, `Sound` checked, `Notifications ▸`, a separator, `Open Harness` (when Desktop is installed), `Quit`. The submenu holds `Full`, checked, and `Needs you`. Screenshot.
  4. Click `Needs you`. Open the submenu again: `Full` is still checked. `touch "$T/fake/you"`: within a second `Needs you` is checked and `Full` is not. Screenshot.
  5. `touch "$T/fake/old"`: Sound stays, no Notifications row. `touch "$T/fake/none"`: `No dial`, neither row.
  6. Quit from the menu. `grep notify "$T/fake/stdin.log"` prints `{"notify":"you"}` and no other line. `grep -c 'device codex enable' "$T/fake/calls.log"` prints `1`. The log, `$T/home/Library/Logs/ai.autonomous.harness.device/app-*.log`, has `menu:` lines with `Notifications: Full` and `Notifications: Needs you`.
  7. Start it again: no window opens (`askedCodex` is now true in `state.json`, and its other four answers are as they were).
- Afterwards: `rm -rf "$T"` (its `stdin.log` also holds which apps were in front; quote only the `notify` lines).
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. It needs a Mac session and a person's eyes on a native menu.

**The live daemon, for checks 5 and 6** (decided by Ken, 2026-11-16: both run before the merge, on this Mac, with his dial on `/dev/cu.usbmodem21301`, with his live daemon stopped for the duration)

Why: on macOS the dial's port is one daemon's alone (`cli/src/cable/serial.ts`), the daemon that rings it must run this branch, and only a daemon on Ken's own home writes the allow rules into the `~/.claude` and `~/.codex` his engines read. So for checks 5 and 6 this branch's daemon stands in for his everyday one, on his own home and port, and everything is put back afterwards. Nothing else in this plan touches the live daemon.

Rules for the whole window:
- Never `pkill` or `killall` by name. Stop only the PID recorded below, or exactly the one label recorded below.
- Log every command run against the live daemon, its LaunchAgent, Harness.app or Harness Device, with its output, in `$S/commands.log` (`S=$(mktemp -d)`, outside the repository). The report quotes it.
- Never delete or edit anything in `~/.harness` beyond what a daemon writes itself: no `make install-cli`, no `harness update`, no `harness start` without `-f` (it would bootstrap the LaunchAgent on the released bundle). Never touch Harness.app's data.
- The tester asks the orchestrator for the go at step B3, before anything is quit or stopped (the Mac and the dial are shared), and hands them back at step A6.
- Every step that needs a person's eyes or ears (a beep, a card on the dial, a menu's check mark, a photo) is not the tester's to judge: the tester stops, sends the orchestrator exactly what Ken must look at, batched into the two asks of check 6, and waits for the result the orchestrator returns. An item Ken cannot confirm is reported as not verified.

Before (B):
1. Record, into `$S/before/`:
   - The live daemon: the PID listening on 18473 (`lsof -nP -iTCP:18473 -sTCP:LISTEN`), its command line (`ps -o pid,ppid,command -p <PID>`), and its master (the parent PID).
   - The LaunchAgent: `launchctl print gui/$(id -u)/ai.autonomous.harness.harnessd` (loaded or not, state, PID, program) and `launchctl print-disabled gui/$(id -u) | grep harness`. The label is the one `harness stop` boots out (`cli/src/cliCommand.spec.ts`, "harness service, through the CLI"); if `launchctl print` names another, record that one and use it below.
   - `~/.local/bin/harness status` (the live CLI): version, backend, account, supervisor.
   - The engines' files, harness lines only: `jq -r '.permissions.allow[] | select(test("harness"))' ~/.claude/settings.json`, `grep -n harness ~/.codex/rules/harness.rules`, and `ls -la ~/.codex/skills`.
   - `shasum ~/.local/bin/harness` (the launcher a checkout must never repoint) and a copy of `~/Library/Application Support/ai.autonomous.harness.device/state.json` (Harness Device's answers; this branch's app adds `askedCodex`).
   - Whether Harness.app and the released Harness Device are running (`pgrep -x Harness`, `pgrep -x "Harness Device"`).
2. Build this branch at the final head: `(cd cli && npm ci && npm run build)`, `(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)`. Write `$S/bin/harness`: `#!/bin/sh` and `exec node "<worktree>/cli/dist/cli.js" "$@"`, executable. Only shells and engines started with `PATH="$S/bin:$PATH"` run this branch's `harness`; the engines' hooks keep calling `~/.local/bin/harness`, which reaches whichever daemon holds 18473.
3. Ask the orchestrator for the go. Then:
4. Quit, through each app's own Quit (`osascript -e 'quit app "Harness"'`, `osascript -e 'quit app "Harness Device"'`), whichever of the two is running: Harness.app could start a daemon again (the spec's "a Mac with a dial and no Harness desktop app"), and the released Harness Device would watch the dial beside this branch's.
5. `kill -TERM <PID>` for the PID recorded in B1, nothing else. Then, bounded to 30 s, watch `lsof -nP -iTCP:18473 -sTCP:LISTEN`: if a new PID listens (its master or launchd started it again), stop that one service, either `~/.local/bin/harness stop` (it boots out exactly `ai.autonomous.harness.harnessd`) or `launchctl bootout gui/$(id -u)/ai.autonomous.harness.harnessd`, and record which. Done when nothing listens on 18473 and `launchctl print` of the label says it is not running. If a process still listens after that, stop and report; never stop a second process by hand.

During (D):
1. Start this branch's daemon on Ken's own home, in the foreground: `PATH="$S/bin:$PATH" node <worktree>/cli/dist/cli.js start -f > "$S/daemon.log" 2>&1` (in a tmux pane or as a background job the tester stops itself). No environment changes: its home, data folder and port are the everyday ones, and it signs in as the everyday daemon does.
2. Confirm: `$S/bin/harness status` names this branch's build (a `-dev` version) and port 18473; the first line of `$S/bin/harness hardware watch --json` holds `"attached":true` and a `"notify"` field; `jq -r '.permissions.allow[] | select(test("device notify"))' ~/.claude/settings.json` prints the two rules of Task 4, and `grep 'device", "notify' ~/.codex/rules/harness.rules` prints the one. If any is missing, go to After and report.
3. Start this branch's Harness Device: `HARNESS_DEVICE_CLI="$S/bin/harness" device-app/src-tauri/target/debug/harness-device &` (a debug build honors the variable; never installed, no login item).
4. Run check 5, then check 6.

After (A), whether the checks passed, failed or stopped part way:
1. `$S/bin/harness device codex disable` (check 5, step 5). Quit this branch's Harness Device from its menu. Stop this branch's daemon: Ctrl-C in its pane, or `kill -TERM` of the PID the tester started; confirm nothing listens on 18473.
2. Start the live daemon as it was recorded: if B5 booted out the label, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.autonomous.harness.harnessd.plist` (and `launchctl enable gui/$(id -u)/ai.autonomous.harness.harnessd` if B1 recorded it enabled and it is now disabled); if the label was never loaded in B1, `~/.local/bin/harness start`. Log each command.
3. Confirm, against `$S/before/`: a process listens on 18473; `~/.local/bin/harness status` reports the same version, backend, account and supervisor; `launchctl print` of the label shows the same state as before (a new PID is expected).
4. Once the live daemon has rewritten its list, the harness lines of `~/.claude/settings.json`'s allow list and of `~/.codex/rules/harness.rules`, and the listing of `~/.codex/skills`, are those recorded in B1: the notify rules this branch wrote are gone, and no `dial` skill is left. `shasum ~/.local/bin/harness` is unchanged. Put back the copy of Harness Device's `state.json`. `diff` each against `$S/before/`.
5. Reopen whichever of Harness.app and the released Harness Device B1 recorded running (`open -a Harness`, `open -a "Harness Device"`).
6. Report to the orchestrator: every command from `$S/commands.log`, the diffs of A4 (empty, or each line that differs), and the state of A3. Hand back the Mac and the dial. If anything is not as before, say so first and fix nothing further without the orchestrator.
- Afterwards: `rm -rf "$S"` once the report is sent (its logs hold the agents' lines; the report quotes only the log lines named in check 6's evidence).

**5. Real Claude Code and real Codex: no approval prompt, and Codex reads the skill** (uses the user's own Claude Code and Codex sign-ins; run by the tester in During, step 4)
- Where: this Mac, in the window above, in a terminal (tmux) whose `PATH` starts with `$S/bin`, no Harness window. Ken's own `claude` and `codex`, with his own logins and default settings: the allow rules the branch's daemon wrote in During, step 2, are the ones under test.
- The tester does and sees:
  1. `codex --version` prints `0.167.1`, the version this plan checks against (another version: note it in the evidence). `harness device codex enable`, then a new Codex session: Codex lists a skill named `dial` (its skills list), and `~/.codex/skills/dial/SKILL.md` is the file of Task 14.
  2. In each engine, a compound command after `notify` (the unit tests pin only the rule text, Task 4): `harness device notify "x" && echo hi`, `harness device notify "x"; echo hi` and `harness device notify "$(echo hi)"`: Claude Code asks; Codex does not run it outside its sandbox unasked. The tester declines each ask. `harness device claude status`: each asks as before.
  3. With Ken at the dial (check 6, ask 1): ask Codex for work that needs a VPN it cannot connect: it runs `harness device notify "…"` with no approval prompt and outside its sandbox, and says the same ask in its answer.
  4. With Ken at the dial (check 6, ask 1): ask Claude Code to run `harness device notify "Connect the VPN so I can run the staging tests"` (it has no skill until pull request 2): no permission prompt.
  5. In After, step 1: `harness device codex disable`: the skill's file is gone, and a new Codex session lists no `dial`.
- Evidence: each engine's screen around each command (no approval prompt for 3 and 4; the ask for each of 2), as text.
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. It needs the user's own engine sign-ins.

**6. On the real dial** (the spec's "By hand"; needs Ken's eyes and ears, through the orchestrator)
- Where: this Mac, in the window above, with the round dial on `/dev/cu.usbmodem21301`, Harness.app quit, this branch's Harness Device running (During, step 3), and check 5's Claude Code and Codex sessions.
- The tester sends the orchestrator two asks, each the complete list of what Ken does and looks at, written so Ken can answer each item yes or no; Ken replies `ready`, the tester does its part of the ask in order, and Ken reports. The tester judges only the commands' output and the daemon's log.
- Ask 1 (the menu, the rings, the card):
  1. Ken: the menu holds `Notifications ▸` with `Full` checked, and `Codex: On` (check 5's step 1 turned it on). Screenshot of the menu.
  2. Tester: check 5's steps 3 and 4. Ken: each time the dial beeps, wakes, and shows the line pinned on top, with the session's name and this Mac's name. Photo of the dial with a card.
  3. Tester answers the agent in its session: Ken sees the card leave the dial as its next turn starts. Tester rings again; Ken opens the alert on the dial to read it: the card stays. Ken taps "In <app>": its app comes forward and the card leaves.
  4. Tester runs the same line twice within ten minutes: the second prints `limited` (the tester's to judge); Ken: the dial does not beep again.
- Ask 2 (the modes, the cable):
  5. Ken chooses `Needs you`. Tester finishes an ordinary turn in one engine: Ken hears no beep and the dial does not wake, and its drawer holds one more row. Tester raises, one at a time, a question, a permission ask, a failed turn and a notice: Ken hears each beep. Ken chooses `Full`; the tester finishes an ordinary turn: Ken hears a beep (the dial plays at most one chime in 30 s: the tester waits 30 s between rings). Screenshot of the menu in each mode.
  6. Ken unplugs the dial: tester runs `harness device notify "x"`: `no dial`; Ken: the menu holds no Notifications row. Ken plugs it in: the row is back, with the mode chosen.
- Evidence: the daemon's log lines (`$S/daemon.log`) `[device] notify · claude · shown`, `[device] notify · codex · shown`, `… · limited`, with no line holding a notice's text; Ken's photo and screenshots, as the orchestrator returns them; each of Ken's answers.
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. It needs a dial, its speaker, and a person's eyes and ears.

**Open question** (for Ken, through the orchestrator): in checks 5 and 6 this branch's daemon runs as Ken's everyday daemon, on his `~/.harness` and his sign-in (During, step 1), so for the window it is connected to the production backend under his account and picks up his running sessions, as his everyday daemon does. The planner's rules allow no end-to-end check against production without asking: is that intended? If not, the only other way that keeps his engines' hooks reaching it is to run it after the release that carries this branch, on the everyday daemon.
