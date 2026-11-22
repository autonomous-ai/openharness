# Dial voice in VS Code and Cursor terminals Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** The dial's words reach a Codex (any `CODEX_HOME`), cursor-agent, or a Claude Code whose mod is not polling,
in a VS Code or Cursor integrated terminal, typed by Harness's extension into that terminal alone, at the agent's
prompt, only while it is in front there; Cursor's own agent gets a clear refusal. Hill-climb #4 of the dial eval (D5):
V9 and U11 go green, U10 stays red with its own sentence.

**Architecture:** Devices process and the extension only. The extension's window takes two new stream lines,
`{"type":"<words>","pid":<shell>}` and `{"enter":<shell>}`, and says `"types":true` in its state. `VscodeTerminals`
(`cable/hosts/vscodeTerminals.ts`) owns the whole send for one terminal: the words cleaned, the foreground guard
(macOS/Linux `ps` groups, Windows the process table again), the words line, the settle, the guard and the caller's prompt
check again, then the Enter line. The VS Code adapter gains `canType`/`type` over it; `observed.ts` keeps its route
order and hands every typer a prompt check. A cursor session is at its prompt from a heard `session-start` until a
`turn-start`. Cursor's own agent's sentence comes from the Cursor adapter, up through the source and the host to the
session, which names no app.

**Tech Stack:** TypeScript (Node ≥ 22.15), Vitest (the CLI's suite also runs the extension's `src/**/*.test.ts`), the
extension bundled by esbuild into the CLI's build (`cli/scripts/lib/vscodeExtensionBundle.mjs`), the dial eval (tier A
in-process with fake timers, tier B on the e2e harness).

**Spec:** `docs/plans/2026-11-22-dial-vscode-cursor-voice-design.md` (read it with this plan; its "Decisions (PM,
2026-11-22)" are final). Baseline: `/Users/duynguyen/Downloads/dial-eval-baseline-main-vscode-cursor/report.md` (VS Code
73, Cursor 70.8).

## Global Constraints

- Nothing under `cli/src/core/`, `cli/hook/`, or `cli/src/architecture.coreFiles.txt` changes. `lib/submitTiming.ts` and
  `cable/hosts/orca.ts` are imported for their constants (`INJECT_PASTE_DELAY_BASE_MS` 400, `INJECT_PASTE_DELAY_MAX_MS`
  1,500, `MAX_TEXT` 20,000, `CONTROL` `/\p{Cc}/gu`), never edited.
- `observed.ts` and `cableSession.ts` name no app (`cli/src/services/AGENTS.md`): no `vscode`, `cursor`, `Cursor` or
  editor word is added to either. `observed.ts` may name the `cursor` **engine** in `idleKnown`, as it names `claude` and
  `codex` (spec, "cursor-agent's idle").
- Wire, exact: devices → extension `{"type":"<words>","pid":<shell pid>}` and `{"enter":<shell pid>}`; extension →
  devices `vscode-state` gains `"types":true`. The Enter line holds no string. Every line ≤ 64 KiB with its newline
  (`LINE_BYTES` / `VSCODE_LINE_MAX_BYTES` = 65,536).
- Copy, exact: `Bring it to the front of its terminal.` and `Voice can't reach Cursor's agent. Type in Cursor.` Every
  other agent with no voice keeps `This agent is in <host>. Talking to it from the device comes in an update.`
- Platforms: macOS, Linux, Windows. The guard picks its branch from `VscodeTerminalsDeps.platform` (devices.ts passes
  `apps.platform`), never `process.platform`. The settle is the same everywhere (spec). Known gap, named in the PR:
  `docs/windows-rules.md` asks to wait for a paste on screen, which the devices cannot read in an editor's terminal.
- Logs carry counts and fixed words only: no words, pid, window id or path. The extension's minute line, exact:
  `in the last minute: ${shows} shows, ${notFound} not found, ${skipped} lines skipped, ${sent} states sent, ${notSent} not sent, ${typed} typed, ${entered} entered, ${typeNotFound} type not found, ${pageKeys} page keys, ${scrollLines} scroll lines, ${dropped} dropped`
  (the new counts sit before `page keys`, so `gate/realVscode.gate.ts`'s and `e2e/dialVscode.e2e.ts`'s tail regexes
  still match).
- The eval: edits **only** to `cli/src/testing/dialAppEval/tierA/steps/editor.ts` (`"types":true` and `'enter'` in
  `SHELL_FIELDS`), `tierA/steps/editor.spec.ts` (its expected state messages gain `types: true`, one new case), and
  `tierA/world.ts` (Task 10); `cli/e2e/harness/vscodeWindow.ts`, `editorWindow.ts`, `appEvalEditor.ts` and one new case in
  `cli/src/testing/dialAppEvalTierBEditor.spec.ts` (Task 11); and the regenerated `baseline.json` (Task 12). The spec's
  PM Decisions 1 and 6 allow exactly these. No check, grade or scenario changes. **Never open `cli/src/testing/dialAppEval/heldOut.ts`, any VH* or UH*
  scenario, or `cli/e2e/dialAppEvalHeldOut.e2e.ts`; never read held-out evidence in a results file.** Every task's
  implementer is told this again in the task.
- Between Task 10 and Task 12, tier A's `matches the baseline` fails with `stale baseline:` naming V9's and U11's voice
  checks: expected. A `regression`, `missing` or `held out: … differ` line is a failure of the task that caused it.
- Version: the extension's version is the CLI build's (`extensionVersion`), and `cable/vscodeExtensionSetup.ts` brings
  it current after each CLI update: no manual bump. New devices beside an older extension (no `types`) keep voice off for
  its terminals; an older devices beside the new extension ignore `types`.
