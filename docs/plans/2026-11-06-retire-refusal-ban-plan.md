# Retire the phase-4 refusal ban

> Execute task by task in this Engineer session, test first, with one independent PR review.

**Goal:** Let checkable rules use plain refusal codes without reviving the retired role registry.

**Architecture:** Narrow the existing source guard to obsolete role-registry codes, each with a reason. Exercise its matcher with allowed rule codes and prohibited registry codes; add no runtime refusal.

**Tech Stack:** TypeScript, Vitest, Markdown.

**Spec:** Task #3591; `2026-10-30-project-instructions-design.md`, superseded by Dee's 2026-11-06 decision that checkable rules belong in code.

## Global Constraints

- Own only `backend/src/superTabs/removedRefusals.test.ts` and `docs/plans/`.
- No runtime behavior, access changes, new refusals, dependencies or schema changes.
- Keep source-walk coverage and access-check positive controls.
- Follow project instructions: run affected tests locally; full backend unit and Super Tab suites run in PR CI.

## Review Focus

- Rule codes must be accepted in single, double and backtick quotes, without renaming.
- Registry codes must still be detected; every retained ban states why.
- Source scanning must still cover handlers and routes and exclude tests.
- Historical facts/access-only wording must be explicitly superseded, not presented as current policy.

## Task 1: Narrow the guard and document the policy change

**Files:** Modify `backend/src/superTabs/removedRefusals.test.ts`, `docs/plans/2026-10-30-project-instructions-design.md` and the phase-4 note in `docs/plans/2026-10-30-project-instructions-plan.md`.

**Interfaces:** Test-local `removedRefusals(text: string): string[]` is shared by fixtures and the source scan. No production interface changes.

- [ ] Extract the existing matcher without changing its ban. Add fixture cases permitting all non-registry codes and rejecting `ROLE_KIND`, `ROLE_UNAVAILABLE`, `ROLE_IN_USE`, `ROLE_GONE`, across the three quote styles. Commit the tests.
- [ ] Run `npm test -- src/superTabs/removedRefusals.test.ts`; observe rule-code cases fail against the old ban.
- [ ] Replace the blanket list with the four registry codes and individual reasons. Mark the design's enforcement section and phase-4 completion note superseded by Dee's decision.
- [ ] Rerun the focused test; require all cases pass. Commit, push and record red/green evidence in the PR.
- [ ] Mark ready and hand to the Integrator for one review; use PR CI for full unit/integration evidence.
