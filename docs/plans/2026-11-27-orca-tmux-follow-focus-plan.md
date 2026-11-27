# Dial: follow focus into tmux inside an Orca tab: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With Claude Code (or another engine) under tmux in an Orca tab, focusing that tab turns the dial to the agent
tmux shows there, and a tmux pane switch in that tab turns it to that pane's agent, with no prompt typed. Eval O24 and
O25 pass in tier A on macOS and Linux; O26 (two tmux tabs that cannot be told apart) still moves nothing.

**Architecture:** Devices process only (`SV/devices.ts`). `placeInOrca` places the tmux client of the one free Orca
terminal of a folder and engine when every candidate agent there is nested in tmux on that one client, then every agent
of that client in that folder. Orca's focus watch then tells which client is in front (`orcaClient`), and the existing
tmux pane poll (#4591) reads that client with one `tmux list-clients` while Orca is settled in front. Tier A's model
gets one Orca terminal and one tmux session per worktree and tab for sessions under tmux; three new scenarios grade it.

**Tech Stack:** TypeScript (Node 24), Vitest with injected fakes and fake timers, the dial app eval's tier A (in process,
virtual time), its grader and baseline.

**Spec:** `docs/plans/2026-11-27-orca-tmux-follow-focus-design.md` (approved; read it with this plan). Base:
`feat/orca-tmux-follow-focus` at `a9555a1219`. The spec and this plan are untracked: the main session commits them
before Task 1 starts.

Paths: `SV/` is `cli/src/services/`; `EV/` is `cli/src/testing/dialAppEval/`. Commands run in `cli/`.

## Decisions already made (PM, 2026-11-27): not reopened

1. Follow only (an Orca tab switch, a tmux pane switch in an Orca tab). No `host: 'orca'` for the Pro's Orca room.
2. Two tmux tabs of one engine in one worktree that cannot be told apart: never placed, never followed. When unsure,
   place nothing and follow nothing.
3. Several agents under one tmux in one Orca tab are all placed at that tab; each keeps its session's name (the tab's
   name only when one agent is placed there).
4. Eval tier A only: O24, O25, O26 (darwin and linux), and tier A's model of a shared Orca terminal and tmux session per
   worktree and tab.
5. Tier B with a real tmux client in the Orca stand-in: out of this branch.

## What this plan decides from the spec and the code

- **The placement's state.** `placeInOrca` returns the agents placed (agent id → handle, as today) and the clients
  placed (handle → client tty). `readOrcaOrder` keeps the clients and the agents placed by a client in `orcaTmux`,
  replaced at each read that lands, as `orcaTabRank` is, and set before `setPaneNames`, whose change starts the poll.
- **"Today's single agent".** One candidate with no client (not nested in tmux, or no `tabTty`) is placed alone, as
  today. One nested candidate with a client places its client, and itself through it (step 2), so a client another
  terminal would take places it nowhere (decision 2).
- **Names.** A handle that two or more placed agents share is left out of the names `setPaneNames('orca', …)` gets,
  renamed or not; `observed.ts` `nameOf` then gives each its session's title, else its folder's.
- **The told client** is set before every place that reads it: in `focusLine` before the `not in front` return, at the
  start of `orcaSettled`, and in `readOrcaOrder` before `setPaneNames`. It is cleared with the watch (its end, `dropFocus`).
- **The watch's first line as the settle** (Open question 4): a first line naming a terminal with a placed client marks
  Orca's poll's next answer as its first, so `ATTACH_ECHO_MS` guards it as it guards `followFocus`'s settle (#4311).
  Without it, Orca's first settle after a dial attaches would turn back a dial turned as Orca came forward.
- **The focus line itself** goes on as today (the spec): `followFocus` runs and logs `[device] focus · skipped · unknown
  agent` for a tmux tab, as no agent has that terminal as its own pane. The poll's own lines say what it did.
- **The poll's checks for Orca** go in `onTabInFront` (its one other caller, herdr's follow, skips agents in Orca first):
  for `orca`, the agent's `tabTty` is `orcaClient` and `orcaTmux.agents` places it at `focusWatch.pane`.
- **Tier A's shared terminal.** The Orca sessions with `tmux: true` in one worktree and tab are one group; its lead is
  the first by split, then by declaration. The group's terminal is the lead's handle (`orcaPaneHandle(lead, launch)`),
  in its hooks, `orca.focus`, the listing and the front alike. O11's group is c alone, so O11 is unchanged.