- Never run a real VS Code, Cursor, Claude Code or Codex on this Mac, nor a renamed copy (a copy still writes the real
  app's Crashpad and Sentry files, 2026-11-19). Tests use fakes, the e2e harness's isolated daemon and fake editors.
- Every behaviour task: a red commit (the failing test), then a green commit. Run only the specs of what changed
  (`cd cli && npx vitest run <spec> -t '<name>'`), plus `npm run typecheck` when a type changed, plus
  `npx vitest run src/devices/vscodeExtensionTypes.spec.ts` when the extension changed. Full suites wait for Verification.
- Comments say why (name V9/U11/U10 and the spec where they explain a choice); names per `docs/naming-system.md`;
  English. The planner commits nothing.

## Decisions this plan makes (from the spec, where it leaves only the mechanism)

1. **The prompt check reaches the adapter as a parameter.** `HostAdapter.type?(pane, text, engine, atPrompt?: () =>
   boolean)`; `observed.ts` passes it (the spec's "the caller's check that the agent is still at its prompt"). Optional,
   so no other adapter or spec changes; the VS Code adapter types nothing without it.
2. **`VscodeTerminals.type` answers why**, `'typed' | 'background' | 'failed'`, so the adapter can refuse "not in front"
   with its sentence (the spec's `Promise<boolean>` plus that reason). Only the first guard's `background` gives the
   sentence; every other failure is `false`, as the spec's step 5 says.
3. **Too long is `failed`**, nothing written, as `orca.ts`'s `send` refuses its own bound. Under `MAX_TEXT` no line can
   pass 64 KiB (at most about 60 KB); the byte check stays, as the spec asks, and a test pins the arithmetic.
4. **"The same terminal" after the settle** is the same window object (its stream neither ended nor replaced), still
   typing, and the agent's terminal still that shell: a window reloaded under the same id gets no Enter.
5. **`types` is read as `message.types === true`**: any other value, or none, is a window that does not type. No state is
   refused for it.
6. **Cursor's own agent** is the spec's rule: engine `cursor`, app `cursor`, no `TERM_PROGRAM` in the hints (the test
   `vscode.ts` `inTerminal` already makes). The sentence is the Cursor adapter's `voiceRefusal(place)`.

## Review Focus

1. **The window reloads, or its stream ends and opens again under the same id, during the settle:** no Enter on the new
   stream; `failed`; the words wait in that terminal's input, submitted nowhere. Test in Task 4.
2. **A show or scroll line is written during the settle:** drained by the Enter, the Enter goes, once; still draining at
   the Enter, no Enter and `failed` (the spec's rule). Test in Task 4.
3. **Transcribed words carry a newline, CR, tab, ESC or a C1 control** (a transcriber's trailing `\n`): each is typed as
   a space, so nothing submits early and nothing steers the screen; only the Enter line submits. Test in Task 4.
4. **An older extension beside these devices** (its state says no `types`): no `v` for its terminals, today's sentence on
   the dial, and no words line ever written to it (a line over 1 KiB would end its stream). Tests in Tasks 3 and 4.
5. **A cursor session the open scan found, before its first hook** (no hints): no voice and Cursor's sentence, by the
   spec's rule; its first hook with `TERM_PROGRAM`, in a window that types, gives it voice and no sentence. Test in
   Task 9.

---

## Task graph

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | The extension's window types and presses Enter in one terminal | medium | - |
| 2 | The extension's loop takes the words and Enter lines, and says it types | high | 1 |
| 3 | The devices keep each window's `types`; `canType` | high | - |
| 4 | `VscodeTerminals.type`: cleaned words, guard, settle, guard again, Enter | xhigh | 3 |
| 5 | The source hands every typer its prompt check | high | - |
| 6 | The VS Code adapter types into a terminal (V9, U11) | high | 4, 5 |
| 7 | cursor-agent is at its prompt from its session-start (U11) | high | 5 (files) |
| 8 | The dial shows a host's own voice refusal | medium | - |
| 9 | Cursor's own agent says why (U10): adapter → source → host | high | 6 (files), 7 (files), 8 |
| 10 | Tier A models the extension's `types` and the foreground job | medium | 6, 7 |
| 11 | Tier B records the typed line | medium | 1 |
| 12 | The baseline | xhigh | 2, 9, 10, 11 |
| 13 | The real-VS-Code gate types a words line and an Enter line | medium | 2, 3 (files) |

Dependencies marked "(files)" exist only because the tasks share files, kept sequential as asked: `observed.ts` and
`observed.spec.ts` (5 → 7 → 9); `vscode.ts`, `vscode.spec.ts` and `cli/AGENTS.md` (6 → 9); `vscodeTerminals.ts` and
its spec (3 → 4, also an interface); `adapter.ts` (5 → 6 → 9, also interfaces); `gate/realVscode.gate.ts` (3 → 13).

Longest chain: 3 → 4 → 6 → 9 → 12 (five tasks; 3 → 4 → 6 → 10 → 12 is as long). Tasks 1, 3, 5 and 8 start at once.

---

### Task 1: The extension's window types and presses Enter in one terminal

**Files:** Modify `plugins/harness-device-vscode/src/window.ts`, `src/facade.ts`, `src/testing/fakeWindow.ts`;
Test `plugins/harness-device-vscode/src/facade.test.ts`.
**Depends on:** none. **Effort:** medium. Held-out: never open `heldOut.ts`, VH*/UH* or `dialAppEvalHeldOut.e2e.ts`.

**Interfaces:**
- Produces (`WindowFacade`, window.ts):
  - `type(pid: number, words: string): boolean`: the terminal whose shell has that pid gets `sendText(words, false)`;
    false when none has. Keys, never Enter, never a bracketed paste.
  - `enter(pid: number): boolean`: that terminal gets `sendText('\r', false)`; false when none has.
- Produces (`fakeWindow`): `typed: Array<{ pid: number; words: string }>`, `entered: number[]`; its `type`/`enter`
  record each ask and answer `state.terminals.includes(pid)`, as its `pageKey` does.

- [ ] **Step 1: Failing tests** (describe `windowFacade`):
  - `type sends the words with no newline to the terminal with that shell; false for a pid no terminal has`: shells 101
    and 202; `[type(101, 'Eval words for bravo.'), type(303, 'x')]` → `[true, false]`; 101's `sent` →
    `[['Eval words for bravo.', false]]`; 202's → `[]`.
  - `enter sends a lone CR with no newline to the terminal with that shell; false for a pid no terminal has`:
    `[enter(101), enter(303)]` → `[true, false]`; 101's `sent` → `[['\r', false]]`.
  - Rename `nothing but pageKey writes to a terminal` to `nothing but pageKey, type and enter writes to a terminal`
    (its body unchanged).
- [ ] **Step 2:** `cd cli && npx vitest run ../plugins/harness-device-vscode/src/facade.test.ts` → FAIL
  (`facade.type is not a function`).
- [ ] **Step 3:** Add the two members to `WindowFacade` (doc: the members that write to a terminal are now `pageKey`,
  `type` and `enter`), implement them in `facade.ts` beside `pageKey` (comment: why keys and no newline, the spec's
  Windows pseudo-console note), and in `fakeWindow`.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/devices/vscodeExtensionTypes.spec.ts` → PASS.
- [ ] **Step 5:** Commit red, then green.

### Task 2: The extension's loop takes the words and Enter lines, and says it types

**Files:** Modify `plugins/harness-device-vscode/src/loop.ts`, `plugins/harness-device-vscode/README.md`;
Test `plugins/harness-device-vscode/src/loop.test.ts`.
**Depends on:** 1 (`WindowFacade.type`, `.enter`, the fake's `typed`/`entered`). **Effort:** high. Held-out: never open
`heldOut.ts`, VH*/UH* or `dialAppEvalHeldOut.e2e.ts`.

**Interfaces:**
- Consumes: `WindowFacade.type(pid, words)`, `WindowFacade.enter(pid)`.
- Produces: `take()` handles `{"type":<non-empty string>,"pid":<integer>}` → `window.type(pid, words)`, counted `typed`
  or `typeNotFound`; `{"enter":<integer>}` → `window.enter(pid)`, counted `entered` or `typeNotFound`; a throw from
  either is caught and counted `typeNotFound`, the stream goes on; any other shape of either is `skipped`.
  `LINE_BYTES = 65_536`. `stateBody()` adds `types: true` last. The minute line as Global Constraints gives it.

- [ ] **Step 1: Failing tests** (describe `startLoop`):
  - `a words line types into that shell's terminal and an Enter line presses Enter there; one for no terminal is counted`:
    terminals `[101]`; stream `{"type":"Eval words for bravo.","pid":101}`, `{"enter":101}`, `{"type":"x","pid":303}`,
    `{"enter":303}` → `win.typed` `[{ pid: 101, words: 'Eval words for bravo.' }]`, `win.entered` `[101]`; at 60 s the
    log's last line has `1 typed, 1 entered, 2 type not found`.
  - `a words or Enter line out of form is skipped and counted`: `{"type":"","pid":101}`, `{"type":5,"pid":101}`,
    `{"type":"x","pid":"101"}`, `{"type":"x"}`, `{"enter":"101"}`, `{"enter":101.5}` → nothing typed or entered;
    `6 lines skipped`.
  - `a words line VS Code refuses is counted not found, and the stream goes on`: a window whose `type` throws; then a
    `{"show":101}` is still shown; `1 type not found`.
  - `the state says it types`: every posted body ends `"focused":…,"types":true}` (update the two existing body
    assertions at the state-sending tests).
  - Change `a line %s ends the stream…` to 64 KiB: a padded show line of 65,535 bytes plus its newline is taken; `over
    64 KiB` (`'x'.repeat(65_536)` + newline) and `64 KiB with no newline` end the stream, counted skipped.
  - Every existing expected minute line gains `0 typed, 0 entered, 0 type not found, ` before its page keys.
- [ ] **Step 2:** `cd cli && npx vitest run ../plugins/harness-device-vscode/src/loop.test.ts` → FAIL.
- [ ] **Step 3:** Implement in `loop.ts`. `LINE_BYTES` comment: the devices' longest words line, 20,000 characters as
  JSON (spec); an older extension's 1 KiB is why the devices write words only to a window that says `types`.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/devices/vscodeExtensionTypes.spec.ts` → PASS.
- [ ] **Step 5: README.** "What it does": a **Voice** bullet (the dial's words typed into that session's terminal, then
  Enter, when the devices say so, only at the agent's prompt and with it in front there). "What it never does": the
  first bullet now says it types only the dial's words, then Enter as a line of its own, into the terminal the devices
  name, and PageUp/PageDown as before; the "Nothing leaves the computer" bullet adds "and that it can type".
- [ ] **Step 6:** Commit red, then green (the README with the green).

### Task 3: The devices keep each window's `types`; `canType`

**Files:** Modify `cli/src/cable/hosts/vscodeTerminals.ts`, `cli/src/services/devices.ts` (one line: `platform:
apps.platform` in `vscodeStreams`' deps), `plugins/harness-device-vscode/gate/realVscode.gate.ts` (its `vscodeStreams`
deps gain `platform: process.platform`; the gate is not run here); Test `cli/src/cable/hosts/vscodeTerminals.spec.ts`.
**Depends on:** none. **Effort:** high. Held-out: never open `heldOut.ts`, VH*/UH* or `dialAppEvalHeldOut.e2e.ts`.

**Interfaces:**
- Produces:
  - `VscodeTerminalsDeps.platform: NodeJS.Platform` (required).
  - `VscodeTerminals.canType(agentPid: number): boolean`: the agent's terminal is held now (`terminalOf`) by a window
    whose latest state said `"types":true`.
  - Each `Window` keeps `types: boolean` from its latest state (`message.types === true`), set before its reindex; a new
    stream of a reused id starts `false`. `tell()`'s string per agent is `` `${window} ${shell}${types ? ' types' : ''}` ``,
    so a change of `types` tells `changed`.

- [ ] **Step 1: Failing tests** (new describe `a window that types`; the spec's `harness()` takes `platform`, default
  `'darwin'`, and passes it):
  - `canType is true only for an agent whose terminal a window holds and whose latest state said "types":true`: W1
    holds 700 (agent 900): states with no `types`, `types: false`, `types: 'yes'` → false; `types: true` → true; W2's
    later state listing 700 with no `types` → false; an agent in no window → false.
  - `a window's types changing tells changed once, as a change of its terminals`: a state without, then the same with
    `types: true` → `changed` twice in all; that state again → no more.
  - `a reused window id's new stream starts not typing` (Review Focus 4): W1 with `types: true`, its stream replaced by a
    new open of W1 → `canType(900)` false until the new stream's state says `types: true`.
  - Extend `a state is 1 KiB at most…`: 32 terminals of the largest pid with `"types":true` fit.
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/hosts/vscodeTerminals.spec.ts -t 'a window that types'` → FAIL.
- [ ] **Step 3:** Implement; module doc gains a paragraph on `types` (an older extension ends its stream on a line of
  1 KiB: the devices write words only where a window says it types).
- [ ] **Step 4:** `npx vitest run src/cable/hosts/vscodeTerminals.spec.ts` → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit red, then green.

### Task 4: `VscodeTerminals.type`: cleaned words, guard, settle, guard again, Enter

**Files:** Modify `cli/src/cable/hosts/vscodeTerminals.ts`; Test `cli/src/cable/hosts/vscodeTerminals.spec.ts`.
**Depends on:** 3 (`types`, `platform`, the harness's `platform`). **Effort:** xhigh. Held-out: never open
`heldOut.ts`, VH*/UH* or `dialAppEvalHeldOut.e2e.ts`.

**Interfaces:**
- Consumes: `MAX_TEXT`, `CONTROL` (`orca.ts`); `INJECT_PASTE_DELAY_BASE_MS`, `INJECT_PASTE_DELAY_MAX_MS`
  (`lib/submitTiming.ts`); `parentChain` (`scannedApp.ts`); `deps.foreground`, `deps.processes`, `deps.after`.
- Produces:
  - `export const VSCODE_LINE_MAX_BYTES = 65_536`; `export type VscodeTyped = 'typed' | 'background' | 'failed'`.
  - `VscodeTerminals.type(agentPid: number, words: string, atPrompt: () => boolean): Promise<VscodeTyped>`, never
    rejects:
    1. Words: every `CONTROL` match → `' '`, every lone surrogate (`/\p{Cs}/gu`) → `'�'`. Empty or over `MAX_TEXT`
       characters → `failed`, nothing read.
    2. `terminalOf(agentPid)` in a window that types, else `failed`. One send a shell at a time: another under way for
       that shell → `failed` at once.
    3. The line `{ type: words, pid: shell }`: `Buffer.byteLength(JSON.stringify(line)) + 1 > VSCODE_LINE_MAX_BYTES` →
       `failed`.
    4. The guard. Not `win32`: `deps.foreground(agentPid, shell)` (a rejection is none); none or `tpgid <= 0` →
       `failed`; `pgid !== tpgid` → `background`; the same rule as `guardOf`'s, one helper for both. `win32`: no
       `foreground` call; `deps.processes()` again (a rejection → `failed`); the agent's row must carry the start marker
       its chain was read with (kept per agent beside its chain, dropped with it) and `parentChain(agentPid, table)` must
       hold the shell, else `failed`.
    5. `window.stream.write(line)` false → `failed`.
    6. `deps.after(min(INJECT_PASTE_DELAY_MAX_MS, INJECT_PASTE_DELAY_BASE_MS + floor(words.length / 60)), …)`.
    7. The same window object (`windows.get(id) === window`), still typing, `terminalOf(agentPid)?.shell === shell`, the
       guard again passing, `atPrompt()` true, then `window.stream.write({ enter: shell })` true → `typed`. Any one
       failing → `failed`, no Enter.

- [ ] **Step 1: Failing tests** (new describe `the dial's words typed into a terminal`; `placed()` with W1's state
  `types: true`):
  - `typed: the words line, then after the settle the Enter line, the foreground read before each`: `type(900, 'Eval
    words for bravo.', () => true)`; groups `{ pgid: 900, tpgid: 900 }` → W1's lines `[{ type: 'Eval words for bravo.',
    pid: 700 }]` and a 400 ms timer; drain, run the timer, groups again → lines end `{ enter: 700 }`; resolves `'typed'`;
    `foreground.mock.calls` → `[[900, 700], [900, 700]]`.
  - `every control character is typed as a space and a lone surrogate as U+FFFD; an emoji is kept` (Review Focus 3):
    `'fix it\r\nnow\x1b[2J\tok\u0085'` → words line `'fix it  now [2J ok '`; `'\ud800a\udc00b😀'` → `'�a�b😀'`.
  - `the settle is 400 ms and one more for each 60 characters`: words of 1, 59, 60 and 20,000 characters → timers of 400,
    400, 401, 733 ms.
  - `the longest words fit one line`: `Buffer.byteLength(JSON.stringify({ type: '中'.repeat(MAX_TEXT), pid: 2 ** 31 - 1 }))
    + 1 <= VSCODE_LINE_MAX_BYTES`.
  - `empty words or more than 20,000 characters is failed, with nothing read or written`.
  - `an agent with no terminal now, or whose window does not type, is failed with nothing read or written` (Review
    Focus 4).
  - `a second send for that terminal while one is under way is failed at once; once it ends the next types`.
  - `not in its terminal's foreground group (suspended, in the background, under script or sudo's use_pty) is
    background, with nothing written`: groups `{ pgid: 900, tpgid: 700 }` → `'background'`, W1's lines `[]`.
  - `no foreground answer, one that rejects, or a terminal with no foreground group (tpgid 0, -1) is failed with nothing
    written`.
  - `Windows: no ps; the table read again must give the agent its start and a chain to the shell` (`harness(…, 'win32')`,
    the chain read with start `{ 900: 'w:1' }`): the same table → words, then a third table read after the settle →
    Enter, `'typed'`, `foreground` never called; start `'w:2'` (a reused pid) → `failed`, nothing written; 900's parent
    no longer under 700 → `failed`; a table read that rejects → `failed`.
  - `after the settle no Enter, and failed, when …` (each case its own `it.each` row, the words line written and nothing
    after it): the window's stream ended; W1 opened again under the same id (Review Focus 1); the agent's terminal is
    another shell now; the agent left the foreground; `atPrompt` answers false; the stream still drains a line.
  - `a show written and drained during the settle does not stop the Enter` (Review Focus 2): after the words line, drain;
    `show(W1 700, false)` written; drain; run the timer → Enter written, `'typed'`.
  - `the words and Enter lines carry nothing but the words and the shell`: exact `toEqual` of both lines.
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/hosts/vscodeTerminals.spec.ts -t "the dial's words typed"` → FAIL.
- [ ] **Step 3:** Implement `type` in `vscodeStreams`. Comments name the spec's reasons: the settle (Codex's
  `paste_burst.rs` 120 ms, Claude Code's long input), the guard (a suspended agent leaves the shell in front, where the
  words would run as a command), Windows' start marker (a dead agent's pid may be a new shell's), the lock (two dials'
  words would mix in one prompt).
