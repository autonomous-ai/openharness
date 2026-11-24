# Dial: follow a tmux or herdr pane switch without typing: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a terminal app is settled in front and a dial is attached, moving to another pane of the person's tmux,
or another herdr pane, in the tab in front turns the dial to the agent in that pane, on tmux's or herdr's page, with no
typing. Eval scenarios I10 (tmux) and I11 (herdr) pass `focus.lands` and `focus.latency` in tiers A and B.

**Architecture:** Devices process only. tmux becomes one more place in the existing pane focus poll
(`HO/focusPoll.ts`, run by `SV/devices.ts`): the tmux adapter gains one read, `list-clients -F
'#{client_tty}|#{pane_id}'`, and the devices pick the front client by the tab the front app reported last (macOS tab
apps) or as the one client there, then the one live agent at that client's active pane. herdr is push: `herdrSource.ts`
adds `pane.focused` to the subscription it already holds and tells each focus event's pane to the devices, which follow
it under the same front and tab checks. Both follows turn the page first (`cableHost.followPage`), then ask the dials
(`cable.followLocal(id, 'pane')`), and neither follows the dial's own move of the last 2 s. Tier A's herdr model learns
to tell `pane.focused` subscribers where the real herdr 0.9.5 does, and nothing else of the eval changes but
`baseline.json`.

**Tech Stack:** TypeScript (Node 24), Vitest with injected fakes and fake timers, the CLI's e2e harness (isolated
daemon, private tmux server, `PrivateHerdr`, fake apps), the dial app eval (tier A spec, tier B e2e files).

**Spec:** `docs/plans/2026-11-24-dial-tmux-pane-focus-follow-design.md` (approved; read it with this plan). Base:
`feat/dial-tmux-pane-focus-follow` at `6f691add3f`. The spec and this plan are not committed yet: Task 1's commit adds
both.

Paths: `HO/` is `cli/src/cable/hosts/`; `SV/` is `cli/src/services/`; `EV/` is `cli/src/testing/dialAppEval/`.
Commands run in `cli/`.

## Decisions already made (PM, 2026-11-24): not reopened

1. Tier A's herdr model (`EV/tierA/steps/herdr.ts` and its spec) changes only to tell `pane.focused` subscribers the
   focus event exactly where real herdr 0.9.5 sends it. No other eval file changes but `EV/baseline.json`, regenerated at
   the end. Every check stays as it is; tier B, on a real herdr, must confirm. The eval is never weakened.
2. tmux: one more place in the existing focus poll (read-only `tmux list-clients -F '#{client_tty}|#{pane_id}'`,
   `FOCUS_READ_MS` timeout), only with a dial attached and the front app holding a tmux client of a live agent; 2 s
   echo; stops after 3 failures. No tmux hook, no control mode, nothing written to the person's tmux.