- **The grader stays as it is.** `checks.ts` `orcaOpenParts` and `orcaTitle` read each session's own handle and tab.
  Right for O11 and O24-O26 (no tap on a group's second member, no renamed shared tab); a later scenario with either
  needs the grader to read the group's terminal, a task of its own.
- **Where the red lands.** O24's and O25's red is Task 4's: its inline cases in `EV/dialAppEval.spec.ts` run the new
  scenarios on a base where Tasks 1 to 3 have landed and nothing follows yet, so they fail; the follow turns them green.
  Task 3's own red is the scenarios' definitions (`orcaScenarios.spec.ts`, `catalog.spec.ts`).
- **The baseline is never a task's.** From Task 3 on, tier A's `matches the baseline` names O24-O26's keys as missing;
  every run below uses `DIAL_EVAL_SKIP_RATCHET=1` until Verification 3 writes the baseline with the eval tool.
- **The CPU measure** (Open question 2): no e2e can stand Orca in front of a real tmux client without decision 5's
  backlog item. Task 4 counts the poll's tmux reads in tier A's virtual time; Verification 4 runs #4591's iTerm2 CPU
  case before and after, as the read and the poll are the same.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | Placement by the tmux client | `SV/devices.ts`, `SV/devices.spec.ts` | none | xhigh | `devices.spec.ts` "tmux inside an Orca tab" › "placement by the tmux client" |
| 2 | Tier A: one Orca terminal and tmux session per worktree and tab | `EV/tierA/steps/sessions.ts`, `EV/tierA/steps/tmux.ts`, `EV/tierA/steps/orca.ts`, `EV/orcaListing.ts`, `EV/types.ts` (comments), their specs | none | high | `tmux.spec.ts`, `sessions.spec.ts`, `orca.spec.ts`, `orcaListing.spec.ts` shared-tab cases |
| 3 | O24, O25, O26 | `EV/orcaScenarios.ts`, `EV/orcaScenarios.spec.ts`, `EV/catalog.spec.ts` | 2 | high | `orcaScenarios.spec.ts` ids, platforms, dims, O24-O26 cases; `catalog.spec.ts` ids, counts, tiers, waits |
| 4 | Orca's told client and the poll | `SV/devices.ts`, `SV/devices.spec.ts`, `EV/dialAppEval.spec.ts` | 1, 3 | xhigh | `devices.spec.ts` "tmux inside an Orca tab" › "following"; `dialAppEval.spec.ts` O24, O25 and the cost case |
| 5 | The docs | `cli/AGENTS.md`, `docs/plans/2026-11-22-dial-eval-orca-design.md` | 1, 3, 4 | medium | none: docs, one commit |

**Longest chain:** 2 → 3 → 4 → 5 (four tasks). Tasks 1 and 2 start at once. `SV/devices.ts` and its spec are Tasks 1
and 4 only, one after the other.

## Global Constraints

- `cd cli && npm ci` first: this worktree has no `node_modules`.
- Only the files of the table. Nothing in `cli/src/core/`, `cli/hook/`, `cli/src/cable/` (no change there is planned: a
  task that finds it needs one stops and tells the main session), `cli/e2e/`, `devices/`, `device-app/`, `desktop/`.
- **Never read** `EV/heldOut.ts`, `cli/e2e/dialAppEvalHeldOut.e2e.ts`, a held-out scenario (OH*, IH* and the rest) or a
  held-out row of a results or report file; never grep inside them. `catalog.spec.ts`'s held-out ids and counts are
  read as they are, and only its totals move with the main ids.
- `EV/baseline.json` changes only by `npm run eval:dial-apps -- --tier a --update-baseline` (Verification 3), never by a
  task, never by hand.
- **Never the person's tmux, Orca, herdr, `claude` or `codex`**, no `orca` CLI, no `harness device notify`, no
  screenshot. Never `pgrep -f`, `ps aux` or `ps -o args`; `ps` only for a test's own devices pid (the CPU case). Real tmux
  only on isolated servers (`src/testing/isolatedTmux.ts`, an e2e daemon's `d.tmux`); unit specs and tier A use fakes.
- **The Mac is shared.** Before running tests, ask the main session whether a dial eval or e2e runs (it asks the PM);
  never list processes to find out. `npm run test:core`, a tier A `-t` run and every e2e need its go. One eval at a time.
- Nothing written to the person's tmux or Orca: no new command. The poll's one read stays `tmux list-clients -F
  '#{client_tty}|#{pane_id}'` (`HO/tmux.ts` `clientPanes`), with no shell.
- Values, unchanged: `FOCUS_POLL_MS` 500, `FOCUS_READ_MS` 2_000, `FOCUS_FAILS_MAX` 3 (`cable/hosts/focusPoll.ts`);
  `TAB_ECHO_MS` 2_000, `ATTACH_ECHO_MS` 2_000 (`SV/devices.ts`); `ORCA_ECHO_MS` 1_500 (`EV/types.ts`).
- Log lines: no new one. The existing `[device] orca order · …`, `[device] focus · skipped · …`, `[device] pane ·
  skipped · echo|unknown agent|not in front`, `[device] focus poll · started|stopped · …`. Never a tty, pane, handle,
  title or agent in a line.
- `SV/` is held at 100% per file (`npm run test:core`, which PR CI does not run): every new branch has its case, and no
  defensive branch a test cannot reach. Tasks 1 and 4 end with `npm run test:core`.
- Every behavior task: a red commit (the failing tests), then a green commit. Run only the specs the task touches, plus
  `npm run typecheck` when a type or signature changes. A flipped expectation changes only what the new rule says; no
  test is deleted or skipped.
- Tier A is deterministic: an Orca key that changes where a task does not say it will, or any key of another app, is a
  finding: stop and tell the main session. Fix the product or the model as the spec says, never a check to pass.
- Fixtures are made up (`Eval …` titles, `/work/…` folders); no result's evidence holds a tty, pane id or handle (the
  privacy case in `EV/dialAppEval.spec.ts` stays green).
- Platforms: macOS and Linux. Windows gets no branch (tmux runs only inside WSL there).
- Comments say why and name the spec; names and copy follow `docs/naming-system.md`; English. Commit only the task's
  files; never push.

## The Orca check in tier A (Tasks 1 to 4)

Orca's main scenarios of tier A on the three platforms, none held out, in process on fakes, against `baseline.json`:

```bash
OUT=$(mktemp -d)
DIAL_EVAL_OUT="$OUT" DIAL_EVAL_SKIP_RATCHET=1 TMPDIR=/tmp npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts -t "^tier A on [a-z0-9]+ '?O[0-9]+'?$"
node -e 'const fs=require("fs");const b=JSON.parse(fs.readFileSync("src/testing/dialAppEval/baseline.json","utf8")).checks;const r=JSON.parse(fs.readFileSync(process.argv[1]+"/results-a-spec.json","utf8"));for(const x of r.results){const k=[x.tier,x.platform,x.scenario,x.check].join("/");if(b[k]!==x.score)console.log(k,b[k],"->",x.score)}console.log("gaps",r.gaps.length,"wrong",r.wrongSends.length)' "$OUT"
```

Every case passes (a case passes whatever its checks score). The second command prints each check whose score differs
from the baseline (a new key as `undefined -> n`), then `gaps 0 wrong 0`. Each task says which lines it expects.

## Review Focus

1. **The tmux tab's client switched to another tmux session** (`tmux switch -t other` in that tab): the dial follows the
   agent there only when it is placed at the terminal in focus, else nothing moves. Test: Task 4.
2. **A plain Claude Code the scan found, with no pane, in another Orca tab of the same folder** beside one tmux tab:
   it blocks the placement, so neither the tmux agents nor it are placed or followed. Test: Task 1.
3. **The person turns the dial as Orca first comes forward on a tmux tab** (the watch's first line after a dial
   attached): the poll's answer does not turn it back within `ATTACH_ECHO_MS`. Test: Task 4.
4. **Words to the second agent placed by its client:** a tap switches Orca to that terminal, and voice goes by its mod,
   never typed into the Orca terminal or tmux. Test: Task 1.
5. **The tmux lookup lands after Orca's order read** (Orca's CLI faster than tmux and `ps`): the agent is placed by its
   client at the next read, which the client's landing asks for. Test: Task 1.