- [ ] **Step 4:** `npx vitest run src/cable/hosts/vscodeTerminals.spec.ts` → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit red, then green.

### Task 5: The source hands every typer its prompt check

**Files:** Modify `cli/src/cable/hosts/adapter.ts`, `cli/src/cable/hosts/observed.ts`;
Test `cli/src/cable/hosts/observed.spec.ts`.
**Depends on:** none. **Effort:** high. Held-out: never open `heldOut.ts`, VH*/UH* or `dialAppEvalHeldOut.e2e.ts`.

**Interfaces:**
- Produces: `HostAdapter.type?(pane: Pane, text: string, engine: string, atPrompt?: () => boolean): Promise<TypeResult>`;
  doc: the source's check that the agent is still at its prompt in that very pane, for an adapter that waits between its
  words and their Enter: false then sends no Enter.
- `observed.ts` `send` passes `() => live && state is neither needs-you nor working && idleKnown && the first pane whose
  app types is still typer's (same adapter, same id)`; nothing else in `send`'s order changes.

- [ ] **Step 1: Failing tests** (describe `ObservedSource actions`):
  - `the typer is handed the prompt check: true at the prompt, false once a turn starts, the agent waits, ends or moves`:
    a fake adapter whose `type` keeps `atPrompt` and resolves only when the test says; a Codex outside Harness's home at
    its prompt; with its send in flight, the kept `atPrompt()` → true; then, one case each (`it.each`), after
    `turn-start`, `needs-input`, `session-end`, or a hook whose hints give it another pane, the kept `atPrompt()` → false.
  - Pin (passes before the change; V9 at this layer): `a Codex outside Harness's own Codex home, at its prompt, with a
    pane whose app types, is typed there and counted by that adapter: no codex queue`.
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts -t 'prompt check'` → FAIL (`atPrompt` is
  undefined).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/cable/hosts/observed.spec.ts` → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit red, then green.

