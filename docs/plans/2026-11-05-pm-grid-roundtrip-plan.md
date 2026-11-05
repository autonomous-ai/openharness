# A PM back from a grid model or a move keeps Opus at xhigh — plan

> Way of working: the project's Engineer role (docs/plans plan, then test-first per task, one PR, one review).

**Goal:** A session that kept its launch model (#3219: `RegisteredSession.launchModel`) keeps it after a round trip
through a grid model. On the move home, and on every relaunch after it, a PM launched on Opus at xhigh comes back on
Opus at xhigh, and a person's later Harness pick still wins.

**Architecture:** Two gaps, both found in the #3219 reviews:
1. `lib/launchOverrides.ts` prefers the model remembered when the session left for a grid (`subscriptionModel`, a
   model only, kept after the move home) over the launch model. After one round trip every relaunch loses the effort,
   and a later pick (`setLaunchModel`) loses too. Fix: the launch model outranks the remembered one wherever the engine
   takes launch flags. A launch model with no model of its own still gets the remembered model, and an engine with no
   launch flags still uses the remembered model.
2. `core/agents/retarget.ts` builds the move home's launch source from the grid, the Codex home and the remembered
   model only, so the move home itself drops the launch model. Fix: carry `session.launchModel` on a move home.

Plus a Desktop test that pins the Personal-project PM's own-machine start flags (`personal_lead.dart` `_launch`: Claude
gets `opus`/`xhigh`, Codex none). That code already works, but nothing tested it.

**Tech Stack:** CLI TypeScript (vitest), Desktop Flutter (widget/unit test, memory store, fake sign-in).

**Spec:** task #3449 brief.

## Global Constraints

- Swarm code stays out of `cli/src/core`: `retarget.ts` only carries a generic launch fact.
- No `/model` is typed; flags only. A grid launch never gets launch-model flags.
- The `core/agents` 100% coverage gate (`npm run test:core`) holds.

## Review Focus

- No duplicate model flags (`ANTHROPIC_MODEL` env and `--model`) on one launch.
- An engine without launch flags (Codex) behaves exactly as before.

## Task 1: the launch model outranks the remembered model

**Files:** `cli/src/lib/launchOverrides.ts`, `cli/src/lib/launchOverrides.spec.ts`

- [ ] Failing test: Claude with `subscriptionModel: 'opus'` and `launchModel: opus/xhigh` relaunches with
      `--model opus --effort xhigh` and no `ANTHROPIC_MODEL`; with `launchModel: sonnet/high` (a later pick) it gets
      sonnet. With `launchModel: { model: null, effort: 'xhigh' }` it gets the remembered model and `--effort xhigh`.
      Codex with both keeps its remembered `-m`.
- [ ] Code.

## Task 2: the move home carries the launch model

**Files:** `cli/src/core/agents/retarget.ts`, `cli/src/core/agents/retarget.spec.ts`

- [ ] Failing test: moving a session with `launchModel` home from a grid asks `relaunchOverrides` with a source
      carrying that launch model. A move onto a grid does not.
- [ ] Code.

## Task 3: Desktop pins the Personal PM's launch flags

**Files:** `desktop/test/super_tab_personal_lead_test.dart`

- [ ] Test: a Personal project's first-message start of a Claude Lead asks the machine to create it with
      `model: opus`, `effort: xhigh`; a Codex Lead with neither. It guards existing behaviour, so it is checked
      against a deliberately broken `kLeadModel` to show it fails then.
