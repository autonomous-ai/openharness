# Dial: tmux and herdr are their own apps on the Apps screen Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** An agent whose own terminal is a tmux or herdr pane is on the tmux or herdr page (in Orca, on Orca's), its
tap, rest and words unchanged, and a tab or prompt follow to such an agent turns the dial to that page. Diego's iTerm2
reads "iTerm2 · 1", "tmux · 1", "herdr · 2".

**Architecture:** Devices process only. Each multiplexer's outer lookup says when it made the agent's terminal (`nest` on
its answer), `firstOuter` passes that on, and `observed.ts` keeps it as `HostAgent.nest` (hooked: the answer; scanned:
`Nested.host`), with `host` set to it. `select.ts pageOf` is the one page rule. `AppFilter.follow` turns and holds a
page; `DaemonCableHost.followPage` calls it and turns a window's view; `devices.ts` calls `followPage` before
`cable.followLocal` for the tab and prompt follows, and judges a tab report waiting on a settle in a new `settling` step,
before the settle shows anything.

**Tech Stack:** TypeScript (Node 24), Vitest unit suites, the e2e harness (isolated daemon, fake dial, private tmux and
herdr servers, fake apps), the dial app eval (tier A spec, tier B e2e files).

**Spec:** `docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md` (read it with this plan). The decisions in the brief of
2026-11-23 are final: `HostAgent.nest?: 'tmux' | 'herdr'` only when the multiplexer's lookup confirms the agent's own
terminal is its pane; nearest multiplexer wins; `host` set to `nest`; `pageOf` = `nest` unless `app === 'orca'`; `app`
keeps meaning the outermost app; tmux inside Herdr.app goes to tmux's page; a follow to a nested agent of the settled
front, with no pick holding, turns the filter with cause `follow` and holds the page until another app settles, a pick,
or a later follow; one cableHost method, called in `devices.ts` before `cable.followLocal`; a waiting tab report makes
the settle show the agent's page directly; with the window open the follow turns the view to `apps`; VS Code's and
Cursor's terminal-focus follow of nested agents is a known gap; Zellij and Rex unchanged; no Windows branch.

## Status after the rebase (2026-11-24)