### Task 6: The VS Code adapter types into a terminal (V9, U11)

**Files:** Modify `cli/src/cable/hosts/vscode.ts`, `cli/AGENTS.md` (the devices row), `cli/src/services/AGENTS.md`
(the `vscode` stream sentence); Test `cli/src/cable/hosts/vscode.spec.ts`.
**Depends on:** 4 (`canType`, `type`, `VscodeTyped`), 5 (`atPrompt`). **Effort:** high. Held-out: never open
`heldOut.ts`, VH*/UH* or `dialAppEvalHeldOut.e2e.ts`.

**Interfaces:**
- Consumes: `VscodeTerminals.canType(agentPid)`, `VscodeTerminals.type(agentPid, words, atPrompt)`.
- Produces: `deps.terminals: Pick<VscodeTerminals, 'terminalOf' | 'show' | 'scroll' | 'pageKeys' | 'canType' | 'type'>`;
  `canType(pane)`: a `term:<pid>` pane and `terminals.canType(pid)`; the panel's pane never. `type(pane, text, engine,
  atPrompt)`: no term pid or no `atPrompt` → `false`, nothing typed; else `typed` → `true`, `background` → `{ refused:
  'Bring it to the front of its terminal.' }`, `failed` → `false`. The same for both editors' adapters.

- [ ] **Step 1: Failing tests** (`recorder()`'s terminals gain `canType` and a `type` that records its arguments and
  answers what the test sets):
  - `canType: a terminal's pane only while the terminals say its window types; the panel's pane and a term id out of
    form never`.
  - `type hands the terminals the agent's pid, the words and the caller's prompt check; typed is true`.
  - `not in front of its terminal: refused with "Bring it to the front of its terminal."; failed is false`.
  - `with no prompt check, or for the panel's pane, nothing is typed: false`.
  - In `the adapter made for Cursor`: `cursor-agent's terminal in Cursor is typed into as VS Code's` (U11).
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/hosts/vscode.spec.ts` → FAIL.
- [ ] **Step 3:** Implement; the module doc gains the typed path (link the spec).
- [ ] **Step 4:** Same → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5: Docs.** `cli/AGENTS.md` devices row, after "which moves Claude Code's fullscreen view": the dial's words
  typed into such a terminal by the extension (`{"type"}`, then `{"enter"}` after a settle of 400 ms and 1 ms more a 60
  characters), only at the agent's prompt, while its window says it types, on macOS and Linux only while the agent is
  that terminal's foreground job (one `ps -o pid=,pgid=,tpgid=` before the words and again before the Enter), on Windows
  only while its process table, read again, still gives it the start it was matched with and a chain to that shell
  (`cable/hosts/vscodeTerminals.ts` `type`); and in the Cursor clause ("as in VS Code, a tap shows the terminal…"), that
  the dial's words are typed there too. `cli/src/services/AGENTS.md`:
  "which terminal to show and scroll" → "which terminal to show, scroll and type the dial's words into".
- [ ] **Step 6:** Commit red, then green (docs with the green).

### Task 7: cursor-agent is at its prompt from its session-start (U11)

**Files:** Modify `cli/src/cable/hosts/observed.ts`; Test `cli/src/cable/hosts/observed.spec.ts`.
**Depends on:** 5 (files). **Effort:** high. Held-out: never open `heldOut.ts`, VH*/UH* or `dialAppEvalHeldOut.e2e.ts`.

**Interfaces:**
- Produces: `Entry.startedAtPrompt?: true`, set by every heard `session-start`, cleared by every `turn-start`, never set
  by the open scan; `idleKnown(e)` also true for `e.agent.engine === 'cursor' && e.startedAtPrompt`.

- [ ] **Step 1: Failing tests** (beside `another engine is typed into only after a hook said its turn ended`):
  - `cursor-agent is at its prompt from its session-start until a turn starts`: engine `cursor` with an Orca handle:
    `session-start` → `{ ok: true }`; `turn-start` → busy; `turn-stop` (graced) → ok; `session-start` → ok;
    `turn-start` → busy.
  - `a cursor session the scan found is busy until a hook: the scan says nothing of its prompt`: scanned → busy; its
    `session-start` → ok.
  - The grok test stays as it is (another engine's session-start is still no prompt).
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts -t 'cursor'` → FAIL.
- [ ] **Step 3:** Implement; the comment names the spec: a turn under way stays busy (cursor-agent's approval prompt
  sends no hook, and a typed Enter would answer it), and whether cursor-agent sends `sessionStart` as its screen opens
  is unverified (Diego's post-merge check).
- [ ] **Step 4:** `npx vitest run src/cable/hosts/observed.spec.ts` → PASS.
- [ ] **Step 5:** Commit red, then green.

### Task 8: The dial shows a host's own voice refusal

**Files:** Modify `cli/src/cable/cableSession.ts`; Test `cli/src/cable/cableSession.spec.ts`.
**Depends on:** none. **Effort:** medium. Held-out: never open `heldOut.ts`, VH*/UH* or `dialAppEvalHeldOut.e2e.ts`.

**Interfaces:**
- Produces: the session's host interface, beside `capsOf`: `voiceRefusal?(agentId: string, opts?: { apps?: boolean }):
  string | undefined` — a sentence of the agent's own app for words no route reaches, said in place of the generic one.
  The refusal before audio uses `this.host.voiceRefusal?.(agentId, this.asItself) ?? <today's sentence>`.

- [ ] **Step 1: Failing test** (describe `what the dial cannot do for an agent`): `voice to an agent whose host has a
  sentence of its own answers that sentence on voice.end, with no transcription`: `caps({ voiceRefusal: (id) => (id ===
  'a1' ? "Voice can't reach Cursor's agent. Type in Cursor." : undefined) })` → `voice.error` with that message;
  `transcribe` not called. `voice to an observed agent keeps no audio…` stays green (no sentence → today's).
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/cableSession.spec.ts -t 'sentence of its own'` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/cable/cableSession.spec.ts` → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit red, then green.

### Task 9: Cursor's own agent says why (U10): adapter → source → host

**Files:** Modify `cli/src/cable/hosts/adapter.ts`, `cli/src/cable/hosts/vscode.ts`, `cli/src/cable/hosts/types.ts`,
`cli/src/cable/hosts/observed.ts`, `cli/src/cable/cableHost.ts`, `cli/AGENTS.md` (one clause); Test
`cli/src/cable/hosts/vscode.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`, `cli/src/cable/cableHost.spec.ts`.
**Depends on:** 6 (files), 7 (files), 8 (the host method's name and signature). **Effort:** high. Held-out: never open
`heldOut.ts`, VH*/UH* or `dialAppEvalHeldOut.e2e.ts`.

**Interfaces:**
- Produces:
  - `HostAdapter.voiceRefusal?(place: Place): string | undefined`: its own fixed sentence for an agent at that place
    whose words no route of its reaches.
  - `vscode.ts`: one predicate for Cursor's own agent (`place.app === 'cursor' && place.engine === 'cursor' &&
    !place.hints.TERM_PROGRAM`), used by `inTerminal` and by the Cursor adapter's `voiceRefusal`, which answers `Voice
    can't reach Cursor's agent. Type in Cursor.` for it and undefined otherwise; VS Code's adapter has none.
  - `HostSource.voiceRefusal?(agent: HostAgent): string | undefined` (`types.ts`).
  - `observed.ts`: `voiceRefusal(agent)`: undefined unless the entry lives, actions exist and its capabilities give no
    voice; then the first sentence of `actions.adapters`, in order, for the entry's place. The place `locate` builds is
    extracted into one private `placeOf(entry)` both use.
  - `cableHost.ts`: `voiceRefusal(agentId: string, opts: { apps?: boolean } = {}): string | undefined`: the entry
    `onMachine(agentId, opts)` finds, asked of its source (`source.voiceRefusal?.(agent)`), as `capsOf` reads caps;
    undefined with no entry.

- [ ] **Step 1: Failing tests:**
  - `vscode.spec.ts` (`the adapter made for Cursor`): `a sentence for Cursor's own agent alone: none for cursor-agent with
    TERM_PROGRAM, Claude Code, Codex, its panel, or any agent of VS Code's adapter`; Review Focus 5: `a place with no
    hints (a session the scan found) is Cursor's own agent's; the same place with TERM_PROGRAM is not, and has its term
    pane`.
  - `observed.spec.ts`: `an agent with no voice says its first adapter's sentence; one with voice, an ended one, or one
    whose adapters have none, says none` (fake adapters: a sentence-giver after one without).
  - `cableHost.spec.ts`: `voice refusal comes from the agent's source with no window, and is undefined on a window's tab
    or for an agent no source lists`.
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/hosts/vscode.spec.ts src/cable/hosts/observed.spec.ts
  src/cable/cableHost.spec.ts -t 'sentence|refusal'` → FAIL.
- [ ] **Step 3:** Implement. `cli/AGENTS.md` devices row, beside the Cursor folder sentence: Cursor's own agent takes no
  words, and the dial says `Voice can't reach Cursor's agent. Type in Cursor.` (Cursor documents no way to put words
  into one existing chat).
- [ ] **Step 4:** The three specs → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit red, then green.

### Task 10: Tier A models the extension's `types` and the foreground job

**Files:** Modify `cli/src/testing/dialAppEval/tierA/steps/editor.ts`, `cli/src/testing/dialAppEval/tierA/world.ts`;
Test `cli/src/testing/dialAppEval/tierA/steps/editor.spec.ts` (PM Decision 6). Nothing else under
`cli/src/testing/dialAppEval/`.
**Depends on:** 6, 7 (V9 and U11 turn green only once the route exists). **Effort:** medium. Held-out: never open
`heldOut.ts`, VH*/UH* or `dialAppEvalHeldOut.e2e.ts`, and never read held-out keys in a results file.

**Interfaces:**
- `editor.ts` `report()`: the message handed to the devices' `vscode-state` handler gains `types: true`, as the real
  loop sends it (Task 2); the world's recorded state line is unchanged, so tier A's and tier B's records stay alike.
- `editor.ts` `SHELL_FIELDS`: `['show', 'pid', 'enter']`, so `{"enter":<shell>}` is recorded with the session's key, never
  the modelled machine's pid (the eval plan's Decision 1: no pid of the machine reaches a result). Record only: nothing
  graded reads it.
- `world.ts` `deps()`: `processGroups: async (agent, shell) => (machine.processes.has(agent) &&
  machine.processes.has(shell) ? { pgid: agent, tpgid: agent } : undefined)`: each terminal agent leads its own job,
  which its shell's terminal has in front, as the machine it models starts them. Comment: the spec's Eval section.

- [ ] **Step 1: Red (existing eval):** at this head, `cd cli && DIAL_EVAL_OUT=/tmp/dial-eval-t10-before npx vitest run
  src/testing/dialAppEval/dialAppEval.spec.ts` → passes, and the results' `V9` and `U11` `voice.reached`, `voice.once`,
  `voice.exact` score 0 on `a/darwin`, `a/linux`, `a/win32` (read with `grep` on those scenario ids only).
- [ ] **Step 2: Failing tests** (`editor.spec.ts`, describe `tier A's fake extension`):
  - Every expected `w.states` message gains `types: true` (the first case's, and those of the focus, terminal-close and
    reload cases); every expected `w.lines()` state line stays as it is.
  - New: `an Enter line is recorded with its shell named by its session's key, and is no delivery`: `w.start('a', 'b')`,
    w1 open; `stream.write({ type: 'Eval words for bravo.', pid: w.shell('b') })`, `stream.write({ enter: w.shell('b')
    })`, `stream.write({ enter: 99_999 })` → `w.lines().slice(2)` `[{ line: { type: 'Eval words for bravo.', pid: 'b' }
    }, { line: { enter: 'b' } }, { line: { enter: 'other' } }]` (window `eval-w1-1`); `w.deliveries` `[{ path: 'typed',
    target: 'b', text: 'Eval words for bravo.' }]`; the record holds no pid of `machine.processes`.
- [ ] **Step 3:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/editor.spec.ts` → FAIL (the states lack
  `types`; the Enter line is recorded with a pid).
- [ ] **Step 4:** Make the three edits (`report()`, `SHELL_FIELDS`, `processGroups`).
- [ ] **Step 5:** `npx vitest run src/testing/dialAppEval/tierA/steps/editor.spec.ts` → PASS.
- [ ] **Step 6: Green (eval):** Step 1's command → `matches the baseline` fails with exactly one line, `stale baseline:`
  naming V9's and U11's `voice.reached`, `voice.once` and `voice.exact` on `a/darwin`, `a/linux` and `a/win32` (18 keys)
  and nothing else: no `regression`, no `missing`, no `held out` line. Any other line: stop and report it to the main
  session.
- [ ] **Step 7:** Commit red (the spec), then green (the stale baseline is Task 12's).

### Task 11: Tier B records the typed line

**Files:** Modify `cli/e2e/harness/vscodeWindow.ts`, `cli/e2e/harness/editorWindow.ts`, `cli/e2e/harness/appEvalEditor.ts`;
Test `cli/src/testing/dialAppEvalTierBEditor.spec.ts` (outside `dialAppEval/`, one new case; PM Decision 6).
**Depends on:** 1 (`WindowFacade.type` and the fake's). **Effort:** medium. Held-out: never open `heldOut.ts`, VH*/UH*
or `dialAppEvalHeldOut.e2e.ts`.

**Interfaces:**
- `vscodeWindow.ts`: the window's `type` prints `{"typed":<words>,"pid":<pid>}`, then answers the fake's; header lists
  the line.
- `editorWindow.ts`: `Printed` gains `typed?: string` (`pid` is there).
- `appEvalEditor.ts`: `export function windowTyped(keyOf: (pid: number) => SessionKey | undefined, deliver: (d: Omit<Delivery,
  'at'>, at: number) => void): (printed: Printed, at: number) => void`: a printed `typed` line → `deliver({ path:
  'typed', target: keyOf(pid) ?? null, text: typed }, at)`; nothing else. `openWindow` adds
  `loop.onLine(windowTyped((pid) => keyOfShell(state, pid), (d, at) => world.deliver(d, at)))`. The header's "the
  extension types none" becomes the typed path.

- [ ] **Step 1: Failing test** (describe `tier B's editor windows`; the untyped import gains `windowTyped`): `a typed
  line is a typed delivery to the session whose shell it names, at its time; one for a shell no session has goes to
  none`: printed `{ typed: 'Eval words for bravo.', pid: 41_002 }`, `{ show: 41_001 }`, `{ typed: 'x', pid: 41_999 }` at
  100, 101, 102 → deliveries `[{ path: 'typed', target: 'b', text: 'Eval words for bravo.' } at 100, { path: 'typed',
  target: null, text: 'x' } at 102]`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEvalTierBEditor.spec.ts -t 'typed'` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/testing/dialAppEvalTierBEditor.spec.ts` → PASS.
- [ ] **Step 5:** Commit red, then green.

### Task 12: The baseline

**Files:** Modify `cli/src/testing/dialAppEval/baseline.json` (regenerated, never hand-edited).
**Depends on:** 2, 9, 10, 11 (and through them every task). **Effort:** xhigh. Held-out: never open `heldOut.ts`, VH*/UH*
or `dialAppEvalHeldOut.e2e.ts`; read held-out results as counts only.

- [ ] **Step 1: Rebase first when due** (PM Decision 1): if `feat/dial-eval-orca` or `feat/dial-eval-iterm2` merged to
  `origin/main`, rebase this branch onto `origin/main`, resolve `tierA/` conflicts keeping both sides' models, and rerun
  Tasks 10's and 11's checks.
- [ ] **Step 2: Red (existing):** `cd cli && npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts` → `matches the
  baseline` FAILS with Task 10's `stale baseline` line alone.
- [ ] **Step 3: The baseline run on this Mac:** `cd cli && git show origin/main:cli/src/testing/dialAppEval/baseline.json
  > /tmp/dial-eval-main-baseline.json && caffeinate -i env TMPDIR=/tmp DIAL_EVAL_OUT=/tmp/dial-eval-voice npm run
  eval:dial-apps -- --update-baseline` → `baseline written`, exit 0. **A wrong-session send (`Gate: failed`), or a test
  failing on the network guard: stop and report; nothing is committed.**
- [ ] **Step 4: Nothing fell** (Verification check 4's script) → exit 0, `fell: none; held out fell: 0`, and `rose:`
  holds V9's and U11's `voice.*` on `a/darwin`, `a/linux`, `a/win32` and `b/darwin`. A key that fell is a bug on this
  branch: do not commit; report the key (a main-set one) or the count (held out) and return it to the task that owns
  the change.
- [ ] **Step 5:** `npx vitest run src/testing/dialAppEval/ src/testing/dialAppEvalTierB.spec.ts
  src/testing/dialAppEvalTierBEditor.spec.ts` → PASS, `matches the baseline` included; `npm run typecheck` → PASS.
- [ ] **Step 6:** Keep `/tmp/dial-eval-voice/report.md` for the PR (its score table and Delta). Commit once.

### Task 13: The real-VS-Code gate types a words line and an Enter line

**Files:** Modify `plugins/harness-device-vscode/gate/realVscode.gate.ts` (one new case, and its header's last sentence).
The driver (`gate/driver/altScreenApp.cjs`, `run.cjs`) is unchanged: its `app` ask and the app's byte record already do
what the case needs.
**Depends on:** 2 (the extension takes the two lines; the gate packs the extension built from this tree), 3 (files:
Task 3 edits this file's `vscodeStreams` deps). **Effort:** medium. Held-out: never open `heldOut.ts`, VH*/UH* or
`dialAppEvalHeldOut.e2e.ts`.

**This task's own check cannot be run on this Mac.** The case runs only inside `npm run test:vscode`, which downloads
and starts a real VS Code, and a downloaded VS Code still writes into the real app's Crashpad and Sentry folders (PM
rule since 2026-11-19; spec PM Decision 6). The task is test-only code for that gate. Its red, on a VM at the head
before Task 2, would be `timed out waiting for the words in the record` (an extension that skips the words line); it is
not run. What runs here is below (Steps 2-3): no repo type-check or lint reads `gate/` (`cli`'s `tsc` reads `src/`,
`vscodeExtensionTypes.spec.ts` reads the extension's `src/`), so the check is Vitest collecting the file, plus the
gate's helper unit tests. The case adds no helper. The gate's run is Verification check 8, after the merge.

**Interfaces:**
- Consumes: the window's stream as the gate holds it (`opened[0]!.stream.write(line): boolean`), the driver's
  `ask('app', { node, script, record })`, `shellStarts`, `until`, `inside`, `changed`; the wire lines exactly as in
  Global Constraints (`{"type":<words>,"pid":<shell>}`, `{"enter":<shell>}`).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the case**, after `a page line presses one PageUp…` and before `VS Code exits with code 0…`:
  `a words line reaches the terminal as plain keys, and an Enter line then sends one CR alone`.
  - A terminal of its own: the alt-screen app with a new record `join(root, 'typed.bin')` (`inside` it, written empty
    first), its start kept in `shellStarts`; wait for a state listing it. The app turns on bracketed paste, so VS Code
    would wrap a paste in `ESC[200~`…`ESC[201~` there.
  - The record watched as the channel file is in the scroll case (`watch` of the file, `watchFile` at 250 ms on
    Windows), each change calling `changed`; the watch stopped when the case ends, pass or fail.
  - The gate writes the lines itself, as the page case writes its page line: no agent, process table or guard
    (those are Task 4's, in `vscodeTerminals.spec.ts`). `const WORDS = 'Eval words for bravo, café 中文.'` (non-ASCII, so
    its UTF-8 bytes are pinned).
  - `expect(opened[0]!.stream.write({ type: WORDS, pid: app })).toBe(true)`; `until('the words in the record', …)`
    the record equals `Buffer.from(WORDS)`; then the record holds neither `\x1b[200~` nor `\x1b[201~` and no `\r`.
  - `expect(opened[0]!.stream.write({ enter: app })).toBe(true)`; `until('the Enter in the record', …)` its length
    passes the words'; `expect(readFileSync(record)).toEqual(Buffer.from(`${WORDS}\r`))`: the CR on its own, once.
  - Header: "A page key's bytes are read…" becomes "A page key's bytes, and the dial's typed words and their Enter, are
    read…".
- [ ] **Step 2: Collected, nothing launched:** `cd cli && npx vitest list --config vitest.vscode.config.ts
  ../plugins/harness-device-vscode/gate/realVscode.gate.ts` → lists the new case among the file's seven, exit 0. `list`
  runs no hook and no case: VS Code is downloaded and started only in `beforeAll` and the cases.
- [ ] **Step 3:** `npx vitest run ../plugins/harness-device-vscode/gate/` (`cleanup.test.ts`, `throwawayApp.test.ts`:
  the default config, which never includes `*.gate.ts`) → PASS.
- [ ] **Step 4:** Commit once (test-only code for a gate not run here; the commit message says so).

---

## Verification

**Isolation** is the repo's own (`cli/AGENTS.md` rule 6, `cli/e2e/harness/daemon.ts`): each `IsolatedDaemon` has a
throwaway root, home, data folder and devices socket, a private tmux server, the in-memory fake backend with a made-up
machine and account, the recording `open` (`HARNESS_OPEN_BIN`), its own `HARNESS_VSCODE_BIN` and `HARNESS_CURSOR_BIN`
inside its root, the fake editors (Node under a bundle in the throwaway home) and the network guard in every process.
Tier A runs in one Vitest process on fake timers with stand-ins for every program (`dialAppEval.spec.ts` fails a case
that starts any other). The everyday daemon (18473), a real or renamed VS Code or Cursor, Claude Code, Codex,
`~/.vscode`, `~/.cursor`, `~/.claude` and `~/.codex` are never reached; every account is the fake backend's; nothing
touches production.

1. **Tier A, every platform branch (a/darwin, a/linux, a/win32), on this Mac** at the final head: `cd cli && npx vitest
   run src/testing/dialAppEval/`. Seen: all pass, `matches the baseline` green, the tier A spec under 60 s. PR CI's
   `cli-tests` runs the same on Linux against this baseline; a difference there is a determinism bug.
2. **Tier B on this Mac (macOS), by the tester:** `cd cli && caffeinate -i env TMPDIR=/tmp npx vitest run --config
   vitest.e2e.config.ts e2e/dialAppEvalVscode.e2e.ts e2e/dialAppEvalCursor.e2e.ts e2e/dialAppEvalHeldOut.e2e.ts
   e2e/dialVscode.e2e.ts`. Seen: the four pass (`dialVscode.e2e.ts` holds the loop's minute line and 64 KiB lines), each
   eval file under about 6 minutes, no wrong send, no network reached. No repo workflow runs macOS e2e files.
3. **The whole eval with the baseline** is Task 12's Step 3 (`caffeinate -i env TMPDIR=/tmp
   DIAL_EVAL_OUT=/tmp/dial-eval-voice npm run eval:dial-apps -- --update-baseline` from `cli/`). Seen: exit 0; the
   report's four rows, `Gate: passed`, `Not covered: tier B on Windows`.
4. **Merge criteria**, from that run (`cd cli` then):

   ```bash
   node --input-type=module -e '
   import { readFileSync, readdirSync } from "node:fs"
   const out = "/tmp/dial-eval-voice"
   const before = JSON.parse(readFileSync("/tmp/dial-eval-main-baseline.json", "utf8")).checks
   const heldOut = (key) => /^[ab]\/\w+\/[A-Z]+H\d+\//.test(key)
   const now = new Map()
   for (const f of readdirSync(out).filter((n) => /^results-[ab]-\w+\.json$/.test(n)))
     for (const r of JSON.parse(readFileSync(`${out}/${f}`, "utf8")).results)
       if (!(r.tier === "b" && r.timed)) now.set(`${r.tier}/${r.platform}/${r.scenario}/${r.check}`, r.score)
   const moved = (up) => [...now].filter(([k, s]) => k in before && (up ? s > before[k] : s < before[k])).map(([k]) => k)
   const say = (keys) => `${keys.filter((k) => !heldOut(k)).sort().join(", ") || "none"}; held out: ${keys.filter(heldOut).length}`
   console.log(`fell: ${say(moved(false))}`)
   console.log(`rose: ${say(moved(true))}`)
   process.exit(moved(false).length > 0 ? 1 : 0)'
   ```

   Merge only when: exit 0, so no untimed check of any app, main set or held out, fell in any subset (a timed tier B
   entry may move between its latency bands, `docs/plans/2026-11-21-dial-app-eval-design.md`: noise, not a drop);
   `Gate: passed` (0 wrong-session sends); the report's VS Code and Cursor scores above the baseline report's 73 and
   70.8, and above it in `a` and in `b/darwin` (expected D5 50 → 100 and 33.3 → 66.7); the Claude app's and the ChatGPT
   app's `a` rows equal the baseline report's, their `b/darwin` rows moved by timed entries alone; `baseline.json`
   regenerated in the same PR.
5. **Local gates PR CI does not run**, at the final head from a clean tree, on this Mac: `cd cli && npm run typecheck`;
   the touched specs (`src/cable/hosts/vscodeTerminals.spec.ts`, `vscode.spec.ts`, `observed.spec.ts`,
   `src/cable/cableSession.spec.ts`, `cableHost.spec.ts`, `src/devices/vscodeExtensionTypes.spec.ts`,
   `../plugins/harness-device-vscode/src/`, `src/testing/dialAppEvalTierBEditor.spec.ts`); then `python3
   scripts/local-checks.py --run`, which runs `npm run test:core` (`src/services/devices.ts` changed: 100% per file) and
   prints the fence for the PR body. Also `npx vitest run ../plugins/harness-device-vscode/gate/` and Task 13's
   `vitest list` (both launch nothing). `npm run test:vscode` (required when the extension changes,
   `docs/validation-and-release.md`) is **waived for this PR** (spec PM Decision 6): it downloads and runs a real VS
   Code, and a downloaded VS Code still writes into the real app's Crashpad and Sentry folders (PM rule since
   2026-11-19), so it never runs on this Mac. It runs after the merge (check 8).
6. **PR CI, automatic, no extra runs:** `cli-typecheck` and `cli-tests`; `linux-e2e` (the five eval e2e files, as the
   eval's paths changed, and the canary, as `cli/e2e/harness/` changed; Linux tier B is gate-only); `dial-hosts` (all of
   `cli/src/cable/hosts/`); `windows-e2e` x64 (`cli/src/cable/`, `plugins/harness-device*/`). Seen: `ci/required` green.
7. **PR body:** the report's score table and Delta under "Baseline delta", check 4's two lines, the red-then-green
   commits, check 5's fence; platforms: macOS in both tiers, Linux in tier A and tier B (gate-only), Windows in tier A
   by injection and `windows-e2e`; gaps: Windows tier B, Linux tier B baseline entries, U10 red by design. Notes, in
   these words or close: **the Windows gap**: the settle is a fixed wait where `docs/windows-rules.md` asks to see the
   paste land, since the devices cannot read an editor terminal's screen; **`npm run test:vscode` waived**: a
   downloaded VS Code still writes into the real app's Crashpad and Sentry folders (PM rule since 2026-11-19), so it was
   not run on the author's Mac; Task 13's new case was collected but not run, and the gate is listed for Diego or Ken
   after the merge (check 8).
8. **After merge** (listed in the PR body as checks for them):
   - **On a disposable VM, by Diego or Ken:** `cd cli && npm run test:vscode` on the merged head (on Windows with
     `HARNESS_EXE_BIN` set, as the gate's `beforeAll` asks). Seen: every case passes, Task 13's included (the words as
     plain keys, no `ESC[200~`/`ESC[201~`, then one CR), and the run's clean-up leaves nothing. No repo workflow runs
     this gate (`docs/validation-and-release.md`: "nowhere automatically").
   - **By Diego himself** (his own machine and editors, his eye):
     - VS Code's and Cursor's `Terminal.sendText` never wrap text in a bracketed paste: in each editor, a Codex in the
       integrated terminal at its prompt; speak to it from the dial; the words arrive as typed text (no `[Pasted
       text]`, no paste markers) and are submitted once. Once the gate above has passed, VS Code's half is covered by
       it; Cursor's half stays his.
     - cursor-agent sends `sessionStart` when its screen opens: open `cursor-agent` in a Cursor terminal and, before
       typing anything, speak to it from the dial; the words reach it, not "is busy".
9. **Proposal, not in this PR:** a macOS run of the five eval e2e files on pull requests that change their paths (tier
   B's ratchet is held on macOS alone and no PR CI suite runs macOS), as the eval plan proposed. For the final report:
   U10 option (d), a request for Diego to raise with Cursor: an API to send words to one chat by its id. Nobody is
   contacted from this work.

## Open questions

None. The draft's three are answered in the spec's PM Decision 6 (2026-11-22): tier A's
`editor.spec.ts` and `SHELL_FIELDS` in Task 10, tier B's spec in Task 11, the real-VS-Code gate in Task 13 and
Verification checks 5, 7 and 8, the Windows gap in check 7.
