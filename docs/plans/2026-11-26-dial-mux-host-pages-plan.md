# Dial: a tmux or herdr agent on its terminal app's page and the multiplexer's: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent in a tmux or herdr pane is on its terminal app's page and on the multiplexer's page; follows stay on
the page shown; a pick, a rest or a tap on tmux's or herdr's page brings forward the app that holds the agent's client;
the settle of an app the dial brought keeps that page; VS Code's and Cursor's terminal focus follows a multiplexer
client.

**Architecture:** All in the devices process (`cli/src/cable/`, `cli/src/services/devices.ts`); the core and the
firmware are not touched. One rule, `select.ts pagesOf`, replaces `pageOf` for every reader; the page turn on a follow
(`AppFilter.follow`, `CableHost.followPage`, the `settling` dep) goes; the host opens an agent of tmux's or herdr's page
through its source's tap path (`HostSource.focus`) at a rest and a pick, with a counter of its own as `latest`; the
opener tells the filter it is bringing an app (`OpenDeps.bringing`), and the filter keeps tmux's or herdr's page through
that app's settle. The dial eval's grader and public scenarios read an agent's pages by the same rule.

**Tech Stack:** TypeScript (Node 24), Vitest (unit specs, the tier A eval spec), the e2e harness (isolated daemon,
private tmux server, fake watch and fake `open`), the dial app eval (`npm run eval:dial-apps`).

**Spec:** `docs/plans/2026-11-26-dial-mux-host-pages-design.md` (approved; read it with this plan). Base:
`feat/dial-mux-host-pages` at `fe309088c6`. Replaces the rule of `docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md`.

Paths: `C/` is `cli/src/cable/`, `H/` is `cli/src/cable/hosts/`, `S/` is `cli/src/services/`, `EV/` is
`cli/src/testing/dialAppEval/`, `E2E/` is `cli/e2e/`. Commands run in `cli/`.

## Decisions already made (PM, 2026-11-26): not reopened