---

### Task 1: Placement by the tmux client

**Depends on:** none. **Effort:** xhigh. **Test that must fail first:** `devices.spec.ts`, new describe `'tmux inside an
Orca tab (docs/plans/2026-11-27-orca-tmux-follow-focus-design.md)'`, sub-describe `'placement by the tmux client'`.

**Files:**
- Modify: `SV/devices.ts` (`placeInOrca`, `readOrcaOrder`, `orcaMembers`, the section's comment)
- Test: `SV/devices.spec.ts` (the new describe at the end of the file)

**Interfaces:**
- Produces (Task 4 reads them):
  ```ts
  /** The agents placed at an Orca terminal (agent id → handle) and the tmux client placed at one (handle → its tty). */
  const placeInOrca = (source: ObservedSource, terminals: readonly OrcaTerminal[]): { placed: Map<string, string>; clients: Map<string, string> }
  /** From the last order read that landed: the tmux client placed at each Orca terminal, by handle, and each agent placed
   *  there by that client (agent id → handle). Orca's told client and the poll read it (Task 4). */
  let orcaTmux: { clients: ReadonlyMap<string, string>; agents: ReadonlyMap<string, string> }
  ```
- The rules (spec §1), in this order:
  1. As today: `held` is the ring's agents' own Orca panes; candidates by `[folder, engine]` are the ring's agents with no
     Orca pane and a folder; free terminals by `[worktreePath, agentIdentity]` are those no own pane holds.
  2. For each key with exactly one free terminal `h`: one candidate with no client (`nest !== 'tmux'` or no `tabTty`) is
     placed at `h`, as today. Else, when every candidate has `nest === 'tmux'` and one and the same `tabTty` T, T is
     wanted at `h`. Else nothing.
  3. A T wanted at two or more terminals is dropped from all of them; the rest are `clients`.
  4. For each `h → T` of `clients`: every ring agent with no Orca pane, `nest === 'tmux'`, `cwd` equal to `h`'s
     `worktreePath` and `tabTty === T` is placed at `h`, whatever its engine; these are `orcaTmux.agents`.
- `orcaMembers`' key of an agent is its id, its Orca pane and its `tabTty`: a client landing, or changing, asks one more
  read (Open question 1).
- `readOrcaOrder` sets `orcaTmux` before `setPaneNames`, and leaves out of the names every handle two or more agents of
  `placed` share.

- [ ] **Step 1: Write the failing tests.** The scene (`orcaTmux(over)`, used again by Task 4): macOS; agents `c`
  (sess-1) and `d` (sess-2) in panes `%3` and `%4` of the person's tmux session `work`, its one client on `/dev/ttys002`
  under a shell in Orca terminal H(2), Orca's process above it (as the tmux describe's `IN_ORCA` rows; with `second`, `%4`'s
  session has a client of its own on `/dev/ttys003`); their hooks carry `TMUX_PANE`, `TERM_PROGRAM=tmux`,
  `ORCA_AGENT_SESSION_ID`, `ORCA_TERMINAL_HANDLE: H(2)` and Orca's bundle id, `cwd: '/work/api'`; a plain agent `a`
  (sess-3) in its own Orca terminal H(1); tmux's runs answered as the tmux describe's `runOn` does; Orca's reads from
  `fakeOrcaReads`, landed with `land(tabs, terminals)` as the ring describe does; a dial attached. Fixtures of other
  describes the scene needs are hoisted to the file's scope unchanged. Cases (`ring()`, `names()` as the ring
  describe's; unranked agents come after the ranked in entry order):
  - `'two agents under one tmux client in the one free terminal of their folder and engine are both placed there: they share its rank and its scope'`:
    tabs `[H(2), H(1)]`, terminals `[claudeIn(1), claudeIn(2)]` → `ring()` is `[c, d, a]`; `listener.orcaFront([H(2)])`
    → `[c, d]`. (Today: `[a, c, d]` and `[]`.)
  - `'a terminal two placed agents share names neither by its tab, renamed or not; one placed alone takes its tab\'s name'`:
    tab H(2) `{ title: 'Tmux', renamed: true }` → c and d are `'api'`; with `d` gone, c is `'Tmux'`.
  - `'a Codex under that client in that folder is placed there too, whatever engine Orca names'` (d's engine `codex`).
  - `'an agent of that client in another folder is not placed'` (d's `cwd: '/work/web'`: after the ranked, out of H(2)'s scope).
  - `'candidates on two clients place neither'` (`second`).
  - Review Focus 2: `'a Claude Code with no pane and no client in that folder blocks it: nobody is placed'` (one the
    attach scan found, as the ring describe's `scanned`).
  - `'a client two free terminals would take places nobody'` (d in `/work/web`, terminals `claudeIn(2)` and
    `claudeIn(4, '/work/web')` both free).
  - `'two free terminals of that folder and engine place nobody'` (O26's case: `claudeIn(2)` and `claudeIn(4)`).
  - `'a tab whose selected pane runs a shell is listed with no engine: its client is placed nowhere until a read names one'`
    (terminals without H(2), then a read with it).
  - Review Focus 5: `'a client that lands after the order read asks one more read, which places by it'` (the lookup's
    `list-clients -t` held until the first read landed: c and d unplaced, then `fake.orders` has one more, and its
    landing places both).
  - Review Focus 4: `'a tap on d switches Orca to that terminal before tmux shows its pane, and its words are typed into
    no Orca terminal and no tmux'` (`terminal switch --terminal H(2)` before the select; no `terminal send`, no tmux
    `send-keys`, `set-buffer`, `load-buffer` or `paste-buffer` after words to d).
  - `'its lines hold no tty, handle or agent'`.
- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts -t 'tmux inside an Orca tab'`. Expected: FAIL on the
  placement cases (nobody placed by a client). Commit red: `Dial: agents under one tmux client are placed at their Orca
  terminal (red)`.
- [ ] **Step 3: Implement** the rules above. The section's comment says what changed and why (the spec's §1, decision
  2), and `orcaMembers`' why (a lookup that lands after the read).
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts`. Expected: PASS, the ring describe's placement cases
  among them unchanged (`'two agents with no pane in one folder place neither'`, `'Diego\'s layout: …'`, …).
- [ ] **Step 5: Run** `npm run typecheck` and `npm run test:core`. Expected: PASS, `SV/devices.ts` at 100%.
- [ ] **Step 6: The Orca check in tier A** (above). Expected: no line of O1-O23 (O11's c, one candidate with its client,
  is placed as before), then `gaps 0 wrong 0`; O24-O26's keys only if Task 3 landed (new, any score).
- [ ] **Step 7: Commit green** `Dial: agents under one tmux client are placed at their Orca terminal`.

### Task 2: Tier A: one Orca terminal and tmux session per worktree and tab

**Depends on:** none. **Effort:** high. **Test that must fail first:** the shared-tab cases below.

**Files:**
- Modify: `EV/tierA/steps/tmux.ts` (the session's name, a new export), `EV/tierA/steps/sessions.ts` (`orcaPane`,
  `orcaHandleOf`, `hintsOf`, the processes' end), `EV/tierA/steps/orca.ts` (`terminal list`, `terminalsOf`),
  `EV/orcaListing.ts` (`orcaLayout`), `EV/types.ts` (the doc comments of `SessionDef.tmux`, `tab` and `split` only)
- Test: `EV/tierA/steps/tmux.spec.ts`, `EV/tierA/steps/sessions.spec.ts`, `EV/tierA/steps/orca.spec.ts`, `EV/orcaListing.spec.ts`

**Interfaces:**
- Produces:
  - tmux's session of an Orca session is `eval-orca-<worktree>-<tab>` (iTerm2's stay `eval-<window>-<tab>`): its panes in
    split order, the first started selected, one client under that tab's Orca shell.
  - `export function tmuxShown(world: TierAWorld, key: SessionKey): SessionKey | undefined` (`tmux.ts`): the session at
    the selected pane of the tmux session [key]'s pane is in.
  - An Orca session under tmux runs in its group's Orca shell and tty (the group above: one worktree and tab), made at the
    group's first start and ended with its last session; `orcaHandleOf` and its hooks' `ORCA_TERMINAL_HANDLE` give the
    lead's handle. Every other session is as before.
  - `orcaLayout(scenario, layout, open, folder?, identity?: (key: SessionKey) => Engine)`: a handle two open sessions
    share is one pane, the first of them by split, its `identity` the callback's for that session (default `engineOf`,
    so tier B's `e2e/harness/appEvalOrca.ts` is unchanged). Tier A's `orca.ts` passes
    `(key) => engineOf(world.session(tmuxShown(world, key) ?? key))`, as Orca names the engine tmux shows in a tab
    (stablyai/orca `server-tmux-status.ts`).

- [ ] **Step 1: Write the failing tests**, on an Orca scenario of `a` (tab 0), `c` and `d` under tmux in tab 1 (splits
  0 and 1, d a Codex) and `e` under tmux in tab 2, all in w1:
  - `tmux.spec.ts`: `'Orca sessions under tmux in one worktree and tab are panes of one tmux session eval-orca-<worktree>-<tab>, in split order, the first started selected, with one client under that tab\'s Orca shell; another tab\'s is a session of its own'`
    (`list-panes -a -F '#{pane_id}|#{session_name}|#{pane_active}'` after starting d then c; two clients; `tmuxShown(world, 'd')`
    is `'d'`, its pane first started, then `'c'` after `tmux.selectPane` c).
  - `sessions.spec.ts`: `'two Orca sessions under tmux in one tab share its Orca shell, tty and handle, which ends with the last of them'`
    (one Orca shell above both clients' chain; both hooks' `ORCA_TERMINAL_HANDLE` is the lead's; `orcaHandleOf` of either
    is it; `orca.close` of the lead leaves the shell and the handle; of the other ends them).
  - `orca.spec.ts`: `'terminal list lays out a tab two tmux sessions share as one terminal, with the engine of the pane tmux shows there; orca.focus of either tells that handle, and the front lists it once'`
    (`agentIdentity` `claude`, then `codex` after `tmux.selectPane` d).
  - `orcaListing.spec.ts`: `'a handle two open sessions share is one terminal, at the first of them by split, with the identity given; with none given each session keeps its own engine'`.
- [ ] **Step 2: Run** `npx vitest run src/testing/dialAppEval/tierA/steps/tmux.spec.ts src/testing/dialAppEval/tierA/steps/sessions.spec.ts src/testing/dialAppEval/tierA/steps/orca.spec.ts src/testing/dialAppEval/orcaListing.spec.ts`.
  Expected: FAIL on the four new cases. Commit red: `Dial eval: Orca's tmux sessions share their tab's terminal (red)`.
- [ ] **Step 3: Implement.** Comments say why: one tmux client runs in one Orca terminal, and Orca names the engine of
  the pane tmux shows there (the spec's "Tier A's model change").
- [ ] **Step 4: Run** the four specs and `npm run typecheck`. Expected: PASS, the existing O11 and tmux cases among them
  (`'under tmux its hook adds TMUX_PANE, and its agent runs under a tmux server'`, `'keyOfOrcaHandle …'`).
- [ ] **Step 5: The Orca check in tier A.** Expected: no line of O1-O23, then `gaps 0 wrong 0`.
- [ ] **Step 6: Commit green** `Dial eval: Orca's tmux sessions share their tab's terminal`.

### Task 3: O24, O25, O26

**Depends on:** 2 (their runs need the shared tab). **Effort:** high. **Test that must fail first:**
`orcaScenarios.spec.ts` and `catalog.spec.ts`, the cases below.

**Files:**
- Modify: `EV/orcaScenarios.ts` (three scenarios after O23, and the file's doc comment)
- Test: `EV/orcaScenarios.spec.ts`, `EV/catalog.spec.ts`

**Interfaces:**
- Produces (Task 4 runs them by id), each `platforms: ['darwin', 'linux']`, `tiers: ['a']`, with a comment naming the
  spec and why not Windows nor tier B (as O11's):

```ts
scenario({
  id: 'O24', app: 'orca', title: "Focusing the Orca tab where Claude Code runs under tmux turns the dial to it, again within one read of another tab",
  dims: ['D2'], platforms: ['darwin', 'linux'], tiers: ['a'],
  sessions: [pane('a', 'w1', 0), pane('c', 'w1', 1, 0, { tmux: true }), orcaGhost],
  steps: [
    ...orcaOpening(['w1']), ...orcaStarted(['c', 'a']), ...listed('orca', ['a', 'c']),
    { kind: 'orca.focus', session: 'a' },
    { kind: 'wait', ms: 2 * S },
    { label: 'focus', kind: 'orca.focus', session: 'c' },
    { kind: 'wait', ms: 2 * S },
    { label: 'away', kind: 'orca.focus', session: 'a' },
    // Within one poll read (FOCUS_POLL_MS): the poll's last answer may still be c's pane.
    { kind: 'wait', ms: 200 },
    { label: 'again', kind: 'orca.focus', session: 'c' },
  ],
  checks: [
    { id: 'focus', kind: 'focus', dim: 'D2', session: 'c', after: 'focus', at: 'away' },
    { id: 'again', kind: 'focus', dim: 'D2', session: 'c', after: 'again' },
  ],
  probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'focus' }],
}),
scenario({
  id: 'O25', app: 'orca', title: 'Two Claude Codes under one tmux in one Orca tab are listed by their names, and a tmux pane switch there turns the dial',
  dims: ['D1', 'D2'], platforms: ['darwin', 'linux'], tiers: ['a'],
  // c starts first, so its pane is the one tmux selects.
  sessions: [pane('a', 'w1', 0), pane('c', 'w1', 1, 0, { tmux: true }), pane('d', 'w1', 1, 1, { tmux: true }), orcaGhost],
  steps: [
    ...orcaOpening(['w1']), ...orcaStarted(['c', 'd', 'a']), ...listed('orca', ['a', 'c', 'd']),
    { label: 'tab', kind: 'orca.focus', session: 'c' },
    { kind: 'wait', ms: 2 * S },
    { label: 'pane', kind: 'tmux.selectPane', session: 'd' },
  ],
  checks: [ring(['a', 'c', 'd'], { apart: [] }), { id: 'focus', kind: 'focus', dim: 'D2', session: 'd', after: 'pane' }],
  probes: [ring(['a', 'c', 'd', 'z']), { id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'pane' }],
}),
scenario({
  id: 'O26', app: 'orca', title: 'Two Orca tabs each with Claude Code under its own tmux in one worktree: focusing one moves nothing, as the dial cannot tell them apart',
  dims: ['D2'], platforms: ['darwin', 'linux'], tiers: ['a'],
  sessions: [pane('a', 'w1', 0), pane('c', 'w1', 1, 0, { tmux: true }), pane('d', 'w1', 2, 0, { tmux: true }), orcaGhost],
  steps: [
    ...orcaOpening(['w1']), ...orcaStarted(['c', 'd', 'a']), ...listed('orca', ['a', 'c', 'd']),
    { kind: 'orca.focus', session: 'a' },
    { kind: 'wait', ms: 2 * S },
    { label: 'other', kind: 'orca.focus', session: 'd' },
    { kind: 'wait', ms: 3 * S },
  ],
  checks: [{ id: 'still', kind: 'still', dim: 'D2', ms: 3 * S, after: 'other' }],
  probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'other' }],
}),
```

- [ ] **Step 1: Write the failing tests.**
  - `orcaScenarios.spec.ts`: the ids case becomes O1-O26, 26; the platforms and tiers case gives O11, O24, O25 and O26
    `['darwin', 'linux']` and `['a']` (its title says so); the dims table gains `O24: ['D2'], O25: ['D1', 'D2'],
    O26: ['D2']`; new cases `'O24: c alone under tmux in tab 1, focused, then a, then c again within one read'`,
    `'O25: c and d under one tmux in tab 1, c first: the ring [a, c, d] on tmux\'s page too, then a pane switch to d'`
    and `'O26: c and d each under its own tmux in tabs 1 and 2, one engine and folder: a focus on d\'s tab is graded still'`,
    each asserting its sessions' `tmux`, `tab` and `split` and its checks as above.
  - `catalog.spec.ts`: the main ids `range('O', 26)`; the held-out case's totals 126 and Orca `[4, 30]` (its title says
    so); the tier A only list and title gain O24-O26; the own waits gain `'O24 2000', 'O24 2000', 'O24 200', 'O25 2000',
    'O26 2000', 'O26 3000'` after O20's, and the comment says them; the `quick` set gains O24 (its 200 ms within one poll
    read is its point), with the comment.
- [ ] **Step 2: Run** `npx vitest run src/testing/dialAppEval/orcaScenarios.spec.ts src/testing/dialAppEval/catalog.spec.ts`.
  Expected: FAIL on those cases. Commit red: `Dial eval: O24, O25 and O26, tmux inside an Orca tab (red)`.
- [ ] **Step 3: Implement** the three scenarios.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: The Orca check in tier A.** Expected: no line of O1-O23; O24-O26's keys as new on darwin and linux,
  none on win32: O26's `still.still` and every `wait.*` 1; O24's `focus.*` and `again.*` and O25's `focus.*` 0 (Task 4
  turns them 1); O25's `ring.*` 1 once Task 1 landed (before it, any); then `gaps 0 wrong 0`. A run error, a gap, a
  wrong send, an uncaught probe or a `wait.*` below 1: stop and tell the main session with the line.
- [ ] **Step 6: Commit green** `Dial eval: O24, O25 and O26, tmux inside an Orca tab`.

### Task 4: Orca's told client and the poll

**Depends on:** 1 (`orcaTmux`), 3 (O24-O26 for the red). **Effort:** xhigh. **Test that must fail first:**
`devices.spec.ts`, the Task 1 describe's new sub-describe `'following'`; `dialAppEval.spec.ts`, the O24, O25 and cost
cases below.

**Files:**
- Modify: `SV/devices.ts` (`toldClients`, `onTabInFront`, a new `orcaClient`, `focusLine`, `orcaSettled`, `dropFocus`,
  the watch's end, `readOrcaOrder`, `tmuxPanes` and the section's comments)
- Modify: `EV/dialAppEval.spec.ts` (four inline cases)
- Test: `SV/devices.spec.ts`, `EV/dialAppEval.spec.ts`

**Interfaces:**
- Consumes: `orcaTmux` (Task 1); `focusWatch`, `paneFocus`, `tmuxFocused`, `paneAnswered`, `paneTaps`, `dialMoves`.
- Produces:
  ```ts
  /** The tmux client in the Orca terminal Orca's watch told last, when one is placed there (orcaTmux.clients); none before
   *  a line, for any other terminal, and once the watch ends or the dial goes (the spec's §2). */
  let orcaClient: string | undefined
  ```
  - `toldClients('orca', ttys)`: the ttys equal to `orcaClient`; none when none is told.
  - `onTabInFront('orca', agentId)`: `orcaClient` is defined, `source.tabTty(agentId) === orcaClient`, and
    `orcaTmux.agents.get(agentId) === focusWatch?.pane`.
  - `tmuxPanes` takes an agent with `app === 'orca'` only when `orcaTmux.agents` has it.
  - `focusLine`: sets `orcaClient` from the line; for a terminal with a placed client, while Orca's poll runs, drops
    tmux's place from `paneFocus.last`, and for the watch's first line sets `paneFocus.first` (Open question 4); then as
    today.

- [ ] **Step 1: Write the failing tests.**
  - `devices.spec.ts`, sub-describe `'following'`, on Task 1's scene with Orca settled, the watch running
    (`fakeOrcaReads({ watches: true })`, its line through `fake.watches[0].line`) and `READ`, `reads()`, `next()`,
    `asked()` as the tmux describe's:
    - O24: `'Orca\'s watch on the tmux tab: one read, and the dial turns to the agent at the pane tmux shows there'`
      (`asked()` ends with `[c, 'pane']`).
    - `it.each` `'no tmux read with %s'`: no focus line yet; the watch on a's own terminal; on a terminal with no placed
      client; Orca not settled; no dial. (`tmuxReads()` is `[]`.)
    - `'a\'s tab, then the tmux tab again before the next read: the dial turns to that agent again'` (the dropped answer).
    - O25: `'a tmux pane switch in that tab turns the dial to that pane\'s agent'` (`tmuxSays.clients` `…|%4`, then `[d, 'pane']`).
    - Review Focus 1: `it.each` `'the client shows another pane: %s'`: d's (placed there) turns the dial to d; one whose
      agent is in another folder, so not placed, moves nothing; one with no agent moves nothing.
    - `'a listing that names the pane on another tty moves nothing'`.
    - `'the dial\'s own tap and rest on a placed agent: the read that sees its pane is their echo within TAB_ECHO_MS, and the person moving there later turns the dial'`.
    - `'a hand turn while a read runs leaves the dial where it was turned'`.
    - Review Focus 3: `it.each` `'%s on the tmux tab: the dial turned within ATTACH_ECHO_MS stays; past it, the dial turns'`:
      Orca settling back from another app with the watch on it; the watch's first line after a dial attached.
    - `'a placement landing after the focus line tells its client then: the next read turns the dial'`.
    - `'the watch ending, the dial going and another app settling each stop the reads'`.
    - `'its lines name no tty, pane, handle or agent'`.
  - `dialAppEval.spec.ts`, in its `tier A` describe:
    - `it.for(['darwin', 'linux'] as const)("O24 on %s: Orca's focus on c's tab turns the dial to c within a second, and again from a's tab within one read", …)`:
      `run.error` undefined, `wrongSends` `[]`, and the scores of `focus.lands`, `focus.latency`, `again.lands` and
      `again.latency` are each 1.
    - `it.for(['darwin', 'linux'] as const)("O25 on %s: the tmux pane switch to d in c's tab turns the dial to d, the ring [a, c, d] by their names", …)`:
      `focus.lands`, `focus.latency` and every `ring.*` 1.
    - `it("O26: a focus on one of two tmux tabs that cannot be told apart moves nothing, and tmux's clients are never listed", …)`:
      `still.still` 1, no command `[tmux, 'list-clients', '-F', '#{client_tty}|#{pane_id}']`. A guard: it passes before
      the change too.
    - `it("the poll's cost, in virtual time: a minute with Orca settled on c's tab lists tmux's clients at most once a FOCUS_POLL_MS, and a minute on a's tab or behind another app not at all", …)`:
      an inline `S6` on darwin of O24's sessions, steps `orca.focus` c (`tmux`), a minute, `orca.focus` a (`plain`), a
      minute, `{ kind: 'front', app: 'other' }` (`behind`), a minute; the poll's reads from `tmux` to `plain` number at
      least 100 and at most `60_000 / FOCUS_POLL_MS + 1`; from `plain` + 1 s to the end, none. It prints the counts for the PR.
- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts -t 'tmux inside an Orca tab'` and
  `DIAL_EVAL_SKIP_RATCHET=1 TMPDIR=/tmp npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts -t "O24 on|O25 on|O26:|poll's cost"`.
  Expected: FAIL on the following cases, O24's, O25's and the cost case (nothing follows, no read); O26's passes.
  Commit red: `Dial: focusing an Orca tab with tmux, or a tmux pane in it, turns the dial (red)`.
- [ ] **Step 3: Implement** the Interfaces above. The tmux section's comment block replaces "one in tmux inside Orca is
  left to Orca's own focus" with what Orca's told client does and why (the spec's §2 and §3). The existing case
  `'nothing runs with an agent in tmux inside an Orca terminal with Orca settled'` stays: no read places its agents.
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts`, then the Step 2 `dialAppEval.spec.ts` command.
  Expected: PASS.
- [ ] **Step 5: Run** `npm run typecheck` and `npm run test:core`. Expected: PASS, `SV/devices.ts` at 100%.
- [ ] **Step 6: The Orca check in tier A.** Expected: every O24-O26 key 1 on darwin and linux (new), no line of
  O1-O23 (O11's tap now also starts the poll; its echo is `paneTaps`'), then `gaps 0 wrong 0`.
- [ ] **Step 7: Commit green** `Dial: focusing an Orca tab with tmux, or a tmux pane in it, turns the dial`.

### Task 5: The docs

**Depends on:** 1, 3, 4 (they say what landed). **Effort:** medium. **Test that must fail first:** none (docs: one commit).

**Files:**
- Modify: `cli/AGENTS.md` (the devices row only)
- Modify: `docs/plans/2026-11-22-dial-eval-orca-design.md` (Ring, Follow, Main set, Tier A), if Open question 3 says yes

- [ ] **Step 1: `cli/AGENTS.md`'s devices row:** the tmux pane follow's "of a live agent in tmux outside Orca" and its
  client rule gain Orca: the client placed at the Orca terminal Orca's watch told last; Orca's ring sentence gains the
  placement of a tmux client at its Orca terminal and of every agent of that client in that folder, none of two.
- [ ] **Step 2: The eval's design doc:** Ring's "tmux inside Orca" bullet, the placement by the client; Follow, a focus
  on a tmux tab and a tmux pane switch in it followed by the poll; Main set, O24, O25 and O26 as the spec words them
  (macOS and Linux, tier A alone, and why); Tier A, one Orca terminal and tmux session per worktree and tab.
- [ ] **Step 3: Commit** `Dial: docs for following tmux inside an Orca tab`.

---

## Verification

Every check runs on the final head, after the final review's fixes. Isolation is the repo's own (cli/AGENTS.md rules 5
and 6): tier A runs in process with every reader of the machine mocked (`EV/dialAppEval.spec.ts`), a throwaway home and
temp folders, no process start, the network guard on; each e2e case's `IsolatedDaemon` has a throwaway home, data folder
and port, the daemon's private tmux server (`d.tmux`), the fake `orca`, the harness's fake apps and `open`, a fake dial on
the desk, and `FakeBackend`'s made-up machine. No real account, backend, Orca or tmux of the person's. No repo workflow
runs the eval by hand: `ci.yml`'s `workflow_dispatch` (scope `linux-e2e`, `e2e_files`) runs only tier B's e2e files on
Ubuntu, and `cli-e2e.yml`'s only the agent browser and the dial hosts; so the eval, the baseline and the macOS e2e run
locally. No workflow is added.

1. **Unit and coverage, this Mac (the main session's go).** `npm run typecheck`; `npx vitest run
   src/services/devices.spec.ts src/testing/dialAppEval/tierA src/testing/dialAppEval/orcaListing.spec.ts
   src/testing/dialAppEval/orcaScenarios.spec.ts src/testing/dialAppEval/catalog.spec.ts`; `npm run test:core`
   (required: `SV/devices.ts` at 100%; PR CI does not run it); then `python3 scripts/local-checks.py --run` from the repo
   root on a clean tree, its output in the PR body. Seen: all green.
2. **Tier A, all apps, this Mac (the main session's go).** `DIAL_EVAL_SKIP_RATCHET=1 TMPDIR=/tmp npx vitest run
   src/testing/dialAppEval/dialAppEval.spec.ts`. Seen: every scenario on darwin, linux and win32 passes, the inline
   O24, O25, O26 and cost cases among them.
3. **The eval and the baseline, the tester on this Mac, only on a turn the PM grants (one eval at a time):**
   `cd cli && OUT=$(mktemp -d) && DIAL_EVAL_OUT="$OUT" TMPDIR=/tmp caffeinate -i npm run eval:dial-apps -- --tier a --update-baseline`.
   Read `$OUT/report.md` and `report.json` (main tables, `delta.checks`, the held-out count only). The merge gate:
   - `Gate: passed`, 0 wrong-session sends (one: stop and ask the PM; no baseline is kept);
   - Orca's tier A score rises or holds with the new checks (`apps.a.orca` was 99.55); no other app's score drops;
   - `git diff cli/src/testing/dialAppEval/baseline.json` touches only `a/darwin/O24|O25|O26/*`,
     `a/linux/O24|O25|O26/*` (new, each 1) and `apps.a.orca`: tier A is deterministic, so any other key, a timed one
     too, is a finding (`git checkout -- cli/src/testing/dialAppEval/baseline.json`, tell the main session), never noise
     to commit;
   - then `npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts` (same turn): PASS, `matches the baseline` among them.
   The tester reports the score table, O24-O26's rows, the held-out count and that diff. An implementer commits the file
   as `Dial eval: tier A's baseline with tmux followed inside Orca`. If another hill-climb merged first: rebase onto
   `main`, review the combined change, and run this check again from the start.
4. **The poll's cost, the tester on this Mac, alone on an idle machine, on the PM's turn** (Open question 2):
   - Orca: the cost case of check 2 gives the poll's reads with Orca settled on a tmux tab (about one a
     `FOCUS_POLL_MS`) and none on a plain tab or behind; the PR quotes its counts.
   - CPU, before and after, with #4591's case (the same poll, the same one `list-clients` read):
     `TMUX_FOCUS_CPU=1 TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts -t CPU`,
     first in a throwaway worktree at `a9555a1219` (`git worktree add`, `npm ci`; removed after), then on the final
     head. Seen: PASS both; the head's `frontCpuPercent` within 1 point of the base's (more: a finding for the main
     session). The PR lists both JSON lines and says Orca's tab runs that same read, as the tier A counts show.
5. **macOS end to end, the tester on this Mac, on the PM's turn** (needs `tmux` and `cc`; a skipped file fails the
   check): `TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialOrcaFocus.e2e.ts
   e2e/dialTmuxTerminal.e2e.ts e2e/dialPaneFocusFollow.e2e.ts e2e/dialTerminalFollow.e2e.ts`. Seen: all pass, as on
   `main`: Orca's focus follow, the tmux poll in Terminal and iTerm2, and WezTerm's and kitty's poll, whose code this
   branch changed. PR CI runs none of them for these paths.
6. **PR CI, on its own, nothing started by hand:** `cli-typecheck`; `cli-tests` (tier A's spec on Linux against the
   macOS-written baseline: a difference is a determinism bug, not a baseline to refresh); `linux-e2e` (the dial app
   eval's tier B files, gate-only, as `SV/devices.ts` and `EV/` changed). Seen: each green.
7. **Needs Diego himself, after the release, not a merge gate (his own Orca and eye):** in his Orca, Claude Code under
   tmux in a tab beside a plain tab: focusing the tmux tab turns the dial to it; a tmux pane switch there turns it to
   that pane's agent; with two tmux tabs of one engine in one worktree, the dial stays. It also checks the spec's one
   unchecked assumption, that Orca's terminal list names the engine tmux shows in a tab. No agent runs Orca's CLI or
   reads his terminals for it.
8. **Production:** none.

## What the pull request says

- Platforms: macOS and Linux (tier A on both, macOS e2e); Windows not affected (tmux only inside WSL).
- The numbers of Verification 4, the eval's score table and `baseline.json`'s diff; `npm run test:core`'s receipt.
- Not in this branch: the Pro's Orca room (`host: 'orca'`), tier B with a real tmux client in the Orca stand-in (both
  backlog, PM), and two tmux tabs of one engine in one worktree (not followed by design).

## Proposals (not in this branch)

- A by-hand macOS job for the dial's macOS-only e2e files (as #4591 proposed: `dialTmuxTerminal`, `dialTerminalFollow`,
  `dialAppEvalIterm`), so later pull requests can run checks 4 and 5 on GitHub.
- Tier B's Orca stand-in with a real tmux client (decision 5's backlog item), which would also let an e2e measure the
  devices' CPU with Orca in front on a tmux tab.

## Open questions, answered (PM, 2026-11-27)

The PM answered each as recommended: 1 yes, 2 yes (with a Mac turn for the CPU case on base `a9555a1219` and the
final head), 3 yes, 4 yes (keep `ATTACH_ECHO_MS`, #4311).

1. **Does a nested agent's client tty join `orcaMembers`' key, so its landing asks one more order read?** Recommended:
   yes (Task 1 is written so). The spec reads placement "at each Orca order read, as now", and today a read is asked only
   when the ring's members or their Orca panes change. tmux's lookup can land after the read its agent's start asked
   for; without this, that agent is placed by its client only at the ring's next change, and the dial does not follow it
   meanwhile. Cost: one read more when a client lands or changes, only for agents under tmux.
2. **Is the cost measured as Verification 4 does?** Recommended: yes. The spec asks for the devices' CPU with Orca in
   front on a tmux tab, but no e2e can stand Orca in front of a real tmux client without decision 5's backlog item. In
   its place: tier A's count of the poll's reads with Orca on a tmux tab, a plain tab and behind (Task 4), and #4591's
   iTerm2 CPU case before and after, as the poll and its read are the same. The other way is to pull that backlog item in.
3. **Do the docs change in this branch?** Recommended: yes, Task 5: `cli/AGENTS.md`'s devices row says the tmux follow
   runs "outside Orca", which this branch makes false; the eval's design doc lists Orca's scenarios and its tier A model,
   as O11's branch updated it. No: Task 5 keeps `cli/AGENTS.md` alone.
4. **Is the poll's answer after the watch's first line on a tmux tab judged as Orca's settle?** Recommended: yes (Task 4
   is written so). The spec keeps "a first answer as Orca settles is skipped when the dial moved within ATTACH_ECHO_MS,
   as today", and the watch's first line is the focus as Orca settled. At Orca's first settle after a dial attaches the
   poll's own first answer comes before that line, with no client told; without this, a dial turned as Orca came
   forward is turned back by the read after the line (#4311's case).
