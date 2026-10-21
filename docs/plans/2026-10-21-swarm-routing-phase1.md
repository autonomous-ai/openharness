# Swarm routing phase 1: strong models for hard tasks, quota that fits the task

Owner-approved 2026-10-21. Short spec for the implementing agent. The longer reasoning is in
`docs/superpowers/specs/2026-10-21-swarm-quota-aware-routing-design.md`; where the two differ, this file wins.

## Why
A Lead routes each task with `harness super-tab route` (`cli/src/superTabs/routeCommand.ts`, `route.ts` `choose`).
Today it picks the **cheapest** candidate that meets the quality floor, and uses quota and reset time only to break
ties. So a hard task gets a weaker model, quota that resets unused is lost, a long task can start on a window that
runs out halfway, and tasks routed a minute apart pile onto one account.

## Scope
- **Claude and Codex only.** Other engines come later, one at a time (see "Later").
- In scope: the route's ordering, the Lead's assessment, the decision log, the Lead's prompt and HELP text, two small
  Desktop changes.
- Out of scope: learning spend from history, money caps, a dashboard, editing the size table in the policy UI.

## 1. The Lead adds `size`
`route GROUP JSON` takes `size`: `small` | `medium` | `large`. Missing means `medium` (older Leads keep working).
Update the HELP `route` line (`cli/src/superTabs/service.ts`) and the Lead prompts (`desktop/lib/super_tabs/launch.dart`,
`launch_prompt.dart`) to ask for it.

Defaults, as constants in `route.ts` (not in the policy yet):

| size | run time | 5-hour window spend | weekly spend |
|---|---|---|---|
| small | 20 min | 10% | 1% |
| medium | 60 min | 30% | 4% |
| large | 180 min | 50% | 8% |

These are for a policy row of cost 2. A row's spend = default × `cost / 2` (Opus high, cost 3, medium: 45% of 5-hour).

## 2. Quota belongs to an account, not a model
Opus and Haiku on one Claude account share its `5-hour` and `weekly` windows. Each candidate gets an **account
key**: the hashed key from the usage reading (`quotaOf(...).account`) when present, else `machineId:engine`
(contributed machines carry no key). Candidates with the same key share `left` and committed spend.

## 3. Ordering (replaces v1's cheapest-first)
Hard filters stay as today (offline, not listed, admission refused, exhausted window, …).

**Step 1: strength (a filter).** Keep candidates that meet the floor (as v1; if none meets it, keep all).
For `high` difficulty, keep only the highest `quality` among them. For `medium`/`low`, keep all that meet it.
Strength beats fit (owner decision): a hard task is never handed to a weaker model because the strong ones are
short of quota.

**Step 2: fit.** For each window W in {5-hour, weekly} the candidate's account reports:
- `usable = left − quotaReserve − committed(account, W)`
- `needed = spend(W)`, or `spend(W) × resetsIn / runTime` when `resetsIn < runTime` (the window refills mid-task)
- W fits when `usable ≥ needed`.

Status: `short` if any reported window does not fit; `fits` if both windows are reported and fit; else `unknown`.
Show Jev (and choose from) only the first non-empty group of **fits → unknown → short**. Candidates left out go to
`excluded` with a plain reason ("the 5-hour window is expected to run out about halfway; resets in 3h").
If only `short` is left, order it by **coverage** = min over reported windows of `usable / needed`, highest first,
and the route's answer tells the Lead: "No candidate is expected to cover this task; its 5-hour quota is expected to
run out partway and resets in 4h30." (Resuming after the reset stays manual in phase 1.)

**Step 3: effective cost**, then order within the group by: effective cost ascending → quality descending →
usable on the tightest window descending → idle member in the same repo before a new agent → title.
- Start from the row's `cost`.
- **Expiring quota is cheap:** if the 5-hour window resets within `runTime + 60 min`, its `usable` will be lost.
  `covered = min(1, usable5h / needed5h)`; `effective = cost × (1 − covered)`. Fully covered → 0, and between rows at
  0 the stronger wins (quality descending).
- **Weekly quota is dear for non-hard work:** `dayBudget = usableWeekly / max(1, daysToWeeklyReset)`. When
  difficulty is not `high` and `neededWeekly > dayBudget`, add `cost × neededWeekly / dayBudget`.