3. herdr: `pane.focused` on the existing `herdrSource` subscription (push). The tab check (the front app's last
   reported tab must be the agent's client tab, where the app reports tabs) applies to tmux and herdr.
4. Windows: not followed, documented as a gap (tmux only inside WSL; herdr's client-app lookup is macOS and Linux only).

## What this plan decides from the spec's words

- **Which agents.** Agents on tmux's or herdr's page (`select.ts pageOf(agent) === 'tmux'` or `'herdr'`), whose pane
  there names the front app as the app holding its client. One in tmux or herdr inside an Orca terminal is on Orca's
  page, so it is not read or followed: the spec's Out of scope ("tmux or herdr inside Orca") bounds its "in any app",
  and no line of the new code names Orca.
- **Scan-found agents are followed** (the spec's "Which agents"). `ObservedSource.byPane` and `paneOf` never read the
  pane the scan placed an agent at (observed.ts `shownOnly`), so the devices read these agents' tmux and herdr panes
  with `shownAt`, and find the agent of an answer the same way (`nestedAt`, Task 5). WezTerm's and kitty's places keep
  `paneOf` and `byPane`, their own panes alone.
- **One agent or nothing.** Two live agents at the pane that took the focus move nothing (the spec's "two candidates").
- **"Where the app reports tabs"** is a tab app on macOS: `isTabApp(app)` while the devices read ttys (`ttyOf`, darwin
  only). There, with no tab reported yet for that app, nothing moves: after the devices start again a pane move is
  followed from the app's next tab report (Harness Device tells the selected tab each time its polling turns to an app,
  `device-app/src-tauri/src/tabs.rs restart`).
- **The last reported tab** is set by every tab report, an echo's and one waiting for a settle too. What drops it is
  Open question 2; the tasks are written for its recommended answer.
- **The poll's places are compared by adapter.** The poll is kept while its front app and its set of adapters (`wezterm`
  or `kitty`, and `tmux`) are unchanged, and restarts when either changes. kitty's sockets inside kitty's adapter are
  read afresh at each read, as today, so WezTerm's and kitty's follows stay as they are.
- **herdr's own-move notes have a keeper of their own** (`herdrFocuses`, a `dialMovesTo()` as `paneTaps` is), not
  `paneTaps`: `dropPaneFocus` clears `paneTaps` whenever the poll stops or restarts, and herdr's event is push, which no
  poll's life should excuse or expose. The rule is the spec's: 2 s, each note excusing one event.
- **herdr's skip words.** A dial's own focus: `echo`. No agent, a held pane, two agents, or an agent off herdr's page:
  `unknown agent`. The pane's app not the settled front app, or its tab not the reported one: `not in front`. Checked in
  that order after "a dial is linked", so the dial's own event uses up its own note.
- **A failed place.** A place whose read failed keeps its last answer for that read; with no last answer it is left out
  of the read's answer. A client listing past 1024 lines is cut with no line of its own.
- **The measure's "before"** is the base commit: Task 4 lands its opt-in case first and runs it before any product
  change; Verification 3 runs it again on the final head.
- **Tier A's baseline is exact** (`EV/grade.ts tierAVerdict`): from Task 6 until Task 10 its `matches the baseline` case
  reports four stale keys. That is expected; any other key is not.

## Answered by the PM (2026-11-24)

1. **The held-out file runs when the baseline is regenerated: yes.** `npm run eval:dial-apps -- --update-baseline`
   writes nothing unless every tier B file wrote its results, the held-out one included (`EV/run.ts`: "was not
   written"). Run the one command, which runs that file; nobody opens it, its scenarios or its results' evidence, and the
   report gives its checks as a count. Verification 5 is written that way.
2. **What drops an app's last reported tab: another app, or none, settling in front.** The devices are told no app's
   quit (only `front` and `tab` lines); Harness Device reports the tab again each time the app comes to the front. Task 6
   is written that way, and the spec says so.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | Probe herdr's focus event, and record it | this plan, the spec, `cli/src/testing/fakeHerdr.ts`, `HO/herdrClient.ts` | none | high | none: a probe and recorded data, one commit |
| 2 | tmux's clients and the pane each shows | `HO/tmux.ts`, `HO/tmux.spec.ts`, `SV/devices.ts` (one line) | none | high | `tmux.spec.ts` `clientPanes` cases |
| 3 | An agent's tab, by its id | `HO/observed.ts`, `HO/observed.spec.ts` | none | medium | `observed.spec.ts` `tabTty` cases |
| 4 | The CPU measure | `cli/e2e/dialTmuxTerminal.e2e.ts` | none | high | none: test tooling, one commit |
| 5 | tmux's place in the poll: its life | `SV/devices.ts`, `SV/devices.spec.ts` | 2 | xhigh | `devices.spec.ts` "tmux: its life" |
| 6 | tmux's answer turns the dial | `SV/devices.ts`, `SV/devices.spec.ts` | 3, 5 | xhigh | `devices.spec.ts` "tmux: following" (I10) |
| 7 | Tier A's herdr tells the focus | `EV/tierA/steps/herdr.ts`, `EV/tierA/steps/herdr.spec.ts` | 1 | high | `herdr.spec.ts` focus cases |
| 8 | herdr's focus event turns the dial | `HO/herdrSource.ts`, `HO/herdrSource.spec.ts`, `HO/herdr.ts`, `HO/herdr.spec.ts`, `SV/devices.ts`, `SV/devices.spec.ts` | 1, 3, 6, 7 | xhigh | `herdrSource.spec.ts` focus cases, then `devices.spec.ts` "herdr" (I11) |
| 9 | The devices row | `cli/AGENTS.md` | 6, 8 | medium | none: docs, one commit |
| 10 | Tier A's baseline | `EV/baseline.json` | 6, 8 | medium | none: generated data, one commit |

**Longest chain:** 2 → 5 → 6 → 8 → 10 (five tasks). Tasks 1, 2, 3 and 4 start at once; 7 runs beside 5 and 6.
`SV/devices.ts` is one large file: 2, 5, 6 and 8 touch it and run one after another by their dependencies.

## Global Constraints

- `cd cli && npm ci` first: this worktree has no `node_modules`.
- Devices process only: `SV/devices.ts`, `HO/`, their specs, `cli/e2e/dialTmuxTerminal.e2e.ts`, `cli/AGENTS.md`.
  Nothing in `cli/src/core/`, `cli/hook/`, `cli/src/architecture.coreFiles.txt`, `device-app/`, `devices/` or
  `desktop/`.
- The eval: only `EV/tierA/steps/herdr.ts` and its spec (Task 7) and `EV/baseline.json` (Task 10, Verification 5)
  change. No check, scenario, threshold, grader, driver or other model. A check that looks wrong, or a main-set check
  other than I10's and I11's `focus.*` that changes: stop and tell the main session. Fix the product, never the eval.
- **Never read** `EV/heldOut.ts`, `cli/e2e/dialAppEvalHeldOut.e2e.ts`, a held-out scenario, or a held-out row of a
  results or report file. Read a report's main tables, `delta.checks` and the held-out count only.
- **Never the person's tmux or herdr.** Unit specs use fakes. Real tmux only on isolated sockets
  (`src/testing/isolatedTmux.ts`, an e2e daemon's `d.tmux`); real herdr only `e2e/harness/herdrServer.ts PrivateHerdr`,
  each `herdr` command through that daemon's pinned launcher (`join(d.binDir, 'herdr')`), never a bare `herdr` or
  `tmux`. Never the everyday daemon (18473), `~/.claude`, `~/.codex`, `harness device notify` or a screenshot.
- Nothing written to the person's tmux or herdr: the one new command is `list-clients -F '#{client_tty}|#{pane_id}'`,
  exactly, with no shell. No `set-hook`, option or control-mode client.
- Values, unchanged: `FOCUS_POLL_MS` 500, `FOCUS_READ_MS` 2_000, `FOCUS_FAILS_MAX` 3 (`HO/focusPoll.ts`);
  `PANES_A_LISTING` 1024 (`HO/tmux.ts`); `TAB_ECHO_MS` 2_000, `ATTACH_ECHO_MS` 2_000, `ECHO_KEPT` 8 (`SV/devices.ts`);
  `FRONT_SETTLE_MS` 1_000.
- Log lines: the existing `[device] pane · moved`, `[device] pane · skipped · no tile|echo|unknown agent|not in front`,
  `[device] focus poll · started`, `[device] focus poll · stopped · <n> reads, <m> failed[ · failing]`; new, and no
  others: `[device] herdr focus · skipped · not in front`, `· echo`, `· unknown agent`. Never a pane, tty, app or agent.
- Platforms: macOS and Linux. Windows is not followed and gets no `win32` branch.
- `SV/` is held at 100% per file (`npm run test:core`, which PR CI does not run): every new branch of `devices.ts` has
  its case; write no defensive branch a test cannot reach. Tasks 5, 6 and 8 end with `npm run test:core`.
- Every behavior task: a red commit (the failing tests), then a green commit. During a task run only the specs it
  touches, and `npm run typecheck` when a type or signature changed.
- A flipped expectation in an existing test changes only what the new rule says; no test is deleted or skipped.
- Tier A's baseline is exact: from Task 6 until Task 10 the spec's `matches the baseline` case says `stale baseline`
  for I10's two `focus` keys, and from Task 8 for I11's two as well. That is expected; any other key it names is not.
- One eval run on this Mac at a time. The whole tier A spec, `npm run eval:dial-apps` and the CPU measure need the main
  session's go (it asks the PM for the turn). The 21 iTerm2 scenarios of tier A by `-t` (Tasks 5, 6, 8) need none.
- Comments say why and name the spec; names and copy follow `docs/naming-system.md`; English. Commit only the task's
  files; never push.

## Review Focus

1. **The person turns the dial by hand to another agent while the tmux pane stays the same:** the next reads are
   unchanged and move nothing. Test: Task 6.
2. **Two tmux clients in two tabs of the front app, and the pane changes in the session whose tab is not the selected
   one** (another client, a script): nothing moves. Test: Task 6.
3. **A rest on a tmux agent, then a hand turn elsewhere before a read sees the rest's pane:** that read is the dial's
   own move and must not pull the dial back. Test: Task 6.
4. **herdr's focus moves while the person is on another tab of the same app** (a pane closing hands the focus on, a
   second client): nothing moves. Test: Task 8.
5. **tmux hangs to its 2 s timeout while WezTerm answers:** WezTerm's answer of that read still turns the dial when the
   read ends, and no failure is counted. Test: Task 5.

## Probe findings (Task 1 fills this in)

herdr version probed: 0.9.5. Host: macOS 26.6.2, arm64 (Darwin 25.6.0). Date: 2026-11-24. An isolated server
(`PrivateHerdr.start` on `IsolatedDaemon.create()`, the daemon never started), two idle fake agents `w2:p1` and `w3:p1`, the plain
workspace's `w1:p1` focused; one subscription to `pane.focused` held through rows 3 to 9, a second for row 10.

| # | What | The spec expects | Found |
|---|---|---|---|
| 1 | `herdr --version`, through the pinned launcher | 0.9.5 | `herdr 0.9.5` |
| 2 | `herdr api schema --json`, through the pinned launcher: the protocol, the subscription kind for a pane taking the focus, its event's fields | 22; `pane.focused`; `pane_id`, `workspace_id` | Protocol 22. `pane.focused` is a subscription kind; its event is `pane_focused`, data required `type` (`pane_focused`), `pane_id`, `workspace_id` |
| 3 | The first line of a subscription naming that kind | `subscription_started` under the request's id | `{"id":"s","result":{"type":"subscription_started"}}` |
| 4 | Lines in the second after the start, a pane focused, nothing moved | none (no replay) | none |
| 5 | `pane.focus` RPC to another pane (tier B's `herdr.focus` step): each line, whole | one line, event `pane_focused`, data `pane_id` and `workspace_id` | `{"data":{"pane_id":"w2:p1","type":"pane_focused","workspace_id":"w2"},"event":"pane_focused"}` |
| 6 | The same RPC again, the focus not moving | none | none |
| 7 | `herdr agent focus <pane>` to another pane (the dial's own move) | one line as row 5's | `{"data":{"pane_id":"w3:p1","type":"pane_focused","workspace_id":"w3"},"event":"pane_focused"}` |
| 8 | A new pane: `workspace.create` with a `cwd` (as `PrivateHerdr.pane`), then with `focus: true`, then `pane.split` of the focused pane | unknown: says whether an opening pane that takes the focus is told | `workspace.create` with a `cwd`: the new pane is not focused, no line. With `focus: true`: its pane takes the focus and one line, as row 5's, names it (`w5:p1`). `pane.split` (its `focus` defaults to false): the new pane is not focused, no line |
| 9 | `pane.close` of the focused pane | unknown: says whether the pane the focus goes to is told | Not told: the focus goes to the split beside it (`w5:p2`, per `pane.list`) and no line is written |
| 10 | A subscription naming an unknown kind beside a known one (`pane.nope`) | unknown: refused whole, or started | Refused whole: `{"id":"s2","error":{"code":"invalid_request",...}}` (``unknown variant `pane.nope` ``), then the connection closes; a later focus reaches only the first subscription |

Stop rules: rows 1, 2, 3 and 5 hold, so the task goes on. Row 4 shows no replay and row 6 no line. **Row 10 is
refused whole: the main session is told before Task 8 starts** (a herdr from before `pane.focused` would refuse the
devices' whole subscription).

Not probed: a focus the person moves in herdr's own screen (keys, mouse), and a second client. Verification 7.

## The iTerm2 check in tier A (Tasks 5 to 8)

iTerm2's 21 main scenarios of tier A, none held out, in process on fakes, compared with `baseline.json`. In `cli/`:

```bash
OUT=$(mktemp -d)
DIAL_EVAL_OUT="$OUT" npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts -t "tier A on darwin 'I[0-9]+'$"
node -e 'const fs=require("fs");const b=JSON.parse(fs.readFileSync("src/testing/dialAppEval/baseline.json","utf8")).checks;const r=JSON.parse(fs.readFileSync(process.argv[1]+"/results-a-spec.json","utf8"));for(const x of r.results){const k=[x.tier,x.platform,x.scenario,x.check].join("/");if(b[k]!==x.score)console.log(k,b[k],"->",x.score)}console.log("gaps",r.gaps.length,"wrong",r.wrongSends.length)' "$OUT"
```

The first command runs 21 cases, all passing (a case passes whatever its checks score). The second prints one line for
each check whose score differs from the baseline, then `gaps 0 wrong 0`. Each task says which lines it expects; any
other line, a gap or a wrong send: stop and tell the main session.

---

### Task 1: Probe herdr's focus event on an isolated server, and record it

**Depends on:** none. **Effort:** high. **Test that must fail first:** none (a probe and recorded data: one commit).

**Files:**
- Modify: this plan (`## Probe findings` only), the spec ("What the programs offer", only a sentence a finding
  contradicts), `cli/src/testing/fakeHerdr.ts` (`RECORDED.focused`), `HO/herdrClient.ts` (`HerdrEntry`)
- The spec and this plan are already committed as the branch's first commit (the main session's); edit only the parts
  named above.
- Throwaway, never committed: `cli/e2e/herdrFocusProbe.e2e.ts`

**Interfaces:**
- Produces: the ten rows above, filled; `RECORDED.focused: string[]` (the subscription's first line, then row 5's
  lines, as herdr wrote them; a path under the throwaway home, if any, shortened to `/work/hh` as the file's other
  recordings read), with a doc comment saying the herdr version, the host, the date and how it was made;
  `HerdrEntry`'s first member gains the kind row 2 names (expected `'pane.focused'`), with a comment giving the event's
  wire name and fields. Tasks 7 and 8 call the event's wire name `FOCUSED`.

- [ ] **Step 1: Write the probe**, `cli/e2e/herdrFocusProbe.e2e.ts`, `describe.skipIf(!herdrBinary)`, one case:
  `IsolatedDaemon.create()` (never `d.start()`), `PrivateHerdr.start(d)`, two agents (`herdr.agent('a', 'idle')`,
  `herdr.agent('b', 'idle')`), `launcher = join(d.binDir, 'herdr')` run with `d.env`. A raw `node:net` connection to
  `herdr.socket` writes `{"id":"s","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.focused"}]}}`
  and keeps every line with its time. Then rows 1 to 10 in order, each followed by a one-second wait for lines (a
  throwaway probe may wait). It prints one JSON object of the rows and closes herdr, then the daemon. Every `herdr`
  command is the launcher's; the person's socket (`~/.config/herdr`) is never opened.
- [ ] **Step 2: Run it:** `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/herdrFocusProbe.e2e.ts`.
  Expected: one passing case and the JSON. A skipped case is a failed probe.
- [ ] **Step 3: Fill the table** with what was found, word for word for rows 5 and 7, and apply the stop rules:
  - row 1 is not 0.9.5, rows 2 or 3 show no such kind, or row 5 writes no line: **stop**, commit nothing, and give the
    main session the table (decision 1 names 0.9.5; with no event on the RPC, tier B's I11 cannot pass by push);
  - row 4 shows a replay, or row 6 a line: finish this task, and tell the main session before Task 8 starts (the spec
    has no rule for an event with no change of focus);
  - row 10 is refused whole: finish this task, and tell the main session before Task 8 starts (a herdr from before this
    kind would lose its whole list).
- [ ] **Step 4: Record.** `RECORDED.focused` and `HerdrEntry` as in Interfaces; fix any spec sentence a row contradicts.
- [ ] **Step 5: Delete the probe file.** `git status --short` lists no `herdrFocusProbe`. Run `npm run typecheck` and
  `npx vitest run src/cable/hosts/herdrClient.spec.ts src/cable/hosts/herdrSource.spec.ts`. Expected: PASS.
- [ ] **Step 6: Commit** (one commit) `Dial: herdr 0.9.5's focus event, probed on an isolated server and recorded`.

---

### Task 2: tmux's clients and the pane each shows

**Depends on:** none. **Effort:** high. **Test that must fail first:** `tmux.spec.ts`, describe `"the clients of the
person's tmux and the pane each shows"`.

**Files:**
- Modify: `HO/tmux.ts`, `HO/tmux.spec.ts`, `SV/devices.ts` (the one `createTmuxAdapter` call: `platform: apps.platform`)

**Interfaces:**
- Produces:
  ```ts
  export interface TmuxDeps { /* as today, and: */ platform: NodeJS.Platform }   // whose form a client's tty is checked against
  /** Today's module-private `paneParts`, exported under this name. */
  export function tmuxPaneParts(pane: Pane): { id: string; pid: number; app?: string } | undefined
  export interface TmuxAdapter extends HostAdapter {
    /** Each client's terminal and the active pane of the session it shows, tty → `%N`; undefined when no tmux was
     *  found or the run failed. */
    clientPanes(): Promise<ReadonlyMap<string, string> | undefined>
  }
  export function createTmuxAdapter(deps: TmuxDeps): TmuxAdapter
  ```
  `runTmux(deps, args, timeoutMs = RUN_TIMEOUT_MS)`.

- [ ] **Step 1: Write the failing tests**, with the file's `recorder` (its `said.clients` is what `list-clients`
  prints):
  - `'one list-clients with the focus read\'s timeout gives each client\'s tty and its session\'s active pane'`:
    `'/dev/ttys004|%3\n/dev/ttys007|%12\n'` → `new Map([['/dev/ttys004', '%3'], ['/dev/ttys007', '%12']])`; `calls`
    is `[{ file: 'tmux', args: ['list-clients', '-F', '#{client_tty}|#{pane_id}'], timeoutMs: 2_000 }]`.
  - `'a line out of form is passed over'`: on darwin `'|%3\n/dev/pts/4|%5\n/dev/ttys004|3\n/dev/ttys005\n/dev/ttys006|%7\n'`
    → `new Map([['/dev/ttys006', '%7']])` (a control client has no tty); on linux `'/dev/pts/4|%5\n/dev/ttys004|%3\n'` →
    `new Map([['/dev/pts/4', '%5']])`; on win32 the same text → an empty map.
  - `'only the first 1024 lines are parsed'`: 1025 lines `/dev/ttys<n>|%<n>` → size `PANES_A_LISTING`, the last tty
    absent, and nothing logged.
  - `'no tmux found, an exit other than 0, and a run that rejects each answer undefined'`.
  - `'tmuxPaneParts gives the pane, the agent\'s process and its app'`: `'%3:100:iterm'` → `{ id: '%3', pid: 100, app:
    'iterm' }`; `'%3:100'` → `{ id: '%3', pid: 100 }`; `'%3'` and `'%3:100:nope'` → undefined.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/tmux.spec.ts -t 'clients of the person|tmuxPaneParts'`. Expected:
  FAIL (`clientPanes` is not a function). Commit red: `Dial: tmux's clients and the pane each shows (red)`.
- [ ] **Step 3: Implement.** The format is a constant beside `TMUX_CLIENT_PLACES`; each line is cut at its last bar, its
  tty held to `clientTtyForm(deps.platform)` and its pane to `TMUX_PANE_ID`; `FOCUS_READ_MS` comes from
  `focusPoll.js`, as `wezterm.ts` takes it. Comment why this timeout and not the adapter's 10 s (a read of a poll, the
  spec's "The read"). `tmux.spec.ts`'s comment "It takes no platform" now says only its client listing reads one.
  `SV/devices.ts` passes `platform: apps.platform`, and nothing else of it changes.
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/tmux.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit green** `Dial: tmux's clients and the pane each shows`.

---

### Task 3: An agent's tab, by its id

**Depends on:** none. **Effort:** medium. **Test that must fail first:** `observed.spec.ts` `tabTty` cases.

**Files:**
- Modify: `HO/observed.ts`, `HO/observed.spec.ts`

**Interfaces:**
- Produces, beside `windowOf`:
  ```ts
  /** A live agent's tab, the tty byTab reads: its own in a tab app, its multiplexer client's when nested (a hook's
   *  outer answer, or the scan's place); none when it has none, or its session ended. */
  tabTty(agentId: string): string | undefined
  ```

- [ ] **Step 1: Write the failing tests:**
  - in `'ObservedSource tabs'`, `'tabTty: a live agent\'s tty once read, none before, for an ended session or an unknown
    id'`;
  - in `'ObservedSource outer place'`, `'tabTty: a nested agent\'s is its client\'s tty, and none once no client holds
    it'`: after `t.asks[0].answer(CLIENT)` → `'/dev/ttys004'`; after a `turn-start` answered `{}` → undefined;
  - in `'ObservedSource and a nested session the scan found'`, `'tabTty: the scan\'s place gives it'`.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/observed.spec.ts -t tabTty`. Expected: FAIL (not a function).
  Commit red: `Dial: an agent's tab, by its id (red)`.
- [ ] **Step 3: Implement** `tabTty` from `Entry.tty`, live agents only.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit green** `Dial: an agent's tab, by its id`.

---

### Task 4: The CPU measure

**Depends on:** none. **Effort:** high. **Test that must fail first:** none (test tooling: one commit).

**Files:**
- Modify: `cli/e2e/dialTmuxTerminal.e2e.ts`

- [ ] **Step 1: Add the opt-in case**, in the file's describe: `describe.runIf(process.env.TMUX_FOCUS_CPU === '1')('CPU',
  …)`, one case `"the devices' CPU over a minute with the tmux client's tab in front, and with another app in front"`,
  timeout 300_000. With the file's `fresh()`: wait for `[device] tmux client · found`; `run.tab(await client.tty())`
  and wait for `[device] tab · moved`; time 20 runs of `d.tmux.run('list-clients', '-F', '#{client_tty}|#{pane_id}')`
  and keep the median as `readMs`; the devices' one pid from `d.servicePids('devices')`; its CPU time (`psTime` of `ps -o
  time= -p <pid>`, `e2e/harness/appEvalCost.ts`) at each end of a 60 s wait with Terminal in front, then of a 60 s wait
  after `run.front('com.mitchellh.ghostty')`. `reads` is the sum of the `<n>` of every `[device] focus poll · stopped ·
  <n> reads` line, 0 with none. It prints one line past the runner, `{ platform, arch, frontCpuPercent,
  awayCpuPercent, reads, readMs }`, and expects what holds with and without the poll: `reads` is at most one a
  `FOCUS_POLL_MS` from when `fresh()` returned (its watch has just told the front) to `FRONT_SETTLE_MS` after Ghostty
  was told in front, plus one, and no `[device] focus poll · started` line comes during the away minute. The two
  measured minutes are the only waits.
- [ ] **Step 2: Run the file as it runs by default:** `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts
  e2e/dialTmuxTerminal.e2e.ts`. Expected: its seven cases PASS, the CPU case skipped. `npm run typecheck`: PASS.
- [ ] **Step 3: Take the "before" numbers**, with the main session's go, alone on an idle Mac (no eval run, no other
  e2e). First check that `git log --oneline 6f691add3f..HEAD -- cli/src/services/devices.ts cli/src/cable/hosts/tmux.ts`
  prints nothing; if it prints, run in a throwaway worktree at `6f691add3f` with this file copied in. Then
  `TMUX_FOCUS_CPU=1 TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts
  -t CPU`. Expected: PASS, `reads` 0. Keep the JSON line for the commit message and the task report.
- [ ] **Step 4: Commit** (one commit) `Dial e2e: the devices' CPU with a tmux client's tab in front, by hand`, the
  "before" line in its body.

---

### Task 5: tmux's place in the pane focus poll: its life

**Depends on:** 2. **Effort:** xhigh. **Test that must fail first:** `devices.spec.ts`, describe `'the dial follows the
pane focused in tmux and herdr (docs/plans/2026-11-24-dial-tmux-pane-focus-follow-design.md)'`, sub-describe `'tmux:
its life'`.

**Files:**
- Modify: `SV/devices.ts`, `SV/devices.spec.ts` (the new describe at the end of the file; elsewhere only what Step 4
  names)

**Interfaces:**
- Consumes: `TmuxAdapter.clientPanes`, `tmuxPaneParts` (Task 2); `startFocusPoll`; `pageOf`; `ObservedSource.shownAt`.
- Produces, inside `startDevices` (Tasks 6 and 8 rely on these names):
  ```ts
  const tmux = createTmuxAdapter({ …, platform: apps.platform })   // kept unwrapped: the poll reads it. `adapters` holds noting(tmux)
  /** A pane focused in a place: the adapter whose pane it is, and the agent's pane id there (tmux's in full, `%3:100:iterm`). */
  type FocusedPane = { adapter: string; id: string }
  type PaneAnswer = { focused: ReadonlyMap<string, FocusedPane | null>; moves: number; at: number }
  /** The poll, the settled front app it runs for, the adapters whose places it reads there, … */
  type PaneFocus = { app: string; adapters: readonly string[]; poll: FocusPoll; first: boolean; last?: ReadonlyMap<string, FocusedPane | null> }
  /** The live agents on tmux's page whose tmux pane, their own or the one the scan placed them at, names [app]. */
  const tmuxPanes = (source: ObservedSource, app: string): Array<{ agent: HostAgent; full: string; pane: string }>
  /** The adapters whose places the poll reads with [app] settled in front: `wezterm` or `kitty` with an agent's own
   *  pane there, and `tmux` with a tmuxPanes entry. */
  const focusAdapters = (source: ObservedSource, app: string | undefined): string[]
  /** The live agent at that adapter's pane, its own or the one it was placed at, when exactly one is. */
  const nestedAt = (source: ObservedSource, adapter: string, id: string): HostAgent | undefined
  /** tmux's place. In this task: undefined when the listing failed, else null. Task 6 gives it its answer. */
  const tmuxFocused = (source: ObservedSource, app: string): Promise<FocusedPane | null | undefined>
  ```
  Place keys in an answer: `'wezterm'`, each kitty socket as today, `'tmux'`.

- [ ] **Step 1: Write the failing tests.** The scene on macOS, as the describe `"selecting a tmux client's tab turns
  the dial to tmux's page"` builds its own: `orca: { ...orca, platform: 'darwin', run }`, `TMUX_IN_ITERM` plus a second
  agent (`{ pid: 4243, ppid: 4001, tty: 'ttys031', executable: 'claude' }`, `{ pid: 4001, ppid: 3900, tty: 'ttys031',
  executable: 'zsh' }`), hooks `sess-1` (caller 4242, `TMUX_PANE` `%3`) and `sess-2` (4243, `%4`). `run` answers
  `display-message` for `%3` with `4000|work|` and for `%4` with `4001|work|`, `list-clients -t …` with
  `1794700050|4300|/dev/ttys002`, and the poll's read from a `tmuxSays` the test sets (`clients`, default
  `'/dev/ttys002|%3\n'`; `code`, default 0; `held`); a `select-pane -t %N` sets the listing's pane of
  `/dev/ttys002`. `READ` is `['tmux', ['list-clients', '-F', '#{client_tty}|#{pane_id}'], 2_000]`; `reads()`, `polls()`,
  `settle(app)` and `next(times)` as the WezTerm and kitty describe's, on its fake timers. The Linux scene: the first
  agent in a WezTerm pane of its own (maker `wezterm-gui`), the second in tmux whose client's parent is `wezterm-gui` on
  `/dev/pts/4`.
  - `'iTerm2 settled with a dial attached and an agent in a tmux pane whose client iTerm2 holds starts one poll'`:
    nothing before the settle; `[READ]` at it; `[READ, READ]` after `next()`; `polls()` is `[STARTED]`.
  - `it.each` `'nothing runs with %s'`: no dial attached; another app settled; a pane whose client is in no listed app;
    an agent in tmux inside an Orca terminal with Orca settled (its page is Orca's); the observed agents off.
  - `'another app settling, the last such agent ending, the last dial going and the devices stopping each stop it with
    its counts, and nothing runs after'`.
  - `'a dial attaching, and such an agent starting, with iTerm2 settled each start it'`.
  - `'WezTerm settled with an agent of its own, then an agent in tmux inside a WezTerm pane starts: the poll stops and
    starts with both places, and each read asks both'`: `polls()` is `[STARTED, stopped(n), STARTED]`.
  - `'a tmux read that fails beside WezTerm\'s good one is no failed read'`: `tmuxSays.code = 1` over five reads; no
    `· failing`; WezTerm's focus change still gives `calls('followLocal')` its agent, with no page switch.
  - Review Focus 5: `'tmux held to the end of its read while WezTerm answers: WezTerm\'s focus change turns the dial when
    the read ends, and no failure is counted'`.
  - `'WezTerm\'s read failing while tmux\'s lands is no failed read either'`.
  - `'tmux the only place: three failed reads stop it as failing, an agents\' change does not start it again, the next
    settle does'`: `stopped(3, 3) + ' · failing'`.
  - `'its lines name no pane, tty or agent'`: every `polls()` line matches the Global Constraints' two forms.
- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts -t 'tmux: its life'`. Expected: FAIL (no read, no
  line). Commit red: `Dial: the devices read tmux's place while an app holding its client is in front (red)`.
- [ ] **Step 3: Implement.** `checkPaneFocus` keeps the poll while `app` and `focusAdapters` are unchanged, else
  `dropPaneFocus` and a new one. A read asks every adapter of its poll at once; a failed adapter's places keep
  `paneFocus.last`'s entries, or are left out with none; the read fails only when every adapter failed.
  `paneAnswered` compares `last?.get(place)?.id` with the answer's id, looks a tmux pane's agent up with `nestedAt` and
  WezTerm's or kitty's with `byPane`, and keeps every guard it has. The section's comment block says what changed and
  why (the spec's "tmux: one more place in the pane focus poll").
- [ ] **Step 4: Run the whole spec:** `npx vitest run src/services/devices.spec.ts`. A case elsewhere that now fails
  only because the poll's own read or its `[device] focus poll` lines appear in a list it compares whole (the first to
  look at: `'a pick of tmux\'s page brings no app'`) leaves those out of that comparison with one shared filter;
  nothing else of it changes. Name each such case in the commit message. Expected: PASS.
- [ ] **Step 5: Run** `npm run typecheck` and `npm run test:core`. Expected: PASS, `SV/devices.ts` at 100%.
- [ ] **Step 6: Tier A is as it was.** Run the iTerm2 check in tier A (above). Expected: the one line `gaps 0 wrong 0`:
  this task follows nothing yet, so the poll's reads must change no check.
- [ ] **Step 7: Commit green** `Dial: the devices read tmux's place while an app holding its client is in front`.

---

### Task 6: tmux's answer turns the dial

**Depends on:** 3, 5. **Effort:** xhigh. **Test that must fail first:** `devices.spec.ts`, the same describe,
sub-describe `'tmux: following'`; its first case is I10 as a unit test.

**Files:**
- Modify: `SV/devices.ts`, `SV/devices.spec.ts`

**Interfaces:**
- Consumes: Task 5's names; `ObservedSource.tabTty` (Task 3); `isTabApp`, `type TabApp` (`HO/tabs.js`); `paneTaps`,
  `dialMoves`, `dialMovedAt`, `cableHost.followPage`, `cable.followLocal`.
- Produces (Task 8 relies on the first two):
  ```ts
  /** The tab each tab app reported selected last: set by every tab report, and an app's dropped when another app, or
   *  none, settles in front. */
  const lastTabs = new Map<TabApp, string>()
  /** Whether [app] reports its selected tab here: a tab app, on macOS. */
  const reportsTabs = (app: string): app is TabApp
  // tmuxPanes' entries gain `tty: string | undefined` (tabTty)
  // tmuxFocused answers the full pane id of the one agent at the front client's active pane, on that client's tty, else null
  ```

- [ ] **Step 1: Write the failing tests** on Task 5's scenes (`asked()` is `calls('followLocal')`; `report(app, tty)` is
  a tab line through the listener's handler; `shown()` reads `listAgentSnapshot({ apps: true })`):
  - I10: `'iTerm2 settled and its tmux tab reported: the person moves to the other pane, and the dials follow its agent
    on tmux\'s page'`: after the report and a read, then `tmuxSays.clients = '/dev/ttys002|%4\n'` and `next()`:
    `asked()` ends with `[agent of sess-2, 'pane']`, `shown()` is `tmux`, and one `[device] app filter: switched ·
    follow` was logged.
  - `'a tab app that reported no tab: nothing moves'`; `'a plain tab reported: a pane change in the tmux session moves
    nothing'`.
  - Review Focus 2: `'two tmux clients in two iTerm2 tabs: only the reported tab\'s client counts'`.
  - `'on Linux, with no tab reports, the one client of the front app that shows an agent\'s session is followed; with
    two such clients nothing moves'`.
  - `'a pane no agent runs in moves nothing, and coming back to the agent\'s pane turns the dial again'`.
  - `'the same %N under another client\'s tty moves nothing'`; `'two live agents at the front client\'s pane move
    nothing'`.
  - `'the dial\'s own rest on a tmux agent: the read that sees its pane is its echo within 2 s, and the person moving
    there again later turns the dial'`; the same for a tap.
  - Review Focus 3: `'a rest on one agent, then a hand turn elsewhere before a read sees the pane: the dial stays'`.
  - Review Focus 1: `'a hand turn while the pane stays: no read pulls the dial back'`.
  - `'the first answer after the poll starts is the settle\'s: followed, unless the dial moved within ATTACH_ECHO_MS'`.
  - `'an agent the scan placed at its tmux pane, with no hook yet, is followed'`.
  - `'another app, or none, settling drops the tab iTerm2 reported: back in iTerm2 nothing moves until it reports
    again'`.
  - `'not the latest in front: skipped as not in front'`; `'with no dial linked the reads go on and nothing is
    followed'`.
  - `'its lines name no pane, tty or agent'`: every `[device] pane` line matches the Global Constraints' forms.
- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts -t 'tmux: following'`. Expected: FAIL (nothing
  asked). Commit red: `Dial: moving to another tmux pane in the tab in front turns the dial (red)`.
- [ ] **Step 3: Implement.** `tabReported` sets `lastTabs` first; `appSettled` drops the other apps' entries in the
  `dial` part, before the `pane` part's check; the stop clears it. The front client: where `reportsTabs(app)`, the
  client on `lastTabs.get(app)`, none with no such client; else the one client whose tty is a `tmuxPanes` entry's, none
  with two or with none. `adapters` holds `noting` of tmux with its `focus` and `show` noting `paneTaps.note(pane.id)`
  as they start, as kitty's and WezTerm's `focus` are wrapped. `paneAnswered` calls `cableHost.followPage(agent.id)`
  before `cable.followLocal(agent.id, 'pane')` for a tmux pane alone. Comments: why the tty is matched (a second
  server's `%N` repeats), why a tab app with no report moves nothing.
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts`, `npm run typecheck`, `npm run test:core`. Expected:
  PASS, `SV/devices.ts` at 100%.
- [ ] **Step 5: I10 is green in tier A.** Run the iTerm2 check in tier A. Expected, and nothing else:
  ```
  a/darwin/I10/focus.lands 0 -> 1
  a/darwin/I10/focus.latency 0 -> 1
  gaps 0 wrong 0
  ```
  A `focus.latency` below 1 is a finding too: stop and tell the main session.
- [ ] **Step 6: Commit green** `Dial: moving to another tmux pane in the tab in front turns the dial`.

---

### Task 7: Tier A's herdr tells the focus

**Depends on:** 1. **Effort:** high. **Test that must fail first:** `EV/tierA/steps/herdr.spec.ts` focus cases.

**Files:**
- Modify: `EV/tierA/steps/herdr.ts`, `EV/tierA/steps/herdr.spec.ts`. No other eval file.

**Interfaces:**
- Consumes: the Probe findings (rows 4 to 9), `HerdrEntry`'s new kind, `FOCUSED` (Task 1).
- Produces: each open subscription whose kinds hold `'pane.focused'` hears `FOCUSED` with row 5's fields (`pane_id`,
  `workspace_id: 'w1'`, and any other field row 5 shows, as the model's `detected` builds its event), on a turn of its
  own (`hear`), exactly where the rows found the real server tells it.

- [ ] **Step 1: Write the failing tests** with the spec's `fakeWorld`; its `KINDS` gains the kind, as `herdrSource.ts`'s
  will:
  - `'a subscription naming pane.focused hears the pane the person focuses, and one that does not name it hears
    nothing'` (`herdrSteps['herdr.focus']`);
  - `'herdr agent focus tells it too'`, or, should row 7 have found none, `'herdr agent focus tells nothing'`;
  - one case each for rows 6, 8 and 9 as found: a focus that does not move, a pane opening, a focused pane closing;
  - `'a closed subscription hears nothing'`.
- [ ] **Step 2: Run** `npx vitest run src/testing/dialAppEval/tierA/steps/herdr.spec.ts`. Expected: the new cases FAIL.
  Commit red: `Dial eval: tier A's herdr tells pane.focused subscribers, as herdr 0.9.5 does (red)`.
- [ ] **Step 3: Implement** in `herdr.ts`: `hear` with `sub.kinds.has('pane.focused')` at `herdr.focus`, and at
  `herdrCommand`, `herdrPane` and a closing pane only where the rows say so. The header comment gains one sentence
  naming the probe. Nothing else of the model changes.
- [ ] **Step 4: Run** the same spec, `npx vitest run src/testing/dialAppEval/tierA`, and the iTerm2 check in tier A.
  Expected: PASS, and the check prints I10's two lines only if Task 6 has landed, else none: no product subscribes to
  the kind yet, so this task adds no line.
- [ ] **Step 5: Commit green** `Dial eval: tier A's herdr tells pane.focused subscribers, as herdr 0.9.5 does`.

---

### Task 8: herdr's focus event turns the dial

**Depends on:** 1, 3, 6, 7. **Effort:** xhigh. **Test that must fail first:** `herdrSource.spec.ts` focus cases, then
`devices.spec.ts`, the Task 5 describe's sub-describe `'herdr'`; its first case is I11 as a unit test.

Before starting: if Task 1 reported a replay, an event with no change of focus, or a refused unknown kind, wait for the
main session's word.

**PM decision after Task 1 (row 10, a refused unknown kind):** `pane.focused` is subscribed on a subscription of its own,
never in the agents' one, so a herdr that does not know the kind keeps the agents' rows. It opens when the agents'
subscription starts and closes with it (stop, replace by a new start, socket change); refused or closed, it logs one
fixed line and is not opened again until the source's next start. The source's tests change accordingly: the agents'
first subscription still names its three kinds (no change to that case), and a second subscription names
`pane.focused` alone; add cases for its refusal (the agents' rows stay and no reopen loop) and its close with the
agents' one. The spec's "herdr: the `pane.focused` event" and "Cost" say so.

**Files:**
- Modify: `HO/herdrSource.ts`, `HO/herdrSource.spec.ts`, `HO/herdr.ts`, `HO/herdr.spec.ts`, `SV/devices.ts`,
  `SV/devices.spec.ts`

**Interfaces:**
- Consumes: `FOCUSED`, `RECORDED.focused`, `HerdrEntry`'s kind (Task 1); `tabTty` (Task 3); `lastTabs`, `reportsTabs`
  (Task 6); `pageOf`; `ObservedSource.shownAt`.
- Produces:
  ```ts
  // herdrSource.ts
  export interface HerdrSourceDeps { /* as today, and: */ /** A pane herdr says took the focus, its bare id in form: told as it arrives, nothing kept. */ onFocus(paneId: string): void }
  // herdr.ts: today's module-private `paneParts`, exported under this name
  export function herdrPaneParts(pane: Pane): { id: string; app?: string; held?: true } | undefined
  // devices.ts
  /** The herdr panes the dial focused lately (a rest, a tap): herdr's event naming one is its echo. */
  const herdrFocuses = dialMovesTo()
  const herdrFocused = (source: ObservedSource, paneId: string): Promise<void> | undefined
  ```

- [ ] **Step 1: Write the source's failing tests** in `herdrSource.spec.ts` (its `KINDS` gains the kind; `setup` gives
  an `onFocus` spy):
  - `'the first subscription names the four kinds'` (the case that says three today);
  - `'a focus event tells its pane, and changes no row'`: `server.send(lines(RECORDED.focused))` → `onFocus` called
    once with the recorded pane id, `changes` unchanged;
  - `'a focus event with a pane id out of form tells nothing'`.
- [ ] **Step 2: Write the adapter's and the devices' failing tests.** In `herdr.spec.ts`, `'herdrPaneParts: the bare
  id, its app, and a held pane'`: `'w1:p2:iterm'` → `{ id: 'w1:p2', app: 'iterm' }`; `'w1:p2'` → `{ id: 'w1:p2' }`;
  `'held:w1:p2'` → `{ id: 'w1:p2', held: true }`; `'w1:p2:nope'` and `'x'` → undefined. In `devices.spec.ts`, a scene of
  two agents in panes `w1:p1` and `w1:p2` of the person's herdr whose client is in a Terminal tab on `/dev/ttys004` (the
  processes, sockets and runs of the describe `"an agent in the person's herdr, attached from a Terminal tab"`) and a
  herdr client the test drives (`withHerdr`'s); `focus(pane)` is `subs.at(-1).to.event(FOCUSED, { pane_id: pane,
  workspace_id: 'w1' })`:
  - I11: `'Terminal settled and the herdr client\'s tab reported: herdr says the other pane took the focus, and the dials
    follow its agent on herdr\'s page'`: `asked()` ends with `[its agent, 'pane']`, `shown()` is `herdr`.
  - `it.each` `'%s: skipped as not in front'`: another app settled; a tab app that reported no tab; Review Focus 4, a
    plain tab reported while herdr's focus moves.
  - `'on Linux, with no tab reports, it is followed with no tab check'`.
  - `'the dial\'s own rest runs herdr agent focus: the event for that pane is its echo; a second one, the person\'s, is
    followed'`; the same for a tap.
  - `it.each` `'%s: skipped as unknown agent'`: a pane no agent has; a held pane; two live agents at the pane; an agent
    in herdr inside an Orca terminal with Orca settled.
  - `'an agent herdr\'s own list placed at its pane, with no hook, is followed'`.
  - `'with no dial linked nothing is followed and nothing is logged'`.
  - `'its lines are fixed words'`: each matches `/^\[device\] herdr focus · skipped · (not in front|echo|unknown agent)$/`.

  The existing case `'with a dial attached herdr\'s agents are listed svf…'` expects the four kinds.
- [ ] **Step 3: Run** `npx vitest run src/cable/hosts/herdrSource.spec.ts src/cable/hosts/herdr.spec.ts` and `npx
  vitest run src/services/devices.spec.ts -t 'the pane focused in tmux and herdr'`. Expected: the new cases FAIL, and
  `npm run typecheck` fails on `onFocus` and `herdrPaneParts`. Commit red: `Dial: a herdr pane taking the focus turns
  the dial (red)`.
- [ ] **Step 4: Implement the source and the adapter.** `herdrSource.ts`: the kind in `KINDS`; in `event`, after the
  pane's form check, `FOCUSED` tells `deps.onFocus(pane)` and returns. `herdr.ts`: `paneParts` exported as
  `herdrPaneParts`.
- [ ] **Step 5: Implement the devices' side.** `herdrNoted` wraps `show` and `focus` to note the pane's bare id in
  `herdrFocuses` as they start; the source's `onFocus` is `part.call('herdr', () => herdrFocused(observed, paneId))`;
  `herdrFocused` checks in the order this plan decides (a dial linked; the dial's own echo; the one agent on herdr's
  page at that pane, not held; its app the settled front app; its tab, where the app reports tabs), then calls
  `cableHost.followPage`, then `cable.followLocal(id, 'pane')`; `herdrFocuses` is cleared as the last dial goes.
  Comments: why the echo is checked first (the note excuses its own event), why the tab is checked (herdr's focus can
  move while the person is on another tab).
- [ ] **Step 6: Run** `npx vitest run src/cable/hosts/herdrSource.spec.ts src/cable/hosts/herdr.spec.ts
  src/services/devices.spec.ts`, `npm run typecheck`, `npm run test:core`. Expected: PASS, `SV/devices.ts` at 100%.
- [ ] **Step 7: I11 is green in tier A.** Run the iTerm2 check in tier A. Expected, and nothing else:
  ```
  a/darwin/I10/focus.lands 0 -> 1
  a/darwin/I10/focus.latency 0 -> 1
  a/darwin/I11/focus.lands 0 -> 1
  a/darwin/I11/focus.latency 0 -> 1
  gaps 0 wrong 0
  ```
- [ ] **Step 8: Commit green** `Dial: a herdr pane taking the focus turns the dial`.

---

### Task 9: The devices row

**Depends on:** 6, 8. **Effort:** medium. **Test that must fail first:** none (docs: one commit).

**Files:**
- Modify: `cli/AGENTS.md` (the `devices` row only)

- [ ] **Step 1:** After the row's phrase that ends `` (`list-clients`, `get-colors --match`, `cable/hosts/focusPoll.ts`); ``
  add, in the row's words: moving to another pane of the person's tmux in the app settled in front moves the dial to
  its agent, on tmux's page, as one more place of that poll, one `tmux list-clients -F '#{client_tty}|#{pane_id}'` a
  read, only while an agent on tmux's page has its client in that app; the client is the one on the tab that app
  reported selected last where it reports tabs (Terminal, iTerm2 and Ghostty on macOS), else the one client there
  (`cable/hosts/tmux.ts` `clientPanes`); a pane herdr says took the focus (`pane.focused`, on the subscription herdr's
  source holds) moves the dial the same way, with no poll (`cable/hosts/herdrSource.ts`); the tab each of those apps
  reported last is kept in memory until another app settles in front, and the dial's own tmux and herdr moves of the
  last 2 s are not followed back; neither is followed on Windows, where tmux runs only inside WSL and herdr's panes
  carry no app. Word it from what Tasks 6 and 8 landed, and from Open question 2's answer.
- [ ] **Step 2: Commit** (one commit) `Docs: the devices follow a tmux or herdr pane switch`.

---

### Task 10: Tier A's baseline

**Depends on:** 6, 8. **Effort:** medium. **Test that must fail first:** none (generated data: one commit). With the
main session's go for the Mac's eval turn.

**Files:**
- Modify: `EV/baseline.json`

- [ ] **Step 1: Run** `OUT=$(mktemp -d); DIAL_EVAL_OUT="$OUT" caffeinate -i npm run
  eval:dial-apps -- --tier a --update-baseline`. Expected: `baseline written`, exit 0.
- [ ] **Step 2: Check** `$OUT/report.json`: `gate.passed` is true; `delta.checks` is exactly the four keys of Task 8's
  Step 7, each 0 → 1; `delta.apps.a.iterm.after` is above `91.66666666666666` and no other app's `after` is below its
  `before`. Report `delta.heldOutChanged` as a number. Any other main-set key: `git checkout --
  cli/src/testing/dialAppEval/baseline.json`, stop and tell the main session (tier A is deterministic: it is a bug, not
  a refresh).
- [ ] **Step 3: Run** `npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts`, under the same turn. Expected: PASS,
  `matches the baseline` among its cases.
- [ ] **Step 4: Commit** (one commit) `Dial eval: tier A's baseline with the pane follow`.

---

## Verification

Every check runs on the final head, after the final review's fixes. Isolation is the harness's own (cli/AGENTS.md rules
5 and 6): each e2e case's `IsolatedDaemon` has a throwaway home, data folder and port; tmux is the daemon's private
server (`d.tmux`, its socket in the daemon's root); herdr is `PrivateHerdr`, its config in that home, with
`ownHerdrsOnly`; iTerm2 and Terminal are the harness's fake apps; the dial is a file on the desk; `open` is the
harness's fake; the front and the tabs are lines the test writes to the real `harness hardware watch --json`. Test
accounts only (`FakeBackend`'s made-up machine); no real backend, no production.

1. **Unit and coverage, on this Mac.** `npm run typecheck`; `npx vitest run src/cable/hosts/tmux.spec.ts
   src/cable/hosts/observed.spec.ts src/cable/hosts/herdr.spec.ts src/cable/hosts/herdrSource.spec.ts
   src/cable/hosts/herdrClient.spec.ts src/cable/hosts/focusPoll.spec.ts src/services/devices.spec.ts
   src/testing/dialAppEval/tierA`; `npm run test:core` (required: `SV/devices.ts` at 100%; PR CI does not run it). Then
   `python3 scripts/local-checks.py --run` from the repo root on a clean tree, its output in the PR body before the
   push. Seen: all green.
2. **macOS end to end, the tester on this Mac** (needs `tmux`, herdr and `cc`; a skipped file fails the check):
   `TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts
   e2e/dialHerdrTerminal.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/dialPaneFocusFollow.e2e.ts e2e/deviceHerdr.e2e.ts`.
   Seen: all pass, as on `main`: the tab follow, the rests and taps, and WezTerm's and kitty's pane follow, whose poll
   this branch changed. No repo workflow runs the macOS-only ones.
3. **The poll's cost, the tester on this Mac, alone on an idle machine, with the main session's go.**
   `TMUX_FOCUS_CPU=1 TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts
   -t CPU`. Seen: PASS; `reads` at least 100 (a minute in front, one read each 500 ms after the last ended); no poll
   started while away. The PR lists this line ("after") beside Task 4's ("before"): `frontCpuPercent`,
   `awayCpuPercent`, `reads`, `readMs`. A `frontCpuPercent` more than 1 point above "before" is a finding for the main
   session.
4. **Tier A, all apps, on this Mac.** `npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts`. Seen: every
   scenario on darwin, win32 and linux passes, `matches the baseline` among them. PR CI's `cli-tests` runs the same spec
   on Linux against the macOS-written baseline; a difference there is a determinism bug, not a baseline to refresh.
5. **Both tiers and the baseline, the tester on this Mac, one run, only on the PM's go** (one eval run on this Mac at a
   time; the main session asks for the turn): `OUT=$(mktemp -d); DIAL_EVAL_OUT="$OUT" TMPDIR=/tmp
   caffeinate -i npm run eval:dial-apps -- --update-baseline`. It runs tier A's spec, then tier B's files:
   `e2e/dialAppEvalIterm.e2e.ts` (macOS only: I10 and I11 on the daemon's private tmux and the private herdr),
   `dialAppEvalClaude`, `dialAppEvalChatgpt`, `dialAppEvalVscode`, `dialAppEvalCursor`, `dialAppEvalOrca`, and the
   held-out file, which the command needs to write a baseline (Open question 1): nobody opens that file or its results.
   The merge gate, read from `$OUT/report.md` and `report.json`:
   - `Gate: passed`, 0 wrong-session sends. One wrong send: stop and ask the PM before any baseline is written;
   - `b/darwin/I10/focus.lands` and `b/darwin/I11/focus.lands` are 1, their `focus.latency` reported;
   - iTerm2's score is above `baseline.json`'s on `main` in `a` (91.67) and in `b/darwin` (87.43);
   - no other app's score is below its `baseline.json` value. A lower score that comes only from timed checks
     (`timed` in the results: a latency, `cost.cpu`, `cost.loopP99`, `ring.change`, a `wait`) or from `grade.ts RACED_B`'s
     four keys is the runner's noise by the eval's CI rules, not a drop; a pass/fail check that was 1 and is below 1 is a
     drop;
   - `git diff cli/src/testing/dialAppEval/baseline.json` touches `b/darwin` keys and `apps["b/darwin"]` alone (tier
     A's part is Task 10's).

   Tier B's daemon notes every `list-clients` the devices run (`e2e/harness/appEvalDriver.ts TMUX_RECORDED`), the
   poll's reads too: a `cost` or `open` check of iTerm2 that falls for it is a finding for the main session, never an
   eval change.

   The tester reports the score table, the held-out table and count as printed, and that diff. An implementer commits
   the file as `Dial eval: tier B's baseline with the pane follow`; if any line above fails, it is thrown away (`git
   checkout -- cli/src/testing/dialAppEval/baseline.json`) and the failure is a finding. If another hill-climb merged
   first: rebase onto `main`, review the combined change, and run this check again from the start; the command writes
   tier A's part again too.
6. **PR CI, on its own, nothing started by hand:** `cli-typecheck`; `cli-tests` (tier A on Linux); `dial-hosts`
   (`cli/src/cable/hosts/` changed: real herdr 0.9.5, WezTerm, Zellij and kitty on Ubuntu, none skipped); `linux-e2e`
   (the dial app eval's files, as `HO/`, `SV/devices.ts` and `EV/` changed, and `dialTmuxTerminal.e2e.ts`, which skips
   on Linux and is listed so); `windows-e2e` on x64 (`cli/src/cable/` changed: nothing is followed there). Seen: each
   green. **Tier B by hand on GitHub:** `ci.yml`'s `workflow_dispatch` (Actions → CI → Run workflow, `scope`
   `linux-e2e`, `e2e_files` naming them) can run tier B's files for Claude, ChatGPT, VS Code, Cursor and Orca on Ubuntu,
   and only as a rerun of a job that failed; no workflow can run `dialAppEvalIterm.e2e.ts`, which is macOS only, so I10
   and I11 in tier B are checked locally (check 5).
7. **Needs Diego himself, after the release, not a merge gate:** with his own dial, iTerm2 in front on a tab holding
   his tmux, he moves to another pane with tmux's own keys; then the same in his herdr with herdr's own keys or mouse,
   which the probe did not cover. He should see the dial turn to that pane's agent within about a second, and stay put
   when he selects a plain tab. No agent runs this check, and none reads his terminals.
8. **Production:** none.

## What the pull request says

- Platforms: macOS and Linux; Windows is not followed (tmux only inside WSL; herdr's panes carry no app there).
- Tier A's herdr model now tells `pane.focused` subscribers, as herdr 0.9.5 does (the Probe findings, in full), by the
  PM's decision of 2026-11-24; no check changed; tier B on a real herdr confirms (check 5).
- The numbers: "before" and "after" of check 3; the eval's score table and `baseline.json`'s diff.
- `npm run test:core`'s receipt; that the end-to-end proof is tier B's I10 and I11 on macOS, run locally.

## Proposals (not in this branch)

- A by-hand macOS job for the dial's macOS-only e2e files (`dialAppEvalIterm`, `dialTmuxTerminal`,
  `dialHerdrTerminal`, `dialTerminalFollow`), so later pull requests run checks 2 and 5 on GitHub.
- A case on the existing `cli-e2e-dial-hosts.yml` job (real herdr 0.9.5 and tmux in a kitty window on Ubuntu) for the
  pane follow on Linux, which this branch covers by unit tests alone.