The branch is rebased on `origin/main` 15ffe68d8c (#4575, the iTerm2 dial eval). Tasks 1 to 9 and 12 landed (head
78e18f103c). Left: 10, 11, 13 and 14 (the first draft's Task 13 is now Tasks 13 and 14).

Tier A on the head (`cd cli && npx vitest run src/testing/dialAppEval`, fakes only): 904 passed, 4 failed; the same files
pass on `origin/main`. "matches the baseline" names only I19's wrong-session send, because `tierAVerdict` returns at the
gate. Graded against `baseline.json`, the same run also drops 47 tier A checks, all from the new grouping: I2, I3, I6, I7,
I10, I11, I13, I14, I15, I17, I20, I21 and the held-out IH2, IH4 and IH5. Their rings and `listed` waits read iTerm2's
page, I17's and IH5's state checks look for the row on iTerm2's page, and I19 leaves its four checks out with a gap ("voice
step 5: the face never showed b"). Tasks 13 and 14 cover each.

What the eval cannot express today:
- a ring check or a `listed` wait on tmux's or herdr's page: `Check` ring's `page` and `Until.page` are `App`, which
  names neither (Task 13);
- the page a state check reads: `checks.ts stateParts` uses `PAGE[session.app]`, which is iTerm2's for a session in tmux
  (Task 13);
- a `listed` wait that also waits for the other pages' counts: `Until` has no `apart`, so a wait for iTerm2's `['a']`
  ends before herdr's second agent is counted, and I2's `ring.apart` then fails (Task 13);
- the person's pick of a page on the dial: both drivers pick the scenario's app at time 0 (`tierA/driver.ts`,
  `e2e/harness/appEvalDriver.ts`), and no step can (Task 14).

## Global Constraints

- Devices process only: `cli/src/cable/`, `cli/src/services/devices.ts`, `cli/e2e/`, `cli/src/testing/dialAppEval/`,
  `cli/AGENTS.md`. Nothing in `cli/src/core/`, `cli/hook/`, `cli/src/architecture.coreFiles.txt` or `devices/`
  (no firmware change).
- Names, used exactly: `Nest` (`'tmux' | 'herdr'`, `types.ts`), `HostAgent.nest`, the lookup answer's `nest`,
  `SwitchCause` `'follow'`, `AppFilter.follow(app, page)`, `AppFilterDeps.settling`, `CableHostWiring.appSettling`,
  `DaemonCableHost.followPage(agentId)`.
- The one new log line form is `[device] app filter: switched · follow`. No line names an app, agent, pane, tty, path
  or session.
- Limits unchanged: `APP_LIMIT` and `RING_PLACES` (16), `OUTER_EVERY_MS` (5 s), `PANES_A_LISTING` (1024),
  `HERDR_CLIENTS_A_LOOKUP` (16).
- Platforms: macOS everything; Linux the same but the tab follow (macOS only today); Windows runs neither tmux nor herdr
  natively, so `nest` is never set and no branch is added.
- Tests never touch the person's tmux, herdr, terminals, Orca, `~/.claude`, `~/.codex` or daemon (18473): fakes in unit
  specs; e2e only through the harness's isolated daemon, private tmux server (`src/testing/isolatedTmux.ts`),
  `PrivateHerdr` with `ownHerdrsOnly`, and fake apps in its throwaway home. Never `harness device notify`, never a
  screenshot.
- Every behavior task: a red commit (the failing test), then a green commit. During a task run only the specs it touches
  (`cd cli && npx vitest run <spec> -t '<name>'`) and `npm run typecheck` when a type or signature changed; full suites
  wait for Verification.
- A flipped expectation in an existing test changes only what the new rule says; every other assertion of that test
  stays, and no test is deleted or skipped.
- From Task 6 until Tasks 10, 11 and 14 land, the e2e files and the eval's iTerm2 scenarios expect the old pages: that is
  expected, and Task 6 does not touch them.
- The eval's names, used exactly: `Page` (`App | Nest`), `pageId(page)`, `sessionPage(session)`, `Until.apart`, the
  step `{ kind: 'pick'; page: Page }`, and in `itermScenarios.ts` the check ids `ringTmux`, `ringHerdr`, `ringKeptTmux`
  and `ringKeptHerdr` (iTerm2's own page keeps `ring` and `ringKept`, so its baseline keys stay).
- The eval never weakens: a ring that mixed pages becomes one ring per page, each with every agent the old one expected
  on that page and `apart` counting the rest exactly; taps, rests, words, the wrong-session gate and every probe stay.
- Comments say why (cite Diego's decisions of 2026-11-23); names and copy follow `docs/naming-system.md`; English.

## What this plan decides from the spec's words

- **Where a lookup confirms.** tmux's and herdr's lookups answer `{}` both when their multiplexer did not make the
  caller's terminal (after an async read) and when it did but no client was found, so `nest` is put on the answer inside
  each lookup at the point it confirms: tmux once the pane is the person's, holds the caller and `readPtyOwner` names
  tmux; herdr once `readPtyMaker` names herdr. From there it stays on the answer whatever the client step gives: found,
  none, or a step not read.
- **`firstOuter`:** the answer's `nest` is the first lookup's, else the second's.
- **The settle with a waiting tab report:** the filter tells a new `settling(app)` once `settledApp()` names the app and
  before the settle shows anything; `devices.ts` judges the waiting report there and calls `followPage`; its
  `cable.followLocal` stays in `settled`, after the view turns, as today. `switched` still comes before `settled`
  (`cableHost.spec.ts` "appSettled ... after appSwitched" holds).
- **A follow to an agent on its app's own page** turns nothing: it ends a hold, and the next read's front rule shows the
  app with `front`, as today. `follow` is the cause only for a nested agent's page.
- **The follow's view turn** is `setView('apps', 'front')`, what `viewOnSettle` does.
- **`appOf` keeps its name**, documented as the page: a rename would touch `cableSession.ts` and its spec for no behavior.

## Review Focus

1. **The page held by a follow empties** (its agent ends, or its next hook is not nested) while the terminal stays in
   front: the hold ends and the dial shows the terminal's page if it has agents, else the default; one switch. Test in
   Task 5.
2. **The dial's own rest on the tmux row selects the client's tab**, and iTerm2 reports that tab back: it is an echo, so
   no follow and no page turn. Test in Task 9.
3. **An agent the scan placed in tmux resumes in a plain tab** (its first hook names no multiplexer pane): `nest` goes at
   once and its page is its app's. Test in Task 6.
4. **Harness picked over iTerm2 with the window open**, then a tab follow to the tmux agent: the pick holds, the view
   stays on the tab, the filter does not turn. Test in Task 7.
5. **Two tab reports before the settle**, the tmux tab then a plain tab: the latest wins, and the settle shows iTerm2's
   page with `front`, no `follow` switch. Test in Task 9.

---

## Task graph

| # | Task | Effort | Depends on | State |
|---|---|---|---|---|
| 1 | The multiplexer an agent runs in, on the agent and on a lookup's answer | high | - | done |
| 2 | tmux's lookup says when tmux made the agent's terminal | high | 1 | done |
| 3 | herdr's lookup says when herdr made the agent's terminal | high | 1 | done |
| 4 | One rule for the page | medium | 1 | done |
| 5 | The filter turns to a followed page and holds it | xhigh | - | done |
| 6 | Observed agents carry their multiplexer; Diego's case on the devices | xhigh | 2, 3, 4 | done |
| 7 | The cable host turns the page for a follow | xhigh | 4, 5 | done |
| 8 | A notice's pick turns to the agent's page | medium | 4, 6 | done |
| 9 | The tab and prompt follows turn the dial to a nested agent's page | xhigh | 6, 7 | done |
| 10 | macOS e2e: tmux and herdr pages, and the tab follow | high | 6, 9 | |
| 11 | Linux dial-host e2e and the filter's line forms | high | 5, 6 | |
| 12 | The devices row in `cli/AGENTS.md` | medium | - | done |
| 13 | The eval reads tmux's and herdr's pages | high | - | |
| 14 | A pick on the dial is a step, and iTerm2's scenarios expect the new pages | high | 13, 6, 9 | |

Left now: 10, 11 and 13 share no file and can run at once; 14 waits for 13 (both touch `types.ts`). Longest chain left:
13 → 14. Over the whole plan: 1 → 2 → 6 → 9 → 14 (five tasks; 1 → 2 → 6 → 9 → 10 is as long).

Files of the tasks left, to check overlap:
- 10: `cli/e2e/dialTmuxTerminal.e2e.ts`, `cli/e2e/dialHerdrTerminal.e2e.ts`.
- 11: `cli/e2e/dialHostHerdrKitty.e2e.ts`, `cli/e2e/dialHostHerdrWezterm.e2e.ts`, `cli/e2e/dialHostHerdrX11.e2e.ts`,
  `cli/e2e/dialAppFilter.e2e.ts`, `cli/e2e/dialAppFilterOnDial.e2e.ts`.
- 13: `cli/src/testing/dialAppEval/{types,types.spec,checks,checks.spec,catalog}.ts`.
- 14: `cli/src/testing/dialAppEval/{types,itermScenarios,itermScenarios.spec,heldOut,catalog.spec,dialAppEval.spec}.ts`,
  `cli/src/testing/dialAppEval/baseline.json`, `cli/src/testing/dialAppEval/tierA/steps/{dial,dial.spec,herdr.spec}.ts`,
  `cli/e2e/harness/appEvalDriver.ts`.

Checked and left alone: `cli/e2e/dialAppEvalIterm.e2e.ts` and `cli/e2e/dialAppEvalHeldOut.e2e.ts` run the catalog's
scenarios, and their `ALSO` checks (I2's tmux runs and herdr listing, I5's and I13's selects, I19's one mod delivery to b)
hold under the new steps. `grade.ts RACED_B` keeps its four keys: they still exist (iTerm2's ring in I3 and I15), and
whether the race is gone is read from Verification 3, not guessed. `dialHostHerdrPane.e2e.ts` keeps its expectations:
its WezTerm agent's terminal is WezTerm's, so no `nest`. `deviceHerdrApp.e2e.ts` keeps its expectations: Herdr.app's
agents were already on herdr's page.

---

### Task 1: The multiplexer an agent runs in, on the agent and on a lookup's answer

**Files:**
- Modify: `cli/src/cable/hosts/types.ts` (`Nest`, `HostAgent.nest`, the doc of `HostAgent.app`)
- Modify: `cli/src/cable/hosts/outer.ts` (`OuterLookup`'s answer, `firstOuter`)
- Test: `cli/src/cable/hosts/outer.spec.ts`

**Interfaces:**
- Produces: `export type Nest = 'tmux' | 'herdr'`; `HostAgent.nest?: Nest`; `OuterLookup` =
  `(hints, pid) => Promise<{ app?: string; tty?: string; pid?: number; nest?: Nest }> | undefined`; `firstOuter`'s
  signature unchanged.

- [ ] **Step 1: Write the failing test** in `outer.spec.ts`, with the file's `lookup` helper:

```ts
it('the answer says the multiplexer that made the agent\'s terminal: the first lookup\'s, else the second\'s', async () => {
  type Place = NonNullable<Awaited<Answer>>
  const of = (first: Place, second: Place) =>
    firstOuter(lookup(() => Promise.resolve(first)), lookup(() => Promise.resolve(second)))(hints, 42)
  // tmux inside a herdr pane: herdr's server made no terminal of the caller's, tmux's did.
  expect(await of({}, { app: 'iterm', tty: '/dev/ttys002', pid: 4300, nest: 'tmux' })).toEqual({ app: 'iterm', tty: '/dev/ttys002', pid: 4300, nest: 'tmux' })
  // Detached: no client, still tmux's pane.
  expect(await of({}, { nest: 'tmux' })).toEqual({ nest: 'tmux' })
  // herdr inside the person's tmux: herdr's client is in no app, its process alone.
  expect(await of({ pid: 4400, nest: 'herdr' }, {})).toEqual({ pid: 4400, nest: 'herdr' })
  // Zellij's answer carries none.
  expect(await of({}, { app: 'ghostty' })).toEqual({ app: 'ghostty' })
})
```

- [ ] **Step 2: Run it:** `cd cli && npx vitest run src/cable/hosts/outer.spec.ts` → FAIL (the second and third
  expectations lose `nest`), and `npm run typecheck` fails on `nest` in the answers. Commit red:
  `Dial: a lookup's answer says which multiplexer made the agent's terminal (red)`.

- [ ] **Step 3: Implement.** `types.ts`: `Nest`; `HostAgent.nest` documented as "the nearest multiplexer whose pane is the
  agent's own terminal, as its lookup or the scan's maker read confirmed (observed.ts); tmux and herdr only (Diego,
  2026-11-23); its page is that multiplexer's unless its app is Orca (select.ts pageOf)"; `HostAgent.app` documented as
  "the outermost app the person sees, one of APP_IDS: what a tap brings and the tab it raises, and the app a prompt's
  follow compares with the front; the page is pageOf's; the unknown app's while appPending". `outer.ts`: the answer type
  and its doc (`nest`: this lookup's multiplexer made the caller's terminal, whether or not a client was found);
  `firstOuter` keeps today's choice of answer and gives it `nest` of the first answer that has one.

- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/outer.spec.ts` and `npm run typecheck` → PASS.

- [ ] **Step 5: Commit green:** `git add cli/src/cable/hosts/types.ts cli/src/cable/hosts/outer.ts cli/src/cable/hosts/outer.spec.ts`,
  `Dial: a lookup's answer says which multiplexer made the agent's terminal`.

### Task 2: tmux's lookup says when tmux made the agent's terminal

**Files:**
- Modify: `cli/src/cable/hosts/tmux.ts` (`createTmuxOuter` only; `createTmuxNested` unchanged)
- Test: `cli/src/cable/hosts/tmux.spec.ts`

**Interfaces:**
- Consumes: `Nest`, `OuterLookup` (Task 1).
- Produces: `createTmuxOuter`'s answer carries `nest: 'tmux'` once confirmed.

- [ ] **Step 1: Write the failing tests** in the `createTmuxOuter` describe, with its existing fakes:
  - `'the answer says tmux once the pane is the person\'s, holds the caller and tmux made its terminal: a client in an
    app, no client, and the clients not read'` → `{ app: 'terminal-app', tty: '/dev/ttys004', pid: 4300, nest: 'tmux' }`,
    `{ nest: 'tmux' }` (no client line), `{ nest: 'tmux' }` (`list-clients` exits 1; its line still
    `[device] tmux client · not read · clients`).
  - `'a terminal started from a tmux pane (code .), a pane Harness made, a pane holding no process of the caller\'s, and
    facts not read answer {} with no nest'` → each `toStrictEqual({})`.
  - `'tmux inside a herdr pane: hints naming both panes, tmux the maker: the answer says tmux'` (hints
    `{ HERDR_PANE_ID: 'w1:p1', TMUX_PANE: '%3' }`) → `nest: 'tmux'`.

- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/tmux.spec.ts -t 'says tmux|no nest'` → FAIL. Commit red.

- [ ] **Step 3: Implement** in `createTmuxOuter`'s `placeOf`: the step after `owner === 'tmux'` gives its place, or a
  step not read, with `nest: 'tmux'`; `said` still logs the same lines and turns a step not read into `{ nest: 'tmux' }`
  there, `{}` before it. Held answers (`heldAnswers`) keep the field.

- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/tmux.spec.ts` → PASS (existing answers that now carry `nest` get it
  in their expectation, nothing else).

- [ ] **Step 5: Commit green:** `Dial: tmux's lookup says when tmux made the agent's terminal`.

### Task 3: herdr's lookup says when herdr made the agent's terminal

**Files:**
- Modify: `cli/src/cable/hosts/herdrOuter.ts` (`createHerdrOuter` only; `createHerdrNested` unchanged)
- Test: `cli/src/cable/hosts/herdrOuter.spec.ts`

**Interfaces:**
- Consumes: `Nest`, `OuterLookup` (Task 1).
- Produces: `createHerdrOuter`'s answer carries `nest: 'herdr'` once its server made the caller's terminal.

- [ ] **Step 1: Write the failing tests** in the `createHerdrOuter` describe, with its fakes:
  - `'the answer says herdr once its server made the caller\'s terminal: a client in an app, a client in no app, no
    client, a client inside the person\'s tmux, and the sockets or ttys not read'` → each answer as today plus
    `nest: 'herdr'` (the not-read ones `{ nest: 'herdr' }`, their lines unchanged).
  - `'a terminal started from a herdr pane, whose maker is not herdr, and a table not read answer {} with no nest'`.

- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/herdrOuter.spec.ts -t 'says herdr|no nest'` → FAIL. Commit red.

- [ ] **Step 3: Implement** in `createHerdrOuter`'s `placeOf`: after `maker.host === 'herdr'`, `clientsOf`'s place or step
  not read carries `nest: 'herdr'`; `saidAnswers` keeps it when it turns a step not read into a place.

- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/herdrOuter.spec.ts` → PASS.

- [ ] **Step 5: Commit green:** `Dial: herdr's lookup says when herdr made the agent's terminal`.

### Task 4: One rule for the page

**Files:**
- Modify: `cli/src/cable/hosts/select.ts` (`pageOf`)
- Test: `cli/src/cable/hosts/select.spec.ts`

**Interfaces:**
- Consumes: `HostAgent.nest` (Task 1).
- Produces: `pageOf(a: HostAgent): string` = `a.nest` when set and `a.app !== 'orca'`, else as today.

- [ ] **Step 1: Write the failing tests** in the `AppRings` describe, with the file's `agent(id, over)`:
  - `'Diego\'s case: a plain agent, one in tmux and two in herdr, all in iTerm2, are iTerm2 1, tmux 1, herdr 2'` →
    `rings.apps().map(({ id, count }) => [id, count])` equals `[['iterm', 1], ['tmux', 1], ['herdr', 2]]`.
  - `'tmux in VS Code\'s or Cursor\'s terminal is on tmux\'s page; an inherited TMUX_PANE with no nest (code . from a
    tmux pane) stays on its app\'s'` (`{ app: 'vscode', host: 'tmux' }` → `vscode`).
  - `'tmux and herdr in Orca stay on Orca\'s page; tmux in Herdr.app is on tmux\'s'` (`{ app: 'herdr', nest: 'tmux' }` →
    `tmux`).
  - `'a terminal holding only herdr panes has no row; a nested agent whose client is in no listed app is on its
    multiplexer\'s page, not Other\'s'`.
  - `'counts: a nested agent counts for its multiplexer\'s page in all, known and inFront, never its app\'s'`.
  - `'twenty agents in tmux across three terminals: one tmux ring of 16, count 20'` (`RING_PLACES`).

- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/select.spec.ts` → FAIL. Commit red.

- [ ] **Step 3: Implement `pageOf`** in `select.ts`, its doc naming the Orca exception (Orca's ring is its own tab
  order, and `devices.ts orcaAgents` takes `app === 'orca'`).

- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/select.spec.ts` → PASS.

- [ ] **Step 5: Commit green:** `Dial: an agent in tmux or herdr is on that multiplexer's page`.

### Task 5: The filter turns to a followed page and holds it

**Files:**
- Modify: `cli/src/cable/hosts/appFilter.ts`
- Modify: `cli/src/cable/hosts/types.ts` (`SwitchCause` gets `'follow'`)
- Test: `cli/src/cable/hosts/appFilter.spec.ts`

**Interfaces:**
- Produces: `SwitchCause = 'front' | 'pick' | 'empty' | 'notice' | 'follow'`;
  `AppFilterDeps.settling?(app: string): void` (told once `settledApp()` names the app, before the settle shows
  anything; absent, nothing is told); `AppFilter.follow(app: string, page: string): boolean`.

Rules (the tests pin each):
- `follow` changes nothing and answers false while a pick holds, when `app` is not `settledApp()`, or when `page` has no
  agents. With `page === app` it ends a hold, shows nothing and answers false. Otherwise it holds `page` as the front's
  page, shows it with `follow` when not shown, and answers true (already shown and held: true, no switch).
- `shown()`'s front rule reads the held page in place of the front while the held page has agents in `inFront`; once it
  has none the hold ends.
- `settle(app)`: another app ends the hold (as it ends a pick); then `settling(app)`; then the settle shows the held page,
  else the app, as today (`front`); then `settled(app)`, as today.
- A pick that switches, and `hold()`, end the hold; a pick answered `same` keeps it.

- [ ] **Step 1: Write the failing tests** with the file's `setup` (its `told` list; add `settling` to the deps it builds,
  recording `settling <app>` and running a callback the test sets):
  - `'a follow to an agent of the app settled in front, on another page, shows that page and holds it while that app stays
    in front'`: iTerm2 1, tmux 1 in front; settle iTerm2; `follow('iterm', 'tmux')` → true; `causes()` →
    `['front', 'follow']`; three `shown()` reads → `'tmux'`.
  - `'another app settling ends the hold; the same app settling again keeps it'`.
  - `'a pick holds against a follow, and a pick or a notice that switches ends a hold'`.
  - `'a follow for an app not settled in front, or to a page with no agents, changes nothing and answers false'`.
  - `'a later follow to an agent on its app\'s own page ends the hold: the next read shows the app, front'`.
  - `'a follow made while its app settles shows its page in place of the app\'s: one switch, follow, before settled'`:
    `told` → `['settling iterm', 'follow', 'settled iterm']`.
  - `'an app with no agents of its own settling, with a follow in settling: one switch, follow'`.
  - `'the held page empties: the hold ends and the app in front is shown, one switch'` (Review Focus 1).

- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/appFilter.spec.ts` → FAIL. Commit red.

- [ ] **Step 3: Implement** the rules above: a private held page (`followed`), cleared where they say; `follow`;
  `settling` told in `settle`. Doc on `follow`: Diego's decision 4 and the spec's "A follow turns the page".

- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/appFilter.spec.ts` and `npm run typecheck` → PASS.

- [ ] **Step 5: Commit green:** `Dial: a follow turns the app filter to a nested agent's page and holds it`.

### Task 6: Observed agents carry their multiplexer; Diego's case on the devices

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`ingest`, `askOuter`, `scanOpen`'s listing loop)
- Test: `cli/src/cable/hosts/observed.spec.ts`
- Test: `cli/src/services/devices.spec.ts` (expectations the new rule flips)

**Interfaces:**
- Consumes: the answer's `nest` (Tasks 1 to 3), `pageOf` (Task 4), `Nested.host`.
- Produces: `HostAgent.nest` and `host` on observed agents.

Rules:
- A hook sets `host` after `askOuter`: `nest ?? detectHost(hints)`.
- `askOuter` drops `nest` wherever it drops the outer place at once (another caller or pane; no lookup applies) and keeps
  it wherever it keeps that place (the same ask; the scan's place at a first nested hook from its own process). The
  latest ask's answer, while the session lives, sets `nest` to the answer's (unset when it has none) and `host` again.
- The scan: a session listed with a `Nested` whose `host` is `tmux` or `herdr`, not paired, gets that as `nest` and `host`
  at its listing, before its lookup, whatever the lookup answers. Another host (`zellij`) gives none.

- [ ] **Step 1: Write the failing tests.**
  `observed.spec.ts`, in "ObservedSource outer place":
  - `'a hooked agent in tmux has nest and host tmux once its lookup says tmux: with a client\'s app and detached'`.
  - `'a hooked agent in herdr has nest and host herdr'`.
  - `'tmux inside herdr: the hints name both panes and detectHost says herdr, the lookup says tmux: nest and host tmux'`;
    `'herdr inside tmux: nest and host herdr'`.
  - `'code . from a tmux pane: its lookup says no multiplexer: no nest, host as its hints name it, app vscode'`.
  - `'another caller or pane drops nest at once; an earlier ask\'s late answer sets nothing'`.
  In "a nested session the scan found":
  - `'a session on a terminal tmux or herdr made has nest and host at its listing, with and without its lookup naming
    an app'`; `'a Zellij maker gives no nest'`.
  - `'its first nested hook from its own process keeps nest until the hook\'s answer, then the answer\'s'`;
    `'a first hook that is not nested drops nest at once: host and page from its hints'` (Review Focus 3).
  `devices.spec.ts`: the exact case (`'the exact case: a plain tab, tmux and two herdr panes in iTerm2 ...'`, hooked and
  found by the scan, server under iTerm2 and launchd) becomes `'... are iTerm2 1, tmux 1, herdr 2 ...'`:
  `apps.filter(({ count }) => count > 0).map(({ id, count }) => `${id} ${count}`).sort()` equals
  `['herdr 2', 'iterm 1', 'tmux 1']`; its `reached` list (each tab and pane) unchanged.

- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/observed.spec.ts -t 'nest'` and
  `npx vitest run src/services/devices.spec.ts -t 'the exact case'` → FAIL. Commit red.

- [ ] **Step 3: Implement** the rules in `observed.ts`.

- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts` → the new tests
  pass. Then flip every other `devices.spec.ts` expectation the rule changes, by the rule (the tests around
  "an agent in the person's tmux", "an agent the attach scan found in the person's tmux or herdr" and "an agent in the
  person's herdr, attached from a Terminal tab": a nested agent's page is tmux's or herdr's, its terminal's row only for
  that terminal's own agents; `host` of a scan-found nested agent is `tmux` or `herdr`). The scan-found herdr agent with
  no session in herdr's row: as Open question 1 is answered. Run again → PASS.

- [ ] **Step 5: Commit green:** `Dial: an observed agent in tmux or herdr carries that multiplexer, and is on its page`.

### Task 7: The cable host turns the page for a follow

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (`followPage`, `CableHostWiring.appSettling`, the filter's `settling`)
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Consumes: `AppFilter.follow`, `AppFilterDeps.settling` (Task 5), `pageOf` (Task 4).
- Produces: `DaemonCableHost.followPage(agentId: string): void`; `CableHostWiring.appSettling?: (app: string) => void`,
  wired as the filter's `settling`.

Rules: `followPage` takes the agent as the machine list holds it (`registry.entries()`); none, nothing. With a window
open and the agent's `app` the one Harness was picked over (`pickedOver`), nothing. Else `filter.follow(agent.app,
pageOf(agent))`; true with a window open clears `pickedOver` and `setView('apps', 'front')`.

- [ ] **Step 1: Write the failing tests** in "the dial that shows one app at a time", with its `agent`, `setup` and
  `shown` (a nested agent: `agent('b1', 'iterm', { nest: 'tmux', host: 'tmux' })`, beside `agent('a1', 'iterm')`):
  - `'a follow to an agent in tmux inside iTerm2, iTerm2 settled: every dial\'s next read shows tmux\'s page, with the
    agent, and keeps it while iTerm2 stays in front'` (two `listAgentSnapshot({ apps: true })` reads; `appSwitched` calls
    `['front', 'follow']`).
  - `'a pick on the dial holds against it; another app settling ends it'`.
  - `'a follow told in appSettling makes the settle show tmux\'s page directly: one appSwitched, follow, before
    appSettled'` (wiring `appSettling: () => host.followPage('b1')`; told `['follow', 'settled iterm']`).
  - In "the view while a window is open": `'a follow turns the view to apps, on tmux\'s page'` (`appView` told
    `['apps', 'front']`) and `'with Harness picked over iTerm2, a follow turns neither the view nor the filter'`
    (Review Focus 4).
  - `'an agent on its app\'s own page, one of an app not settled in front, and one no list holds turn nothing'`.

- [ ] **Step 2: Run** `npx vitest run src/cable/cableHost.spec.ts -t 'follow'` → FAIL. Commit red.

- [ ] **Step 3: Implement** the rules; `followPage`'s doc says it is told once per follow, before the dials are asked,
  so every dial's next read sees the page.

- [ ] **Step 4: Run** `npx vitest run src/cable/cableHost.spec.ts` and `npm run typecheck` → PASS.

- [ ] **Step 5: Commit green:** `Dial: a follow to an agent in tmux or herdr turns the dials to its page`.

### Task 8: A notice's pick turns to the agent's page

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (`appOf`)
- Test: `cli/src/cable/cableHost.spec.ts`
- Test: `cli/src/services/devices.spec.ts` (an `appOf` expectation the rule flips)

**Interfaces:**
- Consumes: `pageOf` (Task 4), observed `nest` (Task 6).
- Produces: `appOf(agentId, opts)` answers the agent's page (`pageOf`), its only user being a notice's pick
  (`cableSession.ts agent.open`).

- [ ] **Step 1: Write the failing test:** `'appOf is the page an agent is on: tmux\'s or herdr\'s for a nested agent,
  Orca\'s for one in Orca; a notice\'s pick of a nested agent turns the dial there'` → `host.appOf('b1')` is `'tmux'`,
  `host.pickApp('tmux', 'notice')` is `'switched'`, the next read shows `tmux`. The existing test "appOf is the agent's
  app ..." is renamed "... page ..." with its expectations as they are.

- [ ] **Step 2: Run** `npx vitest run src/cable/cableHost.spec.ts -t appOf` → FAIL. Commit red.

- [ ] **Step 3: Implement:** `appOf` returns `pageOf` of the machine list's copy; its doc says it is the page.

- [ ] **Step 4: Run** `npx vitest run src/cable/cableHost.spec.ts src/services/devices.spec.ts` → PASS; a
  `devices.spec.ts` `appOf` expectation of a nested agent (e.g. "tmux inside a cmux terminal ...", whose title then
  names tmux's page) flips by the rule.

- [ ] **Step 5: Commit green:** `Dial: a notice of an agent in tmux or herdr turns the dial to that page`.

### Task 9: The tab and prompt follows turn the dial to a nested agent's page

**Files:**
- Modify: `cli/src/services/devices.ts` (the tab follow, `followPrompt`, the cable host's wiring, `stop`)
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `cableHost.followPage`, `CableHostWiring.appSettling` (Task 7).
- Produces: nothing new outside `devices.ts`.

Rules:
- `tabAgent(report): string | undefined` is today's judge of `followTab` (uses up the report; no dial linked; echo by the
  dial's moves; echo by its selects; unknown agent; each line as today), then `cableHost.followPage(id)`.
  `followTab(report)` is `tabAgent`, then `cable.followLocal(id, 'tab')`.
- `appSettling: (app) => part.call('dial', () => tabSettling(app))`: a report waiting on `app` is judged there and its
  agent kept for `tabSettled`, which asks `cable.followLocal(id, 'tab')`; a report left waiting on another app is dropped
  in `tabSettled` with `[device] tab · skipped · not in front`, as today. `stop` clears the kept agent.
- `followPrompt` calls `cableHost.followPage(agentId)` right before `cable.followLocal(agentId, 'prompt')`.

- [ ] **Step 1: Write the failing tests** in a new describe beside "selecting a tab moves the dial", on its `dialWith`
  pattern, with a plain agent in an iTerm2 tab and one in tmux whose client is in another iTerm2 tab (the lookups'
  fakes of "the exact case"), and a `switches()` of the `[device] app filter: switched ·` lines:
  - `'a tab report of the tmux client\'s tab, iTerm2 settled: the dials are asked to follow its agent, and the list a dial
    that says appFilter reads shows tmux\'s page with it'` → `asked()` `[[ID, 'tab']]`, `apps.shown` `tmux`, the agent
    listed, `switches()` ends `switched · follow`.
  - `'a report waiting for iTerm2 to settle: the settle shows tmux\'s page directly'` → `switches()` equals
    `['[device] app filter: switched · follow']`, `asked()` `[[ID, 'tab']]`.
  - `'iTerm2 with no agents of its own: its settle shows nothing new, and the follow turns the page'`.
  - `'the tmux tab, then a plain tab, both before the settle: the latest wins, and the settle shows iTerm2\'s page,
    front'` (Review Focus 5).
  - `'the dial\'s own rest on the tmux row selects its tab: iTerm2\'s report of it is its echo, and the page stays'`
    (Review Focus 2).
  - `'a pick on the dial holds: the tmux tab\'s report turns no page'`; `'a pick of tmux\'s page brings no app'` (no
    `app filter: bring` line: tmux has no bundle).
  - `'with a window open on its tab and iTerm2 holding no agent of its own, the follow turns the view to apps on tmux\'s
    page'` (`view apps · front` logged).
  - In "a person's prompt in the app in front turns the dial": `'a prompt in the tmux agent, iTerm2 settled, turns the
    dial to tmux\'s page and asks the dials to follow it'` → `[ID, 'prompt']`, `apps.shown` `tmux`.

- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts -t "tmux's page"` → FAIL. Commit red.

- [ ] **Step 3: Implement** the rules in `devices.ts`.

- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts`, `npm run typecheck`, then `npm run test:core` once
  (`devices.ts` stays at 100% per file) → PASS.

- [ ] **Step 5: Commit green:** `Dial: selecting a tmux or herdr tab, or a prompt there, turns the dial to that page`.

### Task 10: macOS e2e: tmux and herdr pages, and the tab follow

**Files:**
- Modify: `cli/e2e/dialTmuxTerminal.e2e.ts`
- Modify: `cli/e2e/dialHerdrTerminal.e2e.ts`

**Interfaces:**
- Consumes: the behavior of Tasks 6 and 9 (landed). Test-only: no red-first test, one commit. The evidence is the old
  expectations failing on the head before the edit and the new ones passing.
- The fake dial picks a page with `dial.pick(app)` (`e2e/harness/fakeDial.ts`), which sends `app.pick` as the
  firmware's Apps screen does.

- [ ] **Step 1: Run the files on the head:** `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config
  vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts e2e/dialHerdrTerminal.e2e.ts`. Expected: the three page cases below
  FAIL. This needs `tmux` and herdr 0.9.5 or later installed; a skipped file does not count as run.

- [ ] **Step 2: Update `dialTmuxTerminal.e2e.ts`.** Every swipe, rest, select, log and `unsaid` check stays as it is.
  The swipes already focus B and the agent by id across pages.
  - The header comment and the describe title: the agent "is on tmux's page, seen in the app that holds the tmux client"
    in place of "shows on the page of the app that holds".
  - `"an agent in the person's tmux is on Terminal's page, one row, and on no tmux page"` becomes `"an agent in the
    person's tmux is on tmux's page, one row, and Terminal's page holds B alone"`. Use `pageOf(dial, ..., 'tmux', 1)`.
    The same frame has `terminal-app` at count 1. Then `dial.pick('tmux')` and `rosterWith` holds the agent once. The
    line `[device] tmux client · found` stays.
  - `"found by the scan after the devices start, an agent in the person's tmux whose client is in an iTerm2 tab is on
    iTerm2's page, one row, and on no tmux or Other page"` becomes `"... is on tmux's page, one row, with no iTerm2 or
    Other page"`. Use `pageOf(dial, ..., 'tmux', 1)`. The frame's ids hold neither `iterm` nor `UNKNOWN_APP` (decision 2:
    iTerm2 holds no agent of its own). The roster, the scan line and `unsaid` stay.
  - `"found by the scan, with iTerm2 in front a swipe selects the client's tab, then the agent's pane"`: its first wait
    becomes `pageOf(dial, "tmux's page holding the agent", 'tmux', 1)`. B is then on iTerm2's page, and the
    swipe from B to the agent and the pane check stay.
  - Its `watch` helper gains `tab(tty)`, which writes `{ tab: { app: 'terminal-app', tty } }` the way
    `dialHerdrTerminal`'s helper does, so both files' helpers have the same shape.
  - Add `"with Terminal settled in front, selecting the client's tab turns the dial to tmux's page and its agent"`
    (`fresh()`; `watch` has already written Terminal in front). Wait for the `apps` frame showing `terminal-app` (B is
    Terminal's own agent), then call `run.tab(await client.tty())`. Expected from there: an `apps` frame with
    `shown === 'tmux'`, a `focus` frame naming the agent, `[device] tab · moved` and exactly one
    `[device] app filter: switched · follow` in the log, and `unsaid` holds.

- [ ] **Step 3: Update `dialHerdrTerminal.e2e.ts`.** Every swipe, focus, log and kept-or-dropped check stays.
  - The header comment and the describe title change as in Step 2, for herdr.
  - `"an agent in the person's herdr is on Terminal's page, one row each, and on no herdr page"` becomes `"agents in
    the person's herdr are on herdr's page, one row each, with no Terminal page"`. Wait for the `apps` frame holding
    `herdr` at count 2. Its ids hold no `terminal-app`: both B and the agent are in herdr, so Terminal holds no agent of
    its own. The roster of both, the `herdr client · found` line and the table's kept and dropped pids stay.
  - `"a tab line with the client's tty turns the dial to the agent heard from last"` keeps its focus and
    `tab · moved` waits. It also expects, from `since`, an `apps` frame with `shown === 'herdr'` and exactly one
    `[device] app filter: switched · follow` in the log. `watch` has already written Terminal in front, and the other
    agent gives Terminal a page of its own, so the follow is to an agent of the app settled in front (Task 5's rule).

- [ ] **Step 4: Run** the command of Step 1. Expected: PASS, no case skipped.

- [ ] **Step 5: Commit:** `Dial e2e: agents in tmux and herdr are on their own pages, and a tab follow turns there`.

### Task 11: Linux dial-host e2e and the filter's line forms

**Files:**
- Modify: `cli/e2e/dialHostHerdrKitty.e2e.ts`, `cli/e2e/dialHostHerdrWezterm.e2e.ts`, `cli/e2e/dialHostHerdrX11.e2e.ts`
- Modify: `cli/e2e/dialAppFilter.e2e.ts` (the line-form regex at line 573), `cli/e2e/dialAppFilterOnDial.e2e.ts`
  (`CAUSES` at line 30, `expectFilterLines` at line 95)

**Interfaces:**
- Consumes: the behavior of Tasks 5 and 6 (landed). Test-only, one commit.

- [ ] **Step 1: Update the expectations.** Every rest, raise, tap and log check stays.
  - Kitty: the header and `"lists the agent on kitty's page, one row, and on no other page"` become herdr's page. Wait
    for `herdr` at count 1, and the frame's pages with agents are `[herdr 1]` alone. `"with kitty in front a rest
    focuses the client's window, then the agent's herdr pane"` keeps its rest: the focus reaches the agent by id.
  - WezTerm: the header, `"lists the agent on WezTerm's page, one row, and on no other page"` and `"found by the scan,
    with herdr's row of its session: one row on WezTerm's page; ..."` become `pages(dial, 'herdr 1')`. `"found by the
    scan, with no session in herdr's row: on WezTerm's page with its tab, and herdr's row on herdr's page"` becomes
    `pages(dial, 'herdr 2')`, the known gap the PM accepted (Decision 1 below). Its title says so: `"... both on herdr's
    page until its first hook (a known gap)"`.
  - X11: the header and `"keeps the agent on the Other page, and a tap raises the client's xterm and focuses the
    agent's pane"` become herdr's page. Wait for `herdr` at count 1, and the pages with agents are `[herdr 1]`. The
    comment at line 84 says why: its client is in no listed app, and the agent is still herdr's (Task 4's rule).
  - `dialAppFilter.e2e.ts` and `dialAppFilterOnDial.e2e.ts`: both line-form regexes allow `switched · follow`, and
    `CAUSES` lists `follow`.

- [ ] **Step 2: Typecheck:** `cd cli && npm run typecheck`. Expected: PASS. These files skip on macOS, which has no
  kitty, WezTerm or X11 desktop here. PR CI's `dial-hosts` and `linux-e2e` jobs run them (Verification 5).

- [ ] **Step 3: Commit:** `Dial e2e: a herdr agent in kitty, WezTerm or an xterm is on herdr's page; follow is a filter
  cause`.

### Task 12: The devices row in `cli/AGENTS.md`

**Files:**
- Modify: `cli/AGENTS.md` (the `devices` row of the services table only)

Docs only: no test, one commit.

- [ ] **Step 1: Rewrite the sentences that place a tmux or herdr agent:** an agent in a tmux pane the person opened, when
  tmux made its terminal, is on tmux's page (in Orca, on Orca's) and is seen in the app holding the tmux client used last
  on its session, whose tty is its tab; the same for herdr; herdr's client inside the person's tmux or Zellij, or in a
  terminal with no page, leaves its agent on herdr's page (no longer Other's); selecting a tab, or a prompt, of an agent
  in tmux or herdr turns the dial to that page and holds it while the app stays in front; the filter's causes include
  `follow`. Nothing else in the row changes.

- [ ] **Step 2: Commit:** `docs: the devices row says tmux and herdr agents are on their own pages`.

### Task 13: The eval reads tmux's and herdr's pages

**Files:**
- Modify: `cli/src/testing/dialAppEval/types.ts` (`Page`, `pageId`, `sessionPage`, the ring check's `page`, `Until`)
- Modify: `cli/src/testing/dialAppEval/checks.ts` (`ringParts`, `stateParts`)
- Modify: `cli/src/testing/dialAppEval/catalog.ts` (`listed`)
- Test: `cli/src/testing/dialAppEval/types.spec.ts`, `cli/src/testing/dialAppEval/checks.spec.ts`

**Interfaces:**
- Consumes: `Nest` (`cli/src/cable/hosts/types.ts`, Task 1), as a type import.
- Produces:
  - `export type Page = App | Nest`;
  - `export const pageId = (page: Page): string`: `tmux` and `herdr` as they are, an app by `PAGE`;
  - `export function sessionPage(s: SessionDef): string`: `itermPlaceOf(s)` when it is `tmux` or `herdr`, else
    `PAGE[s.app]`. Its doc cites the spec's decision 1;
  - the ring check's `page: Page`, and `Until = { kind: 'ring'; page: Page; expect: SessionKey[]; apart?: SessionKey[] }`;
  - `listed(page: Page, expect: SessionKey[], apart?: SessionKey[]): Step[]`, with `apart` on the until only when given.

Rules: `ringParts` reads `pageId(check.page)` and `apartPart` gets that id. `stateParts` reads
`sessionPage(session)`. `condition` stays as it is: it spreads the until into a ring check, so `apart` becomes a part
it waits on. No scenario changes here, so tier A keeps the head's 4 failures (Task 14 fixes them).

- [ ] **Step 1: Write the failing tests.**
  - `types.spec.ts`: `'pageId names tmux and herdr as themselves and an app by PAGE; sessionPage puts an iTerm2
    session in tmux or herdr on that page, and every other session on its app\'s'`. Expected: `pageId('tmux')` is
    `'tmux'` and `pageId('chatgpt')` is `'codex'`. `sessionPage` of `itermSession('b', { place: 'tmux' })` is `'tmux'`,
    of `{ place: 'herdr' }` is `'herdr'`, of a plain tab is `'iterm'`, and of `claudeSession('a', 0)` is `'claude'`.
  - `checks.spec.ts`, beside the ring tests:
    - `'a ring on tmux\'s page reads the list the dial holds on tmux\'s page; the same list fails a ring on iTerm2\'s'`.
      The frames are `apps` shown `tmux` and a whole list with b's row. Page `tmux` gives `ring.recall` 1. Page
      `iterm` gives 0, with the evidence `list at … on tmux, not iterm`.
    - `'a wait with apart holds once the other pages count them: iterm 1, tmux 1, herdr 1 does not hold for apart b, c,
      d; iterm 1, tmux 1, herdr 2 does'` (`condition`).
  - `checks.spec.ts`, beside the state tests: `'an iTerm2 session in tmux is shown in its state on tmux\'s page; the
    same frames with the list on iTerm2\'s page fail it'`.

- [ ] **Step 2: Run** `cd cli && npx vitest run src/testing/dialAppEval/types.spec.ts src/testing/dialAppEval/checks.spec.ts`
  and `npm run typecheck`. Expected: FAIL. Commit red: `Dial eval: test that the eval reads tmux's and herdr's pages
  (red)`.

- [ ] **Step 3: Implement** the interfaces and rules above.

- [ ] **Step 4: Run** the specs of Step 2 and `npm run typecheck`. Expected: PASS. Then run `npx vitest run
  src/testing/dialAppEval`. Expected: the head's 4 failures, and no other.

- [ ] **Step 5: Commit green:** `Dial eval: rings, waits and states on tmux's and herdr's pages`.

### Task 14: A pick on the dial is a step, and iTerm2's scenarios expect the new pages

**Files:**
- Modify: `cli/src/testing/dialAppEval/types.ts` (`STEP_KINDS` and `Step` get `pick`)
- Modify: `cli/src/testing/dialAppEval/tierA/steps/dial.ts`; Test: `cli/src/testing/dialAppEval/tierA/steps/dial.spec.ts`
- Modify: `cli/e2e/harness/appEvalDriver.ts` (`GenericKind` and `GENERIC` get `pick`)
- Modify: `cli/src/testing/dialAppEval/itermScenarios.ts`, `cli/src/testing/dialAppEval/heldOut.ts` (IH2, IH4, IH5)
- Test: `cli/src/testing/dialAppEval/itermScenarios.spec.ts`, `cli/src/testing/dialAppEval/catalog.spec.ts`,
  `cli/src/testing/dialAppEval/dialAppEval.spec.ts` (its I3 case), `cli/src/testing/dialAppEval/tierA/steps/herdr.spec.ts`
- Modify: `cli/src/testing/dialAppEval/baseline.json` (tier A's part, written by the eval command)

**Interfaces:**
- Consumes: `Page`, `pageId`, `sessionPage`, `listed(page, expect, apart)` (Task 13), and the behavior of Tasks 6 and 9.
- Produces: the step `{ kind: 'pick'; page: Page }`, documented as "the person picks a page on the dial's Apps screen
  (ui_habitat.c app_pick)". Tier A runs `world.dial.pick(pageId(step.page))`. Tier B runs
  `world.pick(pageId(step.page))`.

- [ ] **Step 1: Write the failing test** in `dial.spec.ts`: `'pick sends app.pick with the page\'s wire id: tmux as
  itself, the ChatGPT app\'s as codex'`. Run `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/dial.spec.ts`
  and `npm run typecheck`. Expected: FAIL. Commit red: `Dial eval: test that a pick on the dial is a step (red)`.

- [ ] **Step 2: Implement the step** in `types.ts`, `dial.ts` and `appEvalDriver.ts`. In `catalog.spec.ts`, `sees` gets
  `pick: ['ring']`, and the input rule's `inputs` set gets `'pick'`: a pick is an input on the dial, so it comes at
  least 1 s after its listing. Run `dial.spec.ts` and `npm run typecheck`. Expected: PASS. Do not commit yet:
  catalog.spec's "each step kind is used by a scenario whose probe can see it" fails until Step 3 uses `pick`, so the
  step and the scenarios land in one green commit (Step 7).

- [ ] **Step 3: Update the scenarios** in `itermScenarios.ts`, with two new helpers beside `ring` and `ringKept`:
  `ringOn(page, expect, more)` with id `ring<Page>`, and `ringKeptOn(page, expect, more)` with id `ringKept<Page>` (D7).
  The doc of `ring` says: on iTerm2's page, with `apart` the agents counted on tmux's and herdr's pages. Here, *apart X*
  means `apart: [X]`, and *listed P [E] apart [A]* means `listed('P', [E], [A])`. Scenarios not named here (I1, I4, I5,
  I8, I9, I12, I16 and I18) hold plain tabs alone and stay as they are.

  | Id | Change |
  |---|---|
  | I2 | Title: "...: iTerm2 1, tmux 1, herdr 2". Steps after the starts: listed iterm [a] apart [b c d]; `toTmux`: `iterm.select` w1 tab 1; listed tmux [b] apart [a c d]; `toHerdr`: `iterm.select` w1 tab 2; listed herdr [c d] apart [a b]. Checks: `ring(['a'])` apart b c d, until `toTmux`; `ringTmux` [b] apart a c d, `toTmux` to `toHerdr`; `ringHerdr` [c d] apart a b, from `toHerdr`. The probe stays `withGhost` of iTerm2's ring. Selecting the client's tab is how Diego reaches each page (decision 4), so the eval grades the new follow too. |
  | I3 | Title: "...: iTerm2 1, tmux 1, herdr 2 come back before any hook". Before the restart: listed herdr [c d] apart [a b], because the turns end with d's prompt, which turns the dial to herdr's page. After the restart: a 2 s wait, `toTmux` pick tmux, a 2 s wait, `toHerdr` pick herdr, a 2 s wait. These are the person's own waits, not `listed`: every row the scan finds after a restart has the wrong name today (main's baseline has I3 `ring.names` 0), so a `listed` there would only run to its limit. Checks: `ring` and `ringKept` [a] apart b c d, `restart` to `toTmux`; `ringTmux` and `ringKeptTmux` [b] apart a c d, `toTmux` to `toHerdr`; `ringHerdr` and `ringKeptHerdr` [c d] apart a b, from `toHerdr`. The probe stays `withGhost(i3Ring)`. |
  | I6 | Sessions: `inTmux('d', 1)` is added, b becomes `inTmux('b', 1, 1)`, and the starts are a, d, b. Steps: listed iterm [a] apart [d b]; pick tmux; listed tmux [d b] apart [a]; then the rest on b as before. Why d: the pick lands the face on tmux's first row, so with b alone there the swipe would not move the dial. The open check stays. |
  | I7 | Steps: listed iterm [a] apart [c d]; pick herdr; listed herdr [c d] apart [a]; then the taps as before. |
  | I10 | listed tmux [b a]. iTerm2 holds no agent of its own, so it has no row (decision 2). The focus check stays. |
  | I11 | listed herdr [d c]. |
  | I13 | Steps: listed iterm [a] apart [b]; after the attach and its 2 s wait, `toTmux` pick tmux; listed tmux [b] apart [a]; then the tap. Checks: `ringKept` [a] apart b, `attach` to `toTmux`; `ringKeptTmux` [b] apart a, `toTmux` to `tap`. The open check stays. |
  | I14 | Steps: listed iterm [a] apart [c d]; pick herdr; listed herdr [c d] apart [a]; `restart`; listed herdr [c d] apart [a]; the `pastLook` wait; `toIterm` pick iterm; listed iterm [a] apart [c d]. Checks: `ringHerdr` and `ringKeptHerdr` [c d] apart a, `restart` to `toIterm`; `ring` and `ringKept` [a] apart c d, from `toIterm`. Probe: `ringOn('herdr', ['c', 'd', 'z'])` apart a, `restart` to `toIterm`. |
  | I15 | Title: "...: tmux's and herdr's rows come back on their pages, with their tabs". Before the relaunch: listed herdr [c] apart [a b]. After the restart: listed iterm [a] apart [b c]; `toTmux` pick tmux; listed tmux [b] apart [a c]; `toHerdr` pick herdr; listed herdr [c] apart [a b]; then the taps. These stay `listed`, because the taps need their rows listed (catalog.spec), and each misses on the same names gap as main's `wait.19` (0). Checks: `ring` and `ringKept` [a] apart b c, `restart` to `toTmux`; `ringTmux` and `ringKeptTmux` [b] apart a c, `toTmux` to `toHerdr`; `ringHerdr` and `ringKeptHerdr` [c] apart a b, `toHerdr` to `tapB`. `openKeptB` and `openKeptC` stay. Probe: `ring(['a', 'z'])` apart b c, `restart` to `toTmux`. |
  | I17 | listed tmux [b]. The state check now reads tmux's page (Task 13). |
  | I19 | Steps after the starts: listed iterm [a] apart [b]; `iterm.select` w1 tab 1; listed tmux [b] apart [a]; then the voice to b. The person selects b's tab, which turns the dial to tmux's page with b on the face. The voice check (exact, once, reached), the gate and the probe stay. Its comment says why: words that reach a are a wrong send. |
  | I20 | listed herdr [d c]. |
  | I21 | Sessions: `inTmux('d', 1)` is added, b becomes `inTmux('b', 1, 1)`, and the starts are a, d, b, c. Steps: listed iterm [a] apart [d b c]; pick tmux; listed tmux [d b] apart [a c]; then the swipe to b, the unplug and the replug as before; listed tmux [d b] apart [a c]; `toIterm` pick iterm; listed iterm [a] apart [d b c]; `toHerdr` pick herdr; listed herdr [c] apart [a d b]. Checks: `ringKeptTmux` [d b] apart a c and `focusKept` b, both `replug` to `toIterm`; `ringKept` [a] apart d b c, `toIterm` to `toHerdr`; `ringKeptHerdr` [c] apart a d b, from `toHerdr`. Probe: `ringKeptOn('tmux', ['d', 'b', 'z'])` apart a c, `replug` to `toIterm`. Why d: as in I6, so that `focusKept` must keep a moved face. |
  | IH2 | listed iterm [a] apart [b]. After the `turn` hook's 2 s wait: listed tmux [b] apart [a], before the tap. The select of tab 2 and b's prompt have turned the dial to tmux's page, and the tap needs b listed. The check stays. |
  | IH4 | Title: "...: one row on herdr's page, and a tap reaches its tab". Both `listed` become herdr [c], and the ring's page is `herdr`. Its precision is 0.5 under the known gap (Decision 1, Question 2). |
  | IH5 | listed tmux [b]. |

- [ ] **Step 4: Update the specs.**
  - `catalog.spec.ts`:
    - `"every iTerm2 ring, a check or a probe, counts the other pages too: none on tmux's, herdr's or Other's"` becomes
      `"every iTerm2 ring, a check or a probe, counts the other pages exactly: its apart is every agent of the scenario
      on another page, in start order"`. The assertion compares `c.apart` with the non-ghost sessions whose
      `sessionPage` differs from `pageId(c.page)`, ordered by their start hooks.
    - `"IH4's ring fails with its herdr row also on herdr's page: an apps frame of iterm 1, herdr 1"` becomes `"IH4's ring
      on herdr's page counts no other page: an apps frame shown herdr with herdr 1 passes its apart, and iterm 1 beside
      it fails"`.
    - The own-wait list: `...starts('I6', 3)`, `...starts('I21', 4)`, and three `'I3 2000'` after I3's turns. The
      comment names I3's rests after the restart and after each pick.
  - `itermScenarios.spec.ts`: add `"I6 and I21 start d before b in b's tmux, so the pick lands on d and the swipe must
    move the dial to b"`.
  - `dialAppEval.spec.ts`: the I3 case becomes `"I3: after the devices start again, before any hook, a is on iTerm2's
    page and t, h and g on tmux's and herdr's: the apps frame counts iTerm2 1, tmux 1, herdr 2, and no Other page"`.
    It checks four things, all from the welcome after the restart:
    - the last ring is iTerm2's and holds [a];
    - the last `apps` frame's pages with agents, sorted, are `['herdr 2', 'iterm 1', 'tmux 1']`;
    - no ring holds a off iTerm2's page, or t, h or g on it;
    - no hook came after the restart.
  - `tierA/steps/herdr.spec.ts`, `"lsof names each client connected to the server's client socket and ps their ttys"`:
    both answers gain `nest: 'herdr'`, Task 3's confirmed answer.

- [ ] **Step 5: Run** `cd cli && npx vitest run src/testing/dialAppEval`. Expected: every case passes but "matches the
  baseline", which fails on the new keys and the shifted `wait.<i>` keys. The gate shows 0 wrong-session sends and no
  gap.

- [ ] **Step 6: Write tier A's baseline**, only once Question 1 is answered. Run `cd cli && npm run eval:dial-apps --
  --tier a --update-baseline`. This is tier A alone, on fakes: a plain local run, not the shared Mac eval slot.
  Expected: `baseline written`, and the `b/darwin` keys untouched. Then run `npx vitest run src/testing/dialAppEval`.
  Expected: PASS, "matches the baseline" among the passes.

  For the pull request, list each key that changed with its old and new score, and the app scores of
  `baseline.json apps.a`. Measured on a draft of these edits (2026-11-24):
  - wrong-session sends: 0;
  - iTerm2 tier A: 88.25 → 86.27;
  - held-out iTerm2: 90.36 → 91.07;
  - every other app: unchanged.

  The fall in the main score is I3's and I15's names gap after a restart, now counted on each page (Question 1).

- [ ] **Step 7: Commit green:** `Dial eval: a pick on the dial, and iTerm2's tmux and herdr agents on their own pages`.
  The commit holds every file of this task.

---

## Verification

Isolation follows the repo's e2e rules (`cli/AGENTS.md` rules 5 and 6, `cli/e2e/harness/daemon.ts`): each
`IsolatedDaemon` has a throwaway root, home, data folder, socket and port (never 18473), the in-memory fake backend with
a made-up machine and token (no person's account), the recording `open` (`HARNESS_OPEN_BIN`), the network guard in
every process, the daemon's private tmux server (`TMUX` and `TMUX_PANE` unset, `TMUX_TMPDIR` inside the root),
`PrivateHerdr` with `ownHerdrsOnly`, fake Terminal and iTerm2 apps under the throwaway home, the real
`harness hardware watch --json` under the daemon's environment alone, and a fake dial on the desk file. No Harness
Device runs, no window opens, nothing reaches Diego's terminals, tmux, herdr, Orca, `~/.claude`, `~/.codex`, daemon or
dial; `harness device notify` is never run. No check needs production or a person's login.

1. **Local gates on this Mac, final head, clean tree** (the tester): `cd cli && npm run typecheck`; `npx vitest run
   src/cable/hosts/outer.spec.ts src/cable/hosts/tmux.spec.ts src/cable/hosts/herdrOuter.spec.ts
   src/cable/hosts/select.spec.ts src/cable/hosts/appFilter.spec.ts src/cable/hosts/observed.spec.ts
   src/cable/cableHost.spec.ts src/services/devices.spec.ts src/testing/dialAppEval` (the last is tier A and the eval's
   own specs: a plain run on fakes, not the eval slot); `npm run test:core` (`devices.ts` is under `src/services/`: 100%
   per file); then `python3 scripts/local-checks.py --run` from the repo root, its output pasted into the PR body. Seen:
   all green, "matches the baseline" among them, `devices.ts` at 100%.
2. **macOS e2e, the tester on this Mac** (needs `tmux`, herdr 0.9.5 or later and the fake engines; a skipped file fails
   the check): `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts
   e2e/dialTmuxTerminal.e2e.ts e2e/dialHerdrTerminal.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/dialPaneFollow.e2e.ts
   e2e/dialAppFilter.e2e.ts`. Seen: all pass; the tmux and herdr agents on their own pages; a tab line for the client's
   tab gives `[device] tab · moved` and one `switched · follow`; plain-tab follows and the filter's other causes as on
   `main`. No repo workflow runs macOS e2e files.
3. **Both eval tiers on macOS, the tester on this Mac, only on the PM's go** (the Mac's eval slot is shared: one eval
   run at a time): `cd cli && TMPDIR=/tmp caffeinate -i npm run eval:dial-apps -- --update-baseline`, once. Seen: exit
   0; `Gate: passed` with 0 wrong-session sends; `baseline written`; `git diff cli/src/testing/dialAppEval/baseline.json`
   touches `b/darwin/` keys and `apps["b/darwin"]` alone (tier A is deterministic: a change to an `a/` key is a bug, not
   a refresh); no `b/darwin` key that was 1 on `main` is below 1 now, but those `RACED_B` names; the report's score
   table holds no app below `main`'s `baseline.json`, but what Question 1's answer accepts. The tester reports the report
   and that diff; an implementer commits the file as `Dial eval: tier B's baseline for iTerm2's new pages`, or, if any
   of these fails, it is thrown away (`git checkout -- cli/src/testing/dialAppEval/baseline.json`) and the failure is a
   finding. Merge only once this holds.
4. **Tier A on Linux:** PR CI's `cli-tests` runs the same spec (iTerm2's scenarios on injected darwin) against the
   macOS-written baseline. Seen: green; a difference is a determinism bug, not a baseline to refresh.
5. **PR CI jobs that start on their own:** `cli-typecheck`; `cli-tests`; `dial-hosts` (all of `cli/src/cable/hosts/`
   changed: the herdr kitty, WezTerm, pane and X11 files on Ubuntu, none skipped); `linux-e2e` (the e2e files this branch
   changed and the dial app eval's files, as `cli/src/cable/hosts/` changed); `windows-e2e` on x64 (`cli/src/cable/`
   changed: on Windows no `nest` is set and nothing changes). Seen: each green, `linux-e2e-summary` listing none of the
   eval files all skipped. If `linux-e2e` did not select the eval's files, run once by hand: **Actions → CI → Run
   workflow**, `scope=linux-e2e`, `e2e_files` naming them. No other extra run.
6. **The full CLI end-to-end suite, once, by hand on the final head, only on the PM's go** (one heavy workflow at a
   time, Decision 2): **Actions → CLI end to end → Run workflow** on the branch, as the settle's new `settling` step runs under every app's follow (Claude app, ChatGPT, VS Code, Orca), beyond
   the files this branch changes. Seen: green.
7. **Optional, needs Diego himself, not a merge gate:** after the release, his own dial with his own iTerm2 holding a
   plain Claude Code, one in tmux and two herdr panes reads "iTerm2 · 1", "tmux · 1", "herdr · 2", and the Pro shows the
   tmux and herdr rooms. No agent runs this check.

Proposal for the maintainers (not part of this branch): no workflow runs the dial's macOS-only e2e files
(`dialTmuxTerminal`, `dialHerdrTerminal`, `dialTerminalFollow`, tier B's iTerm2 file); a by-hand macOS job for them
would let later pull requests run checks 2 and 3 on GitHub.

## Decisions on the open questions (PM, 2026-11-23)

1. Accepted for now: a scan-found herdr agent whose herdr row has no session id is listed twice on herdr's page
   ("herdr · 2") until its first hook. Tasks 6 and 11 expect that count. The PR body names it as a known gap; the PM
   queues a separate item to fix it.
2. Verification 6 stays: one manual CLI end to end run on the final head, started only on the PM's go (one heavy
   workflow at a time).

## Open questions (2026-11-24, for the PM)

1. **The names gap after a restart, now counted on each page.** On `main` every row the scan finds after the devices
   start again has the wrong name (baseline I3 and I15 `ring.names` 0, `ringKept` 0, I15 `wait.19` 0). One ring per page
   (the brief's rule) repeats that zero on tmux's and herdr's page: I3 and I15 each gain `ringTmux.names`,
   `ringHerdr.names`, `ringKeptTmux`, `ringKeptHerdr` at 0, and I15 two `listed` waits that miss on it. Measured on a
   draft of Task 14: tier A iTerm2 88.25 → 86.27 (87.27 if I15's waits after the restart were the person's own, which
   needs an exception to catalog.spec's "a tap comes after a wait that lists its row"); no other app moves; 0
   wrong-session sends; every other new check passes. Tier B will likely move the same way. Choices: (a) accept the
   drop, the baseline records it, and the PR names it as the known names gap counted per page; (b) fix scan-found names
   after a restart first, as its own item, then land Task 14. Recommended: (a), I15 keeping its `listed` waits.
   Task 14 Step 6 waits for this answer.
2. **IH4 and the held-out file.** Under Decision 1's accepted gap, IH4 on herdr's page lists c and herdr's session-less
   row: `ring.precision` 1 → 0.5, `ring.apart` 0 → 1 (held-out iTerm2 90.36 → 91.07). IH2, IH4 and IH5 must change for
   the gate to pass, and `heldOut.ts` says whoever fixes a failing group does not read it. Recommended: Task 14's
   implementer edits them for the new pages only (no product fix is tuned to them), and the baseline records IH4's 0.5
   under Decision 1.