**Committed spend:** each recorded decision whose pick was started or assigned (`final` set) and whose `outcome` is
still open reserves, on its account, `spend(W) × max(0, 1 − elapsed / runTime)` (elapsed from `createdAt`). Per
Swarm only (the decision log is per Swarm). Read it from `routeHistory` (`service.ts`), which already returns the last
50 decisions; add the pick's account key, spend per window and size.

**Jev:** each candidate's label gains one sentence, e.g. "fits: needs about 30% of the 5-hour window (65% left,
resets in 50m, otherwise unused); weekly 4% of 61%". New instruction text: "The list is already ordered by strength
for the difficulty, fit and effective cost. Keep the first unless the task, its history or the policy notes give a
clear reason otherwise." Jev's 3-second limit and fallback stay.

## 4. Decision log
`backend/src/superTabs/routeRecord.ts` is strict, so extend it first and keep every new field optional:
`assessment.size`, and per candidate `fit: { status: 'fits'|'unknown'|'short', coverage: number|null,
effectiveCost: number, expiring: number, spend: { '5-hour'?: number, weekly?: number }, account?: string }`.
A record without them stays valid. The CLI must still record against an older backend: if `route.record` is refused
as invalid, retry once with the v1 shape.

## 5. Desktop
- **Machines panel:** show quota for Claude and Codex only. Today a contributed machine's row also draws "—" for
  every other engine it reports (`desktop/lib/super_tabs/machines.dart`, `_machine`, the `observation['quotas']` rows).
- **A new Lead (new Swarm or + Project) may only be Claude or Codex.** Add an allowed-engines list to
  `HarnessLaunchIntegration` (`desktop/lib/state/harness_launch_integration.dart`); `SuperTabLaunch.open`
  (`desktop/lib/super_tabs/launch.dart`) sets `['claude', 'codex']` when `lead` is true; the composer's
  `compatibleEngines` and engine choices (`desktop/lib/state/new_harness.dart`) honour it, as they already do for a
  guest (`asGuest`). The machine stays free to choose: it joins the Swarm's Machines list on its own because the Lead
  runs there (PR #1489's rule). Pin that with a backend test.
- The decision row already shows each candidate's label, so the new sentence appears without other changes.

## Acceptance examples (unit tests on `choose`; reserve 10%, default policy)
1. high, medium. Opus high 5-hour 70% left, resets 40m; Sonnet (other account) 90%. → Opus high.
2. high, large. Opus high 25% left, resets 4h; Codex default 85% left, resets 3h. → Codex.
3. low, small. Account A: 5-hour 80% (resets 4h), weekly 12% (resets 5 days). Account B: 5-hour 60%, weekly 70%. → Haiku on B.
4. low, small. Account A: 5-hour 60%, resets 20m; weekly 60%, resets 2 days. Account B: 5-hour 90%, resets 4h. → Opus high on A.
5. Two high, medium routes a minute apart; Opus accounts A 60%, B 58%, both reset in 3h. → first A, second B.
6. high, large. Opus high 40% left, resets 1h. → fits (needs 25% before the reset).
7. high, large. Opus high 30% (resets 4h); Codex 40% (resets 4h30); Sonnet elsewhere 95%. → Codex, never Sonnet;
   the answer says it is expected to run out.
8. No `size`. → treated as medium.

## Rules
- Branch from current `main`. No commit, push, PR or release until the owner asks.
- Tests never touch port 18473, `~/.harness`, `~/.claude`, `~/.codex` or the real tmux; never call the real Jev,
  OpenRouter or `gh`. CLI on Node 24; run `npm run test:super-tabs` (100% coverage gate) in cli and backend.
- Visible copy in English, plain words, per `docs/naming-system.md` (the product is **Swarm**, the role **Lead**).
- Comments say why. No dead code or debug output.

## Later (not this phase)
Other engines join routing one at a time when (1) they have a quota reader or are known to have no window,
(2) the policy rates their quality and cost, and (3) an end-to-end run shows the Lead can start, deliver to and observe
them. OpenCode first. Then: learn spend and run time from finished work.
