# The route picks by the Routing order — Plan (task #3576, part 1)

**Goal:** `harness super-tab route` returns a pick computed from its candidates by the project's Routing order (Order and
quota, steps 1–4), with one reason per step; a start or assignment without an override uses the pick, and choosing another
candidate needs an override reason.

**Architecture:** A pure function `pickByOrder` in `cli/src/superTabs/routePick.ts` ranks the shown candidates (the route's
own facts: model tier fit, grid, weekly quota left and reset, PM account, agents on the machine, price, the member's earlier
work on this task) and returns `{ id, reasons }`. `routeCommand.ts` records it (`via: 'order'`, `pick`, reasons in `why`) and
prints it first. The backend already stores a pick; `linkDecision` now asks for a reason when a start or assignment is not
the pick. No new stored data.

**Tech Stack:** TypeScript; CLI vitest specs (`cli/src/superTabs/*.spec.ts`), backend vitest.

**Spec:** the task brief (#3576), part 1. Part 2 (the four machine rules as rules-record kinds: hours a machine is off,
phone work on the phone Mac, no Codex on a named Mac, no reviewer on a local-model Codex) is a separate task. Until then the route
reads none of them (the server enforces no rule of the record): the route's `next` says the instructions' Machines rules still apply
and a pick that breaks one is overridden with that rule as the reason.

## Global Constraints
- Swarm code stays out of `cli/src/core`. Backend change is limited to `backend/src/superTabs/`.
- `decide()` and the unranked answer stay for a route with no pick (nothing eligible, plug-in findings only): no behavior
  change there.
- A backend from before accepts the record unchanged (pick + via `order` are already in its schema).

## Review Focus
- Each step of the order, in order, and that a later step never overrides an earlier one.
- The exceptions: same reviewer for its next round / follow-on work; PM account under 20%; 5% / 2% quota floors.
- Backend: a start or assignment that is not the pick is refused without a reason.

## Task 1: pickByOrder (`routePick.ts`)
**Files:** `cli/src/superTabs/routePick.ts`, `routePick.spec.ts`
- [ ] Failing specs, one per step: need (tier model, grid first for small work, never grid for reviews), quota (floors,
      soonest reset, then most left, PM account under 20%), idle only between equals plus the exceptions, fewer agents then price.
- [ ] Code.

## Task 2: Record and print the pick (`route.ts`, `routeCommand.ts`)
**Files:** `route.ts`, `routeCommand.ts`, `routeCommand.spec.ts`
- [ ] Failing specs: the answer has `pick` and `reasons` first, the record has `pick` and `via: 'order'`.
- [ ] Code.

## Task 3: Backend override reason (`commands.ts`)
**Files:** `backend/src/superTabs/commands.ts`, `commands.test.ts`
- [ ] Failing tests: following the pick needs no reason; another candidate without a reason is refused; with a reason it is
      recorded as an override.
- [ ] Code.

## Task 4: Lane dispatch skips a member too weak for the task (`dispatch.ts`, `model.ts`, `commands.ts`)
(Added at River's word, 11-06: dispatch gave a big, risky task to a Sonnet member.)
**Files:** `backend/src/superTabs/dispatch.ts`, `model.ts`, `commands.ts` (task contract), `dispatch.test.ts`
**Interfaces:** `WorkTask.strength?: 'standard' | 'strong'`, set by the PM with the brief (big, hard or risky work is `strong`);
a task asking for two reviews counts as `strong` too. `candidatesFor` leaves out a `strong` task for a member whose model is not
Opus or Astra (the Routing rule for big or risky work), so a weaker member keeps waiting for work it may take. A pinned task
(a member sent back for its own CI or conflict) is not skipped: it is that member's own work.
- [ ] Failing tests: a Sonnet member is not handed a `strong` task, an Opus member is; a `standard` task goes to either;
      a pin stays with its member.
- [ ] Code.