1. One rule for every app: a nested (tmux/herdr) agent is on its terminal app's page AND the multiplexer's page,
   including Orca and Rex (`pagesOf`). tmux's pane poll and herdr's focus follow still skip agents whose app is Orca
   (Orca's own `watch-focus` follows its panes).
2. §7 (VS Code/Cursor terminal focus follows a tmux or herdr client) is in this PR; herdr's source keeps one
   last-focused pane id per herdr server in memory, from the `pane.focused` events it already subscribes to.
3. A rest on tmux's or herdr's page brings an app at each rest: accepted.
4. Held-out eval scores may drop only on checks encoding one page per nested agent; the PR lists each drop by
   app/dimension from the report. Any other drop blocks the merge; wrong-session sends stay 0.
5. A tap on an agent whose open (a rest's, a pick's or another tap's) is still running joins that open and answers its
   outcome, running nothing more; this also fixes the double tap (Task 9).

## What this plan decides from the code (read for this plan, not run)

- **`pagesOf` and Herdr.app.** `herdrSource.ts` lists herdr's own rows with `app: 'herdr', host: 'herdr'` and no `nest`;
  Herdr.app's terminals (`hcSource.ts`, and hooked agents in Herdr.app) have `app: 'herdr'` and no `nest` too. Both are
  `['herdr']`. The registry gives a hooked copy's row to the observed source over a listing source (`registry.ts
  strength`), so a herdr row left with `source.id === 'herdr'` is one no hook placed. "Has a client app" (spec §4, §5)
  is therefore, for an entry on mux page `m`: `entry.source.id !== 'herdr'` and (`pagesOf(agent)` has a page other than
  `m`, or `m === 'herdr'` with `agent.app === 'herdr'` and no `nest`: a Herdr.app terminal). One private helper in
  `cableHost.ts`, used by the rest's and the pick's open.
- **"Can be opened" (spec §4 `open.can`)** is what every source already answers as its focus capability:
  `entry.source.capabilities(entry.agent).focus` (observed: `live && actions.canOpen(...)`). No new interface.
- **The open of a rest or a pick is the tap's own path without the tap:** `entry.source.focus(entry.agent, latest)`
  (observed.ts: fresh client read, `placedTab`, `actions.open`, `raiseAfter`), never `openAgent`, which counts a tap,
  ends a waiting Desktop open and tells `tapped`. `latest` is `() => this.brings === mine`, `brings` a counter in the
  host bumped by each rest open and each pick open.
- **`swipeEnded` takes the dial's options too** (`swipeEnded(agentId, how, opts)`): the spec has it check the page again
  at the rest, which needs to know whether that dial shows an app's ring. `cableSession.restOn` passes `this.asItself`
  to both.
- **The landed agent (spec §5)** is computed by the session from the ring it last sent (`lastRing`), as the spec says.
  The host treats an id that is not on the picked page, or none, as a landed agent with no client app (the spec's
  fallback: the page's agent heard from last that has one, by `lastActivityAt`): one path, which also covers a push the
  session held (`holdsStep2`) whose `lastRing` is still the old page's.
- **The 2 s window of §6 is a timer, not a clock.** `AppFilter` has no clock; its time comes through `deps.after`, as the
  settle's does. So `AppFilter.dialBrings()` (no argument) arms `DIAL_BRINGS_MS = 2_000` through `deps.after`; the first
  `front(app)` report while it is armed marks that app's coming settle as the dial's and disarms it. Tests drive it as
  they drive `FRONT_SETTLE_MS`.
- **`AppFilter.showing()` needs its private field renamed** (`showing` → `current`): a field and a method cannot share
  the name.
- **The tab judgement moves whole into `tabSettled(app)`:** `tabSettling` ran before the settle showed a page only so
  `followPage` could turn it; nothing between `settling` and `settled` changes `dialMoves` or `tabReport` (same tick), so
  judging the waiting report in `tabSettled(app)` is the same judgement. `appSettled` calls `tabSettled(app)`.
- **The landed agent's measure line** (`[device] app filter: bring · ok | failed | none`) is the devices' own words, so
  the host tells it through a new wiring callback `appPickBrought(outcome)`; the hold's line (`[device] app filter:
  front · dial`) comes the same way, `AppFilterDeps.dialFront()` → `CableHostWiring.appDialFront()`.
- **§7 needs no change in `vscodeTerminals.ts`'s logic:** it already tells `focused(pid)` with the pid of a listed
  multiplexer client (`place()`, the nearest listed pid whose chain holds the shell); devices feed it the clients'
  pids from each agent's `vscode-tab`/`cursor-tab` place (`devices.ts` `vscode.agents`). Only its comment ("so the
  devices follow nothing for it") changes. `tmux.ts clientPanes()` already gives tty → pane; the agent's client tty is
  `observed.tabTty(agentId)`, as `tmuxPanes` reads it.
- **The row's `host` (§2)** changes only in `cableHost.machineSnapshot` for an app ring (`list` set): a nested agent shown
  on its app's page carries that page. The single ring of a dial without `appFilter` keeps `a.host` (`E2E/deviceWithoutApp`
  expects `host: 'tmux'` there). `cableSession.reportShown` reads the row's host, so the `dial` stream follows with no
  change.
- **V16** follows V12's shape: tier B only (tier A models no tmux in an editor's terminal), every platform listed as
  V12 is (tier B's VS Code file runs on macOS and Linux only, `E2E/dialAppEvalVscode.e2e.ts`).

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | Every page reader goes through `pagesOf`; a row's host is the page it is shown on | `H/select.ts`, `H/select.spec.ts`, `H/types.ts` (comments), `H/observed.ts` (comment), `H/observed.spec.ts`, `C/cableHost.ts`, `C/cableHost.spec.ts`, `S/devices.ts`, `S/devices.spec.ts` | none | high | `select.spec.ts` "pagesOf: …"; `cableHost.spec.ts` "rows carry the page shown as their host"; `devices.spec.ts` "tmux inside Rex is on Rex's ring" |
| 2 | `AppFilter`: `showing()`, `dialBrings()`, the dial's settle keeps tmux's or herdr's page | `H/appFilter.ts`, `H/appFilter.spec.ts` | none | high | `appFilter.spec.ts` "the first front report within 2 s of dialBrings …" |
| 3 | herdr's source keeps its last focused pane | `H/herdrSource.ts`, `H/herdrSource.spec.ts` | none | medium | `herdrSource.spec.ts` "focusedPane is the pane herdr said took the focus last …" |
| 4 | The opener says before it brings an app | `H/open.ts`, `H/open.spec.ts` | none | medium | `open.spec.ts` "bringing is told just before each open -b and raise …" |
| 5 | Follows stay on the page shown: the page turn goes | `H/appFilter.ts`, `H/appFilter.spec.ts`, `H/types.ts`, `H/select.ts`, `C/cableHost.ts`, `C/cableHost.spec.ts`, `S/devices.ts`, `S/devices.spec.ts` | 1, 2 | xhigh | `devices.spec.ts` "selecting a tmux client's tab keeps iTerm2's page and moves the dial to its agent" |
| 6 | A rest on tmux's or herdr's page brings the agent's app | `C/cableHost.ts`, `C/cableHost.spec.ts`, `C/cableSession.ts`, `C/cableSession.spec.ts` | 2, 5 | xhigh | `cableHost.spec.ts` "a rest on tmux's page with its app behind opens the agent …"; `cableSession.spec.ts` "restOn passes the dial's own options" |
| 7 | A pick of tmux's or herdr's page brings the landed agent's app | `C/cableHost.ts`, `C/cableHost.spec.ts`, `C/cableSession.ts`, `C/cableSession.spec.ts` | 6 | high | `cableHost.spec.ts` "pickLanded opens the landed agent …"; `cableSession.spec.ts` "app.pick answered switched tells pickLanded …" |
| 8 | VS Code's and Cursor's terminal focus follows a tmux or herdr client | `S/devices.ts`, `S/devices.spec.ts`, `H/vscodeTerminals.ts` (comment) | 3, 5 | xhigh | `devices.spec.ts` "focusing the VS Code terminal that holds a tmux client moves the dial to the agent at that client's pane" |
| 9 | The devices wire it: the dial's brings hold the page, herdr's Herdr.app case goes, the measures | `H/open.ts`, `H/open.spec.ts`, `C/cableHost.ts`, `C/cableHost.spec.ts`, `S/devices.ts`, `S/devices.spec.ts` | 2, 4, 7, 8 | high | `devices.spec.ts` "a pick of tmux's page with another app in front brings iTerm2 on b's tab and pane …" |
| 10 | The eval grades an agent's pages by the new rule; public scenarios follow | `EV/types.ts`, `EV/types.spec.ts`, `EV/checks.ts`, `EV/checks.spec.ts`, `EV/catalog.spec.ts`, `EV/itermScenarios.ts`, `EV/itermScenarios.spec.ts`, `EV/vscodeScenarios.ts`, `EV/vscodeScenarios.spec.ts`, `EV/orcaScenarios.ts`, `EV/orcaScenarios.spec.ts` (and `EV/catalog.ts`, `EV/cursorScenarios.ts` only if a scenario there encodes a nested agent) | none | high | `types.spec.ts` "sessionPages: …"; `checks.spec.ts` apart cases |
| 11 | New scenarios I22, I23, I24, V16 | `EV/itermScenarios.ts`, `EV/itermScenarios.spec.ts`, `EV/vscodeScenarios.ts`, `EV/vscodeScenarios.spec.ts`, `EV/catalog.spec.ts`, `E2E/dialAppEvalIterm.e2e.ts` | 10 | high | `itermScenarios.spec.ts` "iTerm2's main ids are I1-I24"; `vscodeScenarios.spec.ts` "V1-V16" |
| 12 | The e2e files say the new rule, and cover a pick and a rest on tmux's page | `E2E/dialTmuxTerminal.e2e.ts`, `E2E/dialHerdrTerminal.e2e.ts`, `E2E/dialHostHerdrKitty.e2e.ts`, `E2E/dialHostHerdrWezterm.e2e.ts`, `E2E/dialHostHerdrX11.e2e.ts` (comment), `E2E/deviceHerdr.e2e.ts` (only if it fails) | 9 | high | the cases named in the task, run on the head after Task 9 |
| 13 | Docs | `cli/AGENTS.md`, `docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md` | none | medium | none: docs, one commit |
| 14 | The baseline | `EV/baseline.json` | 9, 10, 11 | medium | none: generated data, one commit |

**Longest chain:** 1 → 5 → 6 → 7 → 9 → 12 (six tasks; 1 → 5 → 6 → 7 → 9 → 14 is as long). Tasks 1, 2, 3, 4, 10 and 13
start at once; 8 runs beside 6 and 7.

## Global Constraints

- `cd cli && npm ci` first if the worktree has no `node_modules`.
- **The core is not touched:** nothing in `cli/src/core/`, `src/architecture*.spec.ts`, `src/architecture.coreFiles.txt`.
  No firmware, `device-app/`, `desktop/` change.
- **Never read** `EV/heldOut.ts`, `E2E/dialAppEvalHeldOut.e2e.ts`, a held-out scenario's definition, or a held-out row
  of a results or report file; never grep inside them. A report's main tables, its `delta.checks` and its held-out
  counts by app and dimension only. `EV/catalog.spec.ts` may be read and edited (it names IH4 by id; Task 10).
- **Never the person's real apps:** no real VS Code, Cursor, Claude, Codex, Orca, herdr, tmux, WezTerm, kitty, iTerm2
  or cmux; tests use fakes, the e2e harness's isolated daemon and its private tmux server. Never `pgrep -f`, `ps aux`,
  `ps -o args`; never `harness device notify`; no screenshots.
- **This Mac is shared:** a task runs only its own specs and `npm run typecheck`, never while an eval runs. The whole
  tier A spec (`EV/dialAppEval.spec.ts`), `npm run test:core`, any e2e file and `npm run eval:dial-apps` need the PM's go
  (one at a time, `TMPDIR=/tmp`). Until Task 14 the tier A spec's "matches the baseline" case is off its baseline by
  design; run it, when granted, with `DIAL_EVAL_SKIP_RATCHET=1`.
- `EV/baseline.json` is written only by `npm run eval:dial-apps -- … --update-baseline`, never by hand.
- Every behavior task: a red commit (the failing tests), then a green commit. A flipped expectation changes only what
  the new rule says; no test is deleted or skipped without its replacement saying the new rule. `npm run typecheck` when
  a type or signature changes.
- **100% coverage per file** for `S/devices.ts` (`npm run test:core`): every new branch in it gets a case in
  `S/devices.spec.ts`.
- Comments say why and name the spec (`docs/plans/2026-11-26-dial-mux-host-pages-design.md`, Diego 2026-11-26). Names
  follow `docs/naming-system.md`. No new dial copy.
- **Logs:** fixed words and outcomes only, never an agent id, pane id, tty, app or path: `[device] swipe · opened`,
  `[device] app filter: bring · ok | failed | none`, `[device] app filter: front · dial`.
- **Bounds:** nothing new is unbounded: herdr's last focused pane is one value per source (one server); the editor's
  focused client is one tty per editor; the 2 s window is one timer.
- **One way:** `pagesOf` replaces `pageOf` (gone by Task 5); `AppFilter.follow`, `followed`, `held`, the `settling` dep,
  `SwitchCause 'follow'`, `CableHost.followPage`, `CableHostWiring.appSettling`, `devices.ts tabSettling`/`tabJudged`,
  `OpenDeps.herdrApp` and `bundleFor`'s herdr case all go in this PR.
- Platforms: macOS, Linux and Windows build and pass their specs; Windows has no `nest: 'tmux'` (tmux runs only in WSL),
  and a herdr client in Windows Terminal or Alacritty is raised by its process (`ownerWindow`), which tells `bringing`.

## Review Focus

1. **A rest's open still reading the client (up to 700 ms) when a later rest or pick comes:** the older open must bring
   nothing once its `latest()` is false (one counter for rests and picks). Test: Task 6 "a later rest supersedes an
   open still reading", Task 7 "a later pick or rest supersedes a pick's open still reading".
2. **A dial on the window's tab, or a dial without `appFilter`, resting on a tmux agent whose app is behind:** it brings
   no app (today's `hasPane` alone). Test: Task 6 "swipeSwitches … false on the window's tab and for a dial without
   appFilter".
3. **A dial bring whose app is in front already, so no front report comes:** the 2 s window disarms on its own, and the
   person's own switch after it turns the page. Test: Task 2 "a front report after DIAL_BRINGS_MS turns the page".
4. **A nested agent with no client app on tmux's or herdr's page** (detached tmux, herdr's own row, a client in a
   terminal with no page): a rest focuses its pane alone; a pick lands on another agent's app (heard from last) or logs
   `bring · none`. Test: Task 6 "a rest on a detached tmux agent focuses its pane only", Task 7 fallback cases.
5. **The row's host leaking past app rings:** voice refusals, notices, `hostOf` and the single ring keep
   `HostAgent.host`; only an app ring's row of a nested agent on its app's page says that page. Test: Task 1 "the single
   ring and hostOf keep the agent's own host".

---

### Task 1: Every page reader goes through `pagesOf`; a row's host is the page it is shown on

**Depends on:** none. **Effort:** high. **Test that must fail first:** `select.spec.ts` "pagesOf: …" (no such export);
`cableHost.spec.ts` "rows carry the page shown as their host", "an app in front holding only tmux clients shows its
page", "a notice of a nested agent picks its terminal app's page"; `devices.spec.ts` "tmux inside Rex is on Rex's
ring", "a nested agent's usage page is its terminal app's".

**Files:**
- Modify: `H/select.ts` (add `pagesOf`; `AppRings.update`, `AppRings.counts`), `H/types.ts` (the `HostAgent.app`/`nest`
  doc comments name `pagesOf`), `H/observed.ts` (the comment at ~1594), `C/cableHost.ts` (`appRing`, `appOf`,
  `machineSnapshot`), `S/devices.ts` (`usageAgent`, `rexAgents`, `rexPanes`, `tmuxPanes`, `herdrFocused`)
- Test: `H/select.spec.ts`, `H/observed.spec.ts` (its `pageOf` assertions become `pagesOf`), `C/cableHost.spec.ts`,
  `S/devices.spec.ts`

**Interfaces:**
- Produces: `export const pagesOf = (a: HostAgent): string[]` in `H/select.ts`. `pageOf` stays exported with one reader
  left, `cableHost.followPage`; Task 5 deletes both.
- Rule (spec §1): `app = APP_IDS.includes(a.app) ? a.app : UNKNOWN_APP`; no `nest` → `[app]`; with `nest`: `app ===
  UNKNOWN_APP || app === a.nest` → `[a.nest]`, else `[app, a.nest]`. First is the app's page when there is one.
- Readers: `AppRings.update` lists the agent under each page; `counts` counts it under each (`all`, `known`,
  `inFront`); `cableHost.appRing` filters `pagesOf(a).includes(app)`; `appOf` is `pagesOf(agent)[0]`; `usageAgent`'s
  `page` is `pagesOf(row)[0]`; `rexAgents`/`rexPanes` read `pagesOf(agent).includes('rex')`; `tmuxPanes` skips unless
  `agent.nest === 'tmux' && agent.app !== 'orca'`; `herdrFocused` skips unless `agent.nest === 'herdr' && agent.app !==
  'orca'` (decision 1: the same agents as today's `pageOf(...) !== 'tmux'|'herdr'`).
- Row host (spec §2), in `machineSnapshot` for an app ring only: `host: list && a.nest && pagesOf(a)[0] === list.shown
  && list.shown !== a.nest ? list.shown : a.host`.

- [ ] **Step 1: Write the failing tests.**
  - `select.spec.ts` "pagesOf: a plain agent one page; b in tmux in iTerm2 `['iterm','tmux']`; detached tmux
    `['tmux']`; tmux in VS Code `['vscode','tmux']`; an inherited `TMUX_PANE` with no nest its app only; tmux in Orca
    `['orca','tmux']`; tmux in Rex `['rex','tmux']`; a Herdr.app terminal `['herdr']`; appPending with no app and a
    nest `[nest]`".
  - `select.spec.ts` "AppRings: Diego's iTerm2 (a plain, b tmux, c and d herdr) counts iterm 4, tmux 1, herdr 2;
    iTerm2's ring is a, b, c, d in entry order; each page lists an agent once; Ghostty holding only herdr panes has a
    ghostty row; `counts` gives `inFront` to each page; RING_PLACES per page and APP_LIMIT rows still hold".
  - `cableHost.spec.ts`: "rows carry the page shown as their host: b on iTerm2's page `host: 'iterm'`, on tmux's
    `host: 'tmux'`"; "the single ring and hostOf keep the agent's own host (`tmux`)"; "an app in front holding only tmux
    clients shows its page" (front `iterm` settles with b alone: shown `iterm`); "a notice of a nested agent picks its
    terminal app's page" (`appOf(b) === 'iterm'`, a detached one `'tmux'`); "Orca's scope ring keeps tmux in Orca".
  - `devices.spec.ts`: "tmux inside Rex is on Rex's ring"; "a nested agent's usage page is its terminal app's";
    "tmux's pane poll runs for a nest-tmux agent outside Orca and not for one in Orca" and "herdr's focus follow skips
    herdr in Orca" (these two stay green: the guard for the rewrite).
  - `observed.spec.ts`: each `expect(pageOf(x)).toBe(p)` becomes `expect(pagesOf(x)).toEqual(...)` by the rule above.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/select.spec.ts src/cable/cableHost.spec.ts src/services/devices.spec.ts src/cable/hosts/observed.spec.ts`.
  Expected: FAIL (no `pagesOf`; host `tmux`; Rex ring lacks the tmux agent; usage page `tmux`).
- [ ] **Step 3: Implement** the rule and the readers above. Every existing expectation that encoded one page per
  nested agent (counts, rings, "no iTerm2 page") flips to the new rule in the same commit.
- [ ] **Step 4: Run** the same specs and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green: `Dial: a tmux or herdr agent is on its terminal app's page and the multiplexer's`.

### Task 2: `AppFilter`: `showing()`, `dialBrings()`, the dial's settle keeps tmux's or herdr's page

**Depends on:** none. **Effort:** high. **Test that must fail first:** `appFilter.spec.ts` "the first front report
within 2 s of dialBrings settles and keeps tmux's page".

**Files:** Modify `H/appFilter.ts`; Test `H/appFilter.spec.ts`.

**Interfaces:**
- Produces: `export const DIAL_BRINGS_MS = 2_000`; `AppFilter.showing(): string | undefined` (the page shown, read only:
  never counts, never switches); `AppFilter.dialBrings(): void` (arms the window through `deps.after(DIAL_BRINGS_MS)`,
  re-arming cancels the last); `AppFilterDeps.dialFront?(): void` (told when a settle keeps the page for the dial).
- Behavior (spec §6): `front(app)` while armed marks `app` as the dial's and disarms; that app's `settle` still sets
  `settledFront` and calls `settled`; when the page shown then is `tmux` or `herdr` it sets `pickedOnDial = true`, shows
  nothing, and tells `dialFront()`. Any other settle is as today. The private field `showing` is renamed `current`.

- [ ] **Step 1: Write the failing tests** in `appFilter.spec.ts`:
  - "the first front report within 2 s of dialBrings settles and keeps tmux's page": tmux picked, `dialBrings()`,
    `front('iterm')`, advance FRONT_SETTLE_MS → `shown() === 'tmux'`, `settledApp() === 'iterm'`, no `switched`,
    `dialFront` told once; the next `shown()` with iTerm2's agents in front keeps tmux.
  - "… also tmux's page shown by the default" (no pick).
  - "a front report after DIAL_BRINGS_MS turns the page", "the second front report turns it", both with
    `settledApp()` the new app.
  - "on any other page the dial's settle is today's" (iTerm2 shown, dial brings iTerm2: nothing kept, no `dialFront`).
  - "showing() reads the page without switching" (counts change under it: no `switched`).
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/appFilter.spec.ts`. Expected: FAIL (`dialBrings` is not a function).
- [ ] **Step 3: Implement** as in Interfaces. Comment: why the window is a timer (the filter's time comes through
  `after`) and why any app (a Windows Terminal raised has no page, spec §6).
- [ ] **Step 4: Run** the spec. Expected: PASS, the existing cases too.
- [ ] **Step 5: Commit** red, then green: `Dial: the settle of an app the dial brought keeps tmux's or herdr's page`.

### Task 3: herdr's source keeps its last focused pane

**Depends on:** none. **Effort:** medium. **Test that must fail first:** `herdrSource.spec.ts` "focusedPane is the pane
herdr said took the focus last, and none once the attempt ends".

**Files:** Modify `H/herdrSource.ts` (`watchFocus`'s event, `close`); Test `H/herdrSource.spec.ts`.

**Interfaces:**
- Produces: `HerdrSource.focusedPane(): string | undefined`: the bare pane id of the latest `pane_focused` event this
  attempt (already checked by `HERDR_PANE`), cleared in `close()`. `onFocus` is still told as today.

- [ ] **Step 1: Write the failing test**: two `pane_focused` events → the second's id; an event out of form changes
  nothing; the attempt's end (`stop()`, a closed subscription that fails the attempt) → `undefined`.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/herdrSource.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** one private field; comment: one value per herdr server (the source holds one), for the VS
  Code terminal focus of a herdr client (spec §7).
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** red, then green: `Dial: herdr's source keeps the pane herdr focused last`.

### Task 4: The opener says before it brings an app

**Depends on:** none. **Effort:** medium. **Test that must fail first:** `open.spec.ts` "bringing is told just before
each open -b and raise, and never when nothing runs".

**Files:** Modify `H/open.ts`; Test `H/open.spec.ts`.

**Interfaces:**
- Produces: `OpenDeps.bringing?(): void`, called first thing in `forward(bundle)`, `raiseWindow(...)`, the closure
  `ownerWindow` returns, and `pickOf`'s Linux raise closure: so before every `open -b`, Linux raise and Windows raise of a
  tap, a rest's or pick's open, a pick's `bring` and `desktop`. Not called when nothing runs (no bundle, no raise).

- [ ] **Step 1: Write the failing test**: a fake `run` and fake raises record calls in one sequence with `bringing`;
  each of `open` (macOS bundle; a pane `before` then its app; Linux raise; Windows `ownerWindow`), `bring('iterm')`
  (macOS and Linux) and `desktop()` shows `bringing` immediately before its command; `open` of a target with no bundle
  and no raise shows none.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/open.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; comment: the filter takes the next front report as the dial's (spec §6).
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** red, then green: `Dial: the opener says before it brings an app forward`.

### Task 5: Follows stay on the page shown: the page turn goes

**Depends on:** 1 (pages), 2 (`appFilter.ts`). **Effort:** xhigh (the settle's order of events). **Test that must fail
first:** `devices.spec.ts` "selecting a tmux client's tab keeps iTerm2's page and moves the dial to its agent".

**Files:**
- Modify: `H/appFilter.ts` (remove `follow`, `followed`, `held`, the `settling` dep; `shown()` and `settle()` read
  `settledFront` alone), `H/types.ts` (`SwitchCause` without `'follow'`, its comment), `H/select.ts` (delete `pageOf`),
  `C/cableHost.ts` (remove `followPage`, the `settling` wiring, `CableHostWiring.appSettling`, the `pageOf` import),
  `S/devices.ts` (remove the four `cableHost.followPage` calls in `paneAnswered`, `herdrFocused`, `followPrompt`,
  `tabAgent`, and their comments; remove `appSettling`, `tabSettling`, `tabJudged` and its reset at ~3488;
  `tabSettled(app)` judges the waiting report itself; `appSettled` calls `tabSettled(app)`)
- Test: `H/appFilter.spec.ts`, `C/cableHost.spec.ts`, `S/devices.spec.ts`

**Interfaces:**
- Consumes: Task 1's `pagesOf`; Task 2's `AppFilter`.
- Produces: `devices.ts` `tabSettled(app: string): Promise<void> | undefined`: `tabReport?.app === app` → `tabAgent` →
  `cable.followLocal(agentId, 'tab')`; else today's drop with `[device] tab · skipped · not in front`.

- [ ] **Step 1: Write the failing tests** in `devices.spec.ts` (rewrite the describe "selecting a tmux client's tab turns
  the dial to tmux's page" as "… moves the dial on the terminal app's page", spec §3):
  - "selecting a tmux client's tab keeps iTerm2's page and moves the dial to its agent": `[device] tab · moved`, no
    `[device] app filter: switched ·` line, the dial's focus on b, apps shown `iterm`.
  - The same for a prompt submitted to b (the case at ~6464 now expects no `switched · follow`), a tmux pane switched to
    (`tmux: following`), a herdr focus (`herdr`), and a tmux pane inside WezTerm: each ends `localFollowed(cause,
    'moved')`.
  - "a dial a pick holds on tmux's page moves to b there" (no turn either way).
  - "the tab report waiting on an app is judged once at its settle": the existing settle cases (report then settle →
    followed; another app's report dropped with `not in front`; a dial move meanwhile → `echo`) stay green.
  - `appFilter.spec.ts`: the `follow` cases go; "no switch cause is `follow`" over every case's `causes()`.
  - `cableHost.spec.ts`: the `followPage` cases go; their window-view cases that still hold (a settle turning the view)
    stay.
- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts src/cable/hosts/appFilter.spec.ts src/cable/cableHost.spec.ts`.
  Expected: FAIL (the dial turns to tmux's page).
- [ ] **Step 3: Implement** the removals above; `npm run typecheck` finds every leftover reader.
- [ ] **Step 4: Run** the three specs and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green: `Dial: a follow moves the dial on the page shown and turns no page`.

### Task 6: A rest on tmux's or herdr's page brings the agent's app

**Depends on:** 2 (`showing()`), 5 (`cableHost.ts`). **Effort:** xhigh (superseding opens). **Test that must fail
first:** `cableHost.spec.ts` "a rest on tmux's page with its app behind opens the agent through its source …";
`cableSession.spec.ts` "restOn passes the dial's own options to swipeSwitches and swipeEnded".

**Files:** Modify `C/cableHost.ts`, `C/cableSession.ts` (the `CableHost` interface, `restOn`); Test
`C/cableHost.spec.ts`, `C/cableSession.spec.ts`.

**Interfaces:**
- Consumes: `AppFilter.showing()` (Task 2), `pagesOf` (Task 1), `HostSource.focus`, `capabilities(...).focus`,
  `hasPane`, `showPane`.
- Produces:
  - `CableHost.swipeSwitches?(agentId: string, opts?: { apps?: boolean }): boolean` and `swipeEnded?(agentId: string,
    how: 'rest' | 'superseded', opts?: { apps?: boolean }): void` (cableSession interface and `DaemonCableHost`).
  - `CableHostWiring.swiped?: (outcome: PaneSwitch | 'superseded' | 'opened') => void`.
  - In `DaemonCableHost`: `private brings = 0`; `private muxPage(opts): 'tmux' | 'herdr' | undefined` (the page shown
    when `opts.apps` and `this.windowOf(opts) === null` and `filter.showing()` is `tmux` or `herdr`); `private
    openOnPage(entry: HostEntry): Promise<boolean | 'superseded'>` (`const mine = ++this.brings; return
    entry.source.focus?.(entry.agent, () => this.brings === mine) ?? Promise.resolve(false)`); `private
    clientApp(entry: HostEntry, page: string): boolean` (the rule in "What this plan decides").
- Behavior (spec §4): `swipeSwitches` on a mux page: the agent is on it and (`hasPane` or `capabilities.focus`); else
  today's `hasPane`. `swipeEnded('rest')` reads the page again: on a mux page with the agent on it, `hasPane` → today's
  `showPane`; else `openOnPage` → `true` `opened`, `false` `failed`, `superseded` `superseded`; elsewhere today's.

- [ ] **Step 1: Write the failing tests** (`cableHost.spec.ts`, fake sources):
  - "swipeSwitches on tmux's page answers true for an agent there whose app is behind and can be opened; false on the
    window's tab and for a dial without appFilter; on iTerm2's page as today".
  - "a rest on tmux's page with its app behind opens the agent through its source's focus, counts no tap (`tapped` not
    told, `taps` unchanged), and tells `swiped('opened')`".
  - "a rest on tmux's page with its app in front shows its pane (`showPane`), as today".
  - "a later rest supersedes an open still reading": the first `focus`'s `latest()` is false after a second rest; the
    first tells `superseded`.
  - "an agent gone before the rest: `swiped('failed')`, nothing opened"; "a rest on a detached tmux agent focuses its
    pane only" (its source's focus is what runs; no bundle in the fake's open).
  - "a Herdr.app terminal on herdr's page: Herdr in front switches its terminal (showPane), behind opens it".
  - `cableSession.spec.ts` "restOn passes the dial's own options to swipeSwitches and swipeEnded".
- [ ] **Step 2: Run** `npx vitest run src/cable/cableHost.spec.ts src/cable/cableSession.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. Comments: never `openAgent` (it counts a tap), the 400 ms rest and the
  fresh read's cost (spec §4 Cost).
- [ ] **Step 4: Run** both specs and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green: `Dial: a rest on tmux's or herdr's page brings the app holding the agent's client`.

### Task 7: A pick of tmux's or herdr's page brings the landed agent's app

**Depends on:** 6. **Effort:** high. **Test that must fail first:** `cableHost.spec.ts` "pickLanded opens the landed
agent …"; `cableSession.spec.ts` "app.pick answered switched tells pickLanded …".

**Files:** Modify `C/cableHost.ts` (`pickApp`, `pickLanded`), `C/cableSession.ts` (interface, `app.pick`); Test
`C/cableHost.spec.ts`, `C/cableSession.spec.ts`.

**Interfaces:**
- Consumes: Task 6's `openOnPage`, `clientApp`, `brings`.
- Produces: `CableHost.pickLanded?(app: string, agentId: string | undefined): void`; `CableHostWiring.appPickBrought?:
  (outcome: 'ok' | 'failed' | 'none') => void`.
- Behavior (spec §5): `pickApp` tells no `appBrought` for `tmux` or `herdr`. `pickLanded` does nothing for any other
  app; else the landed entry if it is on the page and `clientApp`, else the page's entry with `clientApp` and the
  highest `lastActivityAt`; `openOnPage` it → `ok`/`failed` (none told for `superseded`); no entry → `none`. Session:
  after `syncAgents(true)` for `switched`, `pickLanded(app, lastRing.some(id === desiredFocus) ? desiredFocus :
  lastRing[0]?.id)`.

- [ ] **Step 1: Write the failing tests**:
  - `cableHost.spec.ts`: "a pick of tmux or herdr tells no appBrought; a pick of iTerm2 still does"; "pickLanded opens
    the landed agent through its source's focus, also with its app in front, and tells `appPickBrought('ok')`" (`false`
    → `failed`); "a landed agent with no client app (detached, herdr's own row) or not on the page: the page's agent
    heard from last with one is opened"; "no agent with a client app: nothing opened, `appPickBrought('none')`"; "a later
    pick or rest supersedes a pick's open still reading, and nothing is told for it"; "a pick supersedes a rest's open
    still reading (`swiped('superseded')`)"; "pickLanded of iTerm2's page does
    nothing"; "a pick of herdr landing on a Herdr.app terminal opens it".
  - `cableSession.spec.ts`: "app.pick answered switched tells pickLanded with the recorded agent when the new ring holds
    it, else the ring's first row, after the ring is sent"; "same, ignored and tabs tell nothing".
- [ ] **Step 2: Run** `npx vitest run src/cable/cableHost.spec.ts src/cable/cableSession.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces; comment: Diego's points 2 and 3 (2026-11-26).
- [ ] **Step 4: Run** both specs and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green: `Dial: a pick of tmux's or herdr's page brings the app holding the landed agent`.

### Task 8: VS Code's and Cursor's terminal focus follows a tmux or herdr client

**Depends on:** 3 (`focusedPane`), 5 (`devices.ts`). **Effort:** xhigh (async reads against echoes and newer focuses).
**Test that must fail first:** `devices.spec.ts` "focusing the VS Code terminal that holds a tmux client moves the dial
to the agent at that client's pane".

**Files:** Modify `S/devices.ts` (`editorFocused`, `tmuxFocused`, a per-editor record of the focused client's tty),
`H/vscodeTerminals.ts` (the `focused` doc comment only); Test `S/devices.spec.ts` (the describe "an agent in the
person's tmux whose client is in a VS Code terminal", and herdr's beside it).

**Interfaces:**
- Consumes: `HerdrSource.focusedPane()` (Task 3), `tmux.clientPanes()`, `observed.paneOf(id, '<editor>-tab')` with
  `clientPid`, `observed.tabTty(id)`, `observed.shownAt(id, herdrAdapter.id)`.
- Produces (devices internal): `editorFocused` with no agent at `term:<pid>` finds the agents whose `<editor>-tab` client
  pid is `pid`: tmux (`nest === 'tmux'`, not in Orca) → one `clientPanes()` read, the agent at the pane shown on that
  client's tty (the `tmuxPanes` entry with that tty and pane); herdr → the agent at `herdr.focusedPane()` among them;
  then the same `EditorReport` path as an agent's own terminal (`followEditor`, its echo rules, the report's `at` and
  `moves` taken before the read; a newer focus while the read runs wins). The editor's client tty is kept (one per
  editor, cleared as `lastTabs` is at another app's settle) and `tmuxFocused` reads it for `vscode`/`cursor` in place of
  "the one client of that app, none of two".

- [ ] **Step 1: Write the failing tests**:
  - "focusing the VS Code terminal that holds a tmux client moves the dial to the agent at that client's pane, on VS
    Code's page" (one `list-clients` run; `[device] vscode · moved`-style outcome line as today's).
  - "two tmux clients in two terminals: focusing the other moves the dial to its agent" (V16's shape).
  - "with VS Code settled in front, tmux's pane poll reads the client of the terminal focused last: a pane switch inside
    it moves the dial" (two clients of VS Code: today's poll says none).
  - "a herdr client's terminal focused: the dial moves to the agent at herdr's last focused pane; none known, nothing".
  - "the dial's own terminal show of the last 2 s is not followed back"; "a focus elsewhere while the read runs wins";
    "Cursor alike".
- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts -t "VS Code terminal"`. Expected: FAIL.
- [ ] **Step 3: Implement**; comments: Diego's point 1 named VS Code; the 23/11 known gap closed.
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green: `Dial: VS Code's and Cursor's terminal focus follows a tmux or herdr client`.

### Task 9: The devices wire it: the dial's brings hold the page, herdr's Herdr.app case goes, the measures

**Depends on:** 2, 4, 7, 8. **Effort:** high. **Test that must fail first:** `devices.spec.ts` "a pick of tmux's page
with another app in front brings iTerm2 on b's tab and pane, logs `bring · ok`, and the settle keeps tmux's page".

**Files:**
- Modify: `H/open.ts` (remove `OpenDeps.herdrApp` and `bundleFor`'s herdr case; `running` becomes a map of the open
  under way per agent, which a second open of that agent joins, PM decision 5), `C/cableHost.ts` (`dialBrings()`; the
  filter's `dialFront` dep → `wiring.appDialFront`), `S/devices.ts` (opener: `bringing: () => cableHost.dialBrings()`, no
  `herdrApp`; wiring `appPickBrought` → `[device] app filter: bring · <outcome>`, `appDialFront` → `[device] app filter:
  front · dial`)
- Test: `H/open.spec.ts`, `C/cableHost.spec.ts`, `S/devices.spec.ts` (rewrite the describe "a pick of herdr" at ~9484)

**Interfaces:**
- Consumes: `AppFilter.dialBrings`, `AppFilterDeps.dialFront` (Task 2); `OpenDeps.bringing` (Task 4); `pickLanded`,
  `appPickBrought` (Task 7).
- Produces: `DaemonCableHost.dialBrings(): void` (→ `filter.dialBrings()`); `CableHostWiring.appDialFront?: () =>
  void`.

- [ ] **Step 1: Write the failing tests**:
  - `devices.spec.ts`: "a pick of tmux's page with another app in front brings iTerm2 on b's tab and pane (`open -b`
    iTerm2's bundle, the tab select, the tmux pane), logs `[device] app filter: bring · ok`, and the settle of iTerm2
    keeps tmux's page with `[device] app filter: front · dial` and no `switched` line"; "… no agent with a client app:
    `bring · none`, nothing run"; "a rest on herdr's page with its app behind logs `[device] swipe · opened`"; "a pick of
    herdr with the face on a Herdr.app terminal brings Herdr.app; on c, iTerm2"; "the person's own Cmd-Tab after 2 s
    turns the page".
  - `cableHost.spec.ts`: "dialBrings tells the filter; the dial's settle tells appDialFront".
  - `open.spec.ts`: "a tap on an agent whose open is still running joins it and answers its outcome, running nothing
    more"; "two taps in a row run one open and both answer its outcome" (PM decision 5: `open.ts` `running` becomes a
    map of the open under way per agent).
  - `open.spec.ts`: "bring('herdr') has no Herdr.app special case" (`herdrApp` gone from `OpenDeps`).
- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts src/cable/cableHost.spec.ts src/cable/hosts/open.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement** the wiring and the removals.
- [ ] **Step 4: Run** the three specs and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green: `Dial: the app the dial brings forward keeps tmux's or herdr's page`.

### Task 10: The eval grades an agent's pages by the new rule; public scenarios follow

**Depends on:** none (eval code; graded against the product by Task 14's runs). **Effort:** high. **Test that must fail
first:** `types.spec.ts` "sessionPages: …"; `checks.spec.ts` "apart counts every listed session on its other pages".

**Files:**
- Modify: `EV/types.ts` (`sessionPage` → `sessionPages(s: SessionDef): string[]`, its comment cites the new spec),
  `EV/checks.ts` (`stateParts`, `apartPart`, `ringParts`' call), `EV/itermScenarios.ts`, `EV/vscodeScenarios.ts`,
  `EV/orcaScenarios.ts` (and `EV/catalog.ts`, `EV/cursorScenarios.ts` only if a scenario there has `inTmux`, `inHerdr`,
  `tmux: true`, `place: 'tmux'|'herdr'` or a `tmux`/`herdr` page)
- Test: `EV/types.spec.ts`, `EV/checks.spec.ts`, `EV/catalog.spec.ts`, `EV/itermScenarios.spec.ts`,
  `EV/vscodeScenarios.spec.ts`, `EV/orcaScenarios.spec.ts`

**Interfaces:**
- Produces: `sessionPages(s)`: iTerm2 in tmux `['iterm','tmux']`, in herdr `['iterm','herdr']`; an editor's or Orca's
  with `tmux` `[PAGE[app], 'tmux']`; else `[PAGE[app]]`.
- `stateParts`: a ring on any of the session's pages counts (`pages.includes(ring.page)`).
- `apartPart(check, page, world, w)`: the other pages count exactly the sessions of `check.expect` and `check.apart`,
  each on its pages but `page`: non-editor pages, the sum over ids ≠ `page` equals Σ |`sessionPages(s)` \ {page}|; an
  editor's page, each id's count equals the number of those sessions with that id among their other pages.

- [ ] **Step 1: Write the failing tests**: `types.spec.ts` "sessionPages: …" (the cases above, replacing the two
  `sessionPage` cases); `checks.spec.ts` "apart: iTerm2's ring a, b, c, d with apart none passes on iterm 4, tmux 1,
  herdr 2 and fails on tmux 0"; "tmux's ring b with apart a, c, d passes on iterm 4, herdr 2"; "a state shown on
  iTerm2's ring passes for b"; `catalog.spec.ts` "every iTerm2 ring's apart is every agent of the scenario not on its
  page" (by `sessionPages`), and IH4's case read from this file only: its herdr ring with `iterm 1, herdr 1` now passes
  apart and `herdr 1` alone fails (rename the case to the new rule).
- [ ] **Step 2: Run** `npx vitest run src/testing/dialAppEval/types.spec.ts src/testing/dialAppEval/checks.spec.ts src/testing/dialAppEval/catalog.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement** the grader, then each public scenario, each touched comment naming the new spec:
  - I2, I3, I15: iTerm2's page lists a, b, c, d (`listed('iterm', ['a','b','c','d'])`, `apart: []`); I3's and I15's
    `counted` are `{ iterm: 4, tmux: 1, herdr: 2 }`; selecting b's tab keeps iTerm2's page and moves the dial to b (a
    `focus` check on b, D2, after the select); tmux's and herdr's rings are graded after a `pick` of each (not a
    select). Keep the ids `ring`, `ringKept`, `ringTmux`, `ringHerdr`, `ringKeptTmux`, `ringKeptHerdr`.
  - I6, I7, I13, I14, I17, I19, I21: `listed` and `apart` by the new rule (a nested agent is on iTerm2's page too).
  - I10, I11: the dial follows the pane switch on iTerm2's page (their `listed`/ring checks on `iterm`).
  - V12: the ring on VS Code's page `['a']`, `apart: []` (tmux 1 counted by the rule); title and comment say both pages.
  - O11: `ring(['a','b','c'], { apart: [] })` (tmux 1 counted); comment: tmux's page lists c too.
  - Any other public scenario whose `listed`, `counted` or `ring` encodes one page per nested agent.
  - Each scenario spec's pinned dims or shapes follow; `catalog.spec.ts`'s "own waits" list follows any wait added.
- [ ] **Step 4: Run** the six specs above. Expected: PASS. (The tier A spec is Task 14's.)
- [ ] **Step 5: Commit** red, then green: `Dial eval: an agent in tmux or herdr is graded on its terminal app's page and the multiplexer's`.

### Task 11: New scenarios I22, I23, I24, V16

**Depends on:** 10. **Effort:** high. **Test that must fail first:** `itermScenarios.spec.ts` "iTerm2's main ids are
I1-I24, none held out, 24"; `vscodeScenarios.spec.ts` "VS Code's main ids are V1-V16".

**Files:** Modify `EV/itermScenarios.ts`, `EV/vscodeScenarios.ts`, `E2E/dialAppEvalIterm.e2e.ts` (an `I24` hook beside
`I13`'s: the select names the second tab); Test `EV/itermScenarios.spec.ts`, `EV/vscodeScenarios.spec.ts`,
`EV/catalog.spec.ts` (main ids, `ALL` 123, iTerm2 5 of 29, VS Code 4 of 20, the own-waits list).

**Interfaces (shapes; ids and dims fixed here):**
- I22 (D3, D7), `world: { front: 'other' }`, sessions a (tab 0), b (tmux, tab 1): started; the Apps screen counted;
  `pick` tmux (label `pick`); wait 1 s; `front` iterm (label `front`, the world moves no front app by itself); wait 2 s.
  Checks: `open` b, link false, after `pick` at `front`; `ringKeptTmux` `['b']` apart `['a']` after `front`.
- I23 (D3, D7), front other, sessions a, c and d (herdr, tab 2, splits 0 and 1): started; `pick` herdr; `listed('herdr',
  ['c','d'], ['a'])`; `swipe` d (label `rest`); wait 1 s; `front` iterm (label `front`); wait 2 s; `swipe` c (label
  `restC`); wait 2 s. Checks: `open` d after `rest` at `front`; `ringKeptHerdr` after `front` at `restC`; `openC` c
  after `restC`.
- I24 (D3), front other, sessions a, b (tmux, tab 1): started; `iterm.tab` w1 2; `tmux.attach` b w1 2; counted; `pick`
  tmux; wait 2 s. Check: `open` b, link false, `tab` the second tab's label (as I13's), after `pick`.
- V16 (D2, D1), tiers `['b']`, sessions `vscode('a', { tmux: true })`, `vscode('b', { tmux: true })`: started;
  `editor.window` w1 active a focused; `listed('vscode', ['a','b'])`; `editor.focus` b (label `focus`). Checks: `ring`
  vscode `['a','b']` apart `[]`; `focus` b after `focus`. Probes: `focus` z.
- Each has the usual `z` probes of its kinds; titles in plain words; comments cite the spec.

- [ ] **Step 1: Write the failing tests** (ids, counts, dims, tiers: V16 "tier B only" beside V12, and each scenario's
  shape above).
- [ ] **Step 2: Run** `npx vitest run src/testing/dialAppEval/itermScenarios.spec.ts src/testing/dialAppEval/vscodeScenarios.spec.ts src/testing/dialAppEval/catalog.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement** the four scenarios and I24's tier B hook.
- [ ] **Step 4: Run** the same specs. Expected: PASS.
- [ ] **Step 5: Commit** red, then green: `Dial eval: a pick and a rest on tmux's and herdr's pages bring the client's app`.

### Task 12: The e2e files say the new rule, and cover a pick and a rest on tmux's page

**Depends on:** 9. **Effort:** high. **Test that must fail first:** on the head after Task 9 (PM's go, macOS):
`dialTmuxTerminal.e2e.ts` "… Terminal's page holds B alone", "… with no iTerm2 or Other page", "selecting the client's
tab … turns the dial to tmux's page"; `dialHerdrTerminal.e2e.ts` "… with no Terminal page", "a tab line … turns the dial
to herdr's page". Record each failure in the task's report.

**Files:** Modify `E2E/dialTmuxTerminal.e2e.ts`, `E2E/dialHerdrTerminal.e2e.ts`, `E2E/dialHostHerdrKitty.e2e.ts`,
`E2E/dialHostHerdrWezterm.e2e.ts` ("on no other page" → also on kitty's/WezTerm's page; the row's host on herdr's
page), `E2E/dialHostHerdrX11.e2e.ts` (comment: `pagesOf`; xterm has no page, so herdr's alone, unchanged),
`E2E/deviceHerdr.e2e.ts` (only if a `host === 'herdr'` expectation fails).

- [ ] **Step 1: Rewrite the cases** to the new rule: Terminal's page counts B and the agent (`terminal-app: 2`), tmux's
  1; iTerm2's page holds the scan-found agent; selecting the client's tab keeps Terminal's page and moves the dial to
  the agent (no `switched · follow` line); herdr likewise. Add to `dialTmuxTerminal.e2e.ts`: "with Orca in front a pick
  of tmux's page brings Terminal on the client's tab and the agent's pane, and the dial stays on tmux's page" (the fake
  `open` records Terminal's bundle, the watch gets the select, tmux's active pane is the agent's; the test reports
  Terminal in front within 2 s; `[device] app filter: front · dial`; apps shown `tmux`) and "with Orca in front a rest
  on tmux's page does the same, `[device] swipe · opened`". Keep "with another app in front a swipe changes nothing in
  tmux" (on Orca's page: unchanged) and the privacy cases.
- [ ] **Step 2: Run** on macOS with the PM's go: `npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts e2e/dialHerdrTerminal.e2e.ts e2e/deviceHerdr.e2e.ts`.
  Expected: PASS (herdr's files skip without the herdr binary; say so). The kitty, WezTerm and X11 files run on Linux in
  CI (Verification).
- [ ] **Step 3: Commit** (one commit: tests only, the behavior landed in Tasks 1-9): `Dial e2e: tmux and herdr agents on their terminal app's page and the multiplexer's`.

### Task 13: Docs

**Depends on:** none. **Effort:** medium. **Test that must fail first:** none (docs, one commit).

**Files:** Modify `cli/AGENTS.md` (the devices row), `docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md` (one line
at its top).

- [ ] **Step 1: Edit `cli/AGENTS.md`'s devices row** to the new rule, keeping its style (one long row): remove
  "selecting a tab of an agent in tmux or herdr, or a prompt submitted to one, turns the dial to tmux's or herdr's page
  and holds that page while the app stays in front (the filter's cause `follow`)"; "is on tmux's page (in Orca, on
  Orca's)" and "is on herdr's page (in Orca, on Orca's)" become "is on the page of the app holding its client and on
  tmux's (herdr's) page"; an agent whose client is in no listed app, or inside tmux or Zellij, is "on herdr's page
  alone"; the tmux pane follow and herdr focus follow move the dial "on the page shown" (not "turns it to tmux's page"),
  the tmux poll's client in VS Code and Cursor is "the client of the terminal focused there last"; add: a pick, a rest
  or a tap on tmux's or herdr's page brings the app holding the agent's client (its tab, its pane), the first app in
  front within 2 s of the dial bringing one keeps that page (`[device] app filter: front · dial`), VS Code's and
  Cursor's terminal focus of a tmux or herdr client follows its pane's agent, and the in-memory list gains herdr's last
  focused pane (one a server) and each editor's focused client.
- [ ] **Step 2: Add the pointer line** at the top of the 2026-11-23 design: "Replaced on 2026-11-26 by
  `docs/plans/2026-11-26-dial-mux-host-pages-design.md`: a tmux or herdr agent is on its terminal app's page and the
  multiplexer's, and a follow turns no page."
- [ ] **Step 3: Commit:** `Docs: a tmux or herdr agent is on its terminal app's page and the multiplexer's`.

### Task 14: The baseline

**Depends on:** 9, 10, 11. **Effort:** medium. **Test that must fail first:** none (generated data, one commit).

**Files:** `EV/baseline.json` (written by the eval alone).

- [ ] **Step 1:** With the PM's go and no other eval running: `TMPDIR=/tmp npm run eval:dial-apps -- --tier a --update-baseline`.
  Read the report's main tables and `delta.checks` (held-out: counts by app and dimension only).
- [ ] **Step 2:** Judge by decision 4 (Verification 5). An unexpected drop: `git checkout -- src/testing/dialAppEval/baseline.json`,
  stop and report the keys; the gate's wrong-session sends must be 0 (the run writes no baseline otherwise).
- [ ] **Step 3:** Same for tier B on the next PM turn: `TMPDIR=/tmp npm run eval:dial-apps -- --tier b --update-baseline`.
- [ ] **Step 4:** With the PM's go, `DIAL_EVAL_SKIP_RATCHET` unset: `npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts`
  ("matches the baseline" passes).
- [ ] **Step 5: Commit:** `Dial eval: the baseline after tmux and herdr agents joined their terminal app's page`.

---

## Verification

All local unless named; this Mac is shared: each heavy run below waits for the PM's go, one at a time, `TMPDIR=/tmp`,
and never beside an eval.

1. **Types:** `cd cli && npm run typecheck`. Expected: no error.
2. **Unit specs touched** (no slot needed outside an eval): `npx vitest run src/cable/hosts/select.spec.ts
   src/cable/hosts/appFilter.spec.ts src/cable/hosts/herdrSource.spec.ts src/cable/hosts/open.spec.ts
   src/cable/hosts/observed.spec.ts src/cable/cableHost.spec.ts src/cable/cableSession.spec.ts
   src/services/devices.spec.ts src/testing/dialAppEval/types.spec.ts src/testing/dialAppEval/checks.spec.ts
   src/testing/dialAppEval/catalog.spec.ts src/testing/dialAppEval/itermScenarios.spec.ts
   src/testing/dialAppEval/vscodeScenarios.spec.ts src/testing/dialAppEval/orcaScenarios.spec.ts`. Expected: pass.
3. **Core and services gate** (PR CI does not run it; record it in the PR): `npm run test:core`, 100% per file,
   `src/services/devices.ts` included. PM's go.
4. **End to end on macOS** (isolated daemon, private tmux server, fake watch and fake `open`; no real app): `npx vitest
   run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts e2e/dialHerdrTerminal.e2e.ts e2e/deviceHerdr.e2e.ts
   e2e/deviceHerdrApp.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/dialPaneFocusFollow.e2e.ts
   e2e/dialVscodeFollow.e2e.ts e2e/dialAppFilter.e2e.ts e2e/dialAppFilterOnDial.e2e.ts e2e/dialProApps.e2e.ts
   e2e/dialRex.e2e.ts`, one file at a time if the PM asks. What a person would see in the logs: Terminal's page counts
   the tmux agent, a pick and a rest on tmux's page bring Terminal on the agent's tab and pane, `[device] app filter:
   front · dial`, the dial stays on tmux's page, no `switched · follow`. `dialTmuxTerminal`, `dialHerdrTerminal` and
   `dialAppEvalIterm` are macOS only: PR CI does not run them, so they are recorded in the PR. herdr's files need the
   herdr binary (skip without it: say so); `deviceHerdrApp` needs Herdr Core's binary.
5. **The dial eval on macOS** (fakes only; never `harness device notify`): tier A, then tier B, each its own PM turn,
   through Task 14's commands. Comparison rule (decision 4): from each report's `delta.checks`, a drop is allowed only on
   a check that encodes one page per nested agent (a public scenario rewritten in Task 10, or a held-out check, listed
   by app and dimension from the report's counts, never from its definition); any other drop blocks the merge; the
   gate's wrong-session sends stay 0. The PR lists each allowed drop by app and dimension.
6. **On GitHub (PR CI, automatic):** `linux-e2e` runs the e2e files the PR changes and the dial app eval's six
   (`dialAppEvalClaude`, `Chatgpt`, `Vscode` with V16, `Cursor`, `Orca`, `HeldOut`) on Ubuntu; `dial-hosts` runs the
   kitty, WezTerm and X11 herdr files (`dialHostHerdrKitty`, `dialHostHerdrWezterm`, `dialHostHerdrX11`) on Ubuntu with
   their pinned programs. **By hand:** `.github/workflows/cli-e2e.yml` (workflow_dispatch, `dial_hosts: true`) runs the
   dial hosts' files alone, if the PR's run needs a rerun. Windows: `windows.yml` runs as its paths select (the opener's
   `ownerWindow` path and herdr's Windows client); no tmux there.
7. **Diego's own eye (needs him, his dial and his Mac, after merge and his go):** iTerm2's page lists his tmux and herdr
   agents; picking tmux or herdr with another app in front brings iTerm2 (or the app holding the herdr terminal) on the
   agent; the dial stays on that page. Not run by the flow.

## Open questions

None left. Answered by the PM (2026-11-26), decision 5: a tap on an agent whose rest, pick or tap open is still running
joins that open and answers its outcome; it runs nothing more (Task 9).
