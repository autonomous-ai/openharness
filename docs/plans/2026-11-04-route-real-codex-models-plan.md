# Route offers real Codex models Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** The route never offers Codex "default default". It offers the models the catalog rates (GPT-6.1 Sol at high,
GPT-6 Astra at xhigh), and a start that asks Codex for `default` runs the catalog's named default, Sol at high, not
whatever the account's CLI defaults to (task #2972, Ken, 2026-11-04).

**Architecture:** Measured in the 24 hours before #3010's release: 95% of Codex candidates were `codex default default`
and 67 of 71 Codex picks were that row, so a PM that started it as offered got a model nobody rated; the two Codex runs
were `gpt-6-luna`, the default of one Mac owner's account, which the catalog does not list.

- Backend `catalog.ts`: drop the `codex/default/default` row. Mark the Sol row `engineDefault`, the catalog's own word for
  "the model Codex runs when nobody names one", so the backend and the CLI read it from one place.
- Backend `commands.ts` `agent.start`: a Codex start with `model: 'default'` (not a grid model) is stored as the
  catalog's default model, and an effort of `default` or none as that row's effort. A named effort is kept. The route
  decision link still matches on what the caller sent, so a start of an old `default default` candidate stays linked.
- Backend `routingPolicy.ts`: an owner's saved policy gets the Sol and Astra rows when Codex is on; that was read off the
  `default` row, which no longer exists, so it reads any enabled Codex row.
- CLI `route.ts`: `catalogFrom` keeps `engineDefault`. A `codex` row at `default` model or effort read from an older
  backend is not offered. `catalogRow` takes the `engineDefault` row for a member launched on the engine's own model, so
  it keeps its Sol rating.
- A Codex start that names no model at all is left as it is: Desktop's import sends none to keep an existing session's model, and
  the route always names one. Only `model: 'default'` is resolved.
- `gpt-6-luna` is not rated: there is no benchmark for it, so it is never offered unless a person names it, when it is
  offered unrated as before.

**Tech Stack:** TypeScript; vitest in `backend/` and `cli/`.

**Spec:** task #2972's brief.

## Global Constraints

- Red first for each risk the task names; red/green evidence in a PR comment.
- Order stays the instructions' (#2901): nothing here ranks.
- Swarm code stays out of `cli/src/core`.
- No new setting; no migration: the catalog is served on read and old CLIs read the same rows as a policy.

## Design

- growth: N/A because the catalog is a fixed list of rows in code; one row fewer.
- concurrency: N/A because nothing is stored beyond the start's request, written under the existing command lock.
- read cost: N/A because the catalog read is unchanged in size (one row fewer).
- scale: N/A because nothing scales with the change.
- compatibility: an older CLI reading the catalog or the policy sees no `default` row, so it offers the named models;
  a newer CLI on an older backend does not offer a `default` row it still serves; a start that sends `default` from an
  older client is resolved by the backend.
- migration + rollback: none; reverting the commit restores the row, and a start made meanwhile keeps the explicit model
  it was stored with.
- audience: N/A because the catalog is public to members already.
- identity: N/A because no login is read or written.
- failure: a Team account whose owner's ChatGPT plan does not offer Sol is refused before launch with what it offers
  (the existing `codexModelNotOffered` check), instead of launching on whatever the CLI defaults to.
- platforms: all; no platform code.

## Review Focus

- A start with `model: 'default'` on Codex, with and without an effort, a named effort, a grid model, and Claude.
- Saved routing policies keep their Sol and Astra rows with the `default` row gone.
- Members launched on the engine's own model keep their rating.

## Tasks

### Task 1: The route offers only named Codex models

**Files:** `backend/src/superTabs/catalog.ts`, `backend/src/superTabs/catalog.test.ts`,
`backend/src/superTabs/routingPolicy.ts`, `cli/src/superTabs/route.ts`, `cli/src/superTabs/routeCommand.spec.ts`,
`cli/src/superTabs/__snapshots__/route.answers.json`

- [ ] Failing test: the catalog has no Codex `default` row, and Sol is its `engineDefault`.
- [ ] Failing test: a route over a catalog served with a `default` row (older backend) offers Sol high and Astra xhigh
      and never `default default`, on a Codex machine; `gpt-6-luna` is never offered, and is offered unrated when named.
- [ ] Failing test: a member launched on the engine's own model is rated as the catalog's `engineDefault`.
- [ ] Failing test: a saved policy still gains its Sol and Astra rows.
- [ ] Code for the above; update the route snapshot.

### Task 2: A Codex start for `default` runs the catalog's default

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/commands.test.ts`

- [ ] Failing test: `agent.start` Codex `default`/`default` is stored as Sol at high; `default` with a named effort
      keeps the effort; `default` with no effort gets high; a named model, a grid model and Claude are untouched.
- [ ] Failing test: starting a candidate by the route decision still links to it, for an old `default default` candidate
      and for Sol high.
- [ ] Code.
