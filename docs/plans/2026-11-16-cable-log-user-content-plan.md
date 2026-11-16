# Dial and voice-route logs hold no user content: Implementation Plan

> Executed with **devcrew phase 3**. Every task is test-first: a red commit (the specs alone), then the code commit.
> Written after the step-up from a small item: it records the tasks as they landed.

**Goal:** the daemon's logs on the dial, devices and voice-route paths hold no user words, terminal text, prompts,
titles or engine stderr, while each line keeps its event shape.

**Spec:** [2026-11-16-cable-log-user-content-design.md](2026-11-16-cable-log-user-content-design.md). Branch
`fix/cable-log-user-content`, from `main` at `f824010a1f`.

## Tasks

### Task 1: the four dial and voice-route lines (done)

- Files: `cli/src/cable/cableSession.ts`, `cli/src/cable/cableSession.spec.ts`, `cli/src/lib/voiceRouter.ts`,
  `cli/src/lib/voiceRouter.spec.ts`.
- Red: a footer, a transcript and a route reason holding a sentinel; agent names that are sentinels. None may appear
  in a logged line; the lines carry `footer <n> chars`, `confidence`, `task <n> chars`, `<id8>/<engine>`, `id`/`via`.
- Depends on: none. Effort: high.
- Landed: red `aba64f42f8`, code `13a7609d49`.

### Task 2: the `[route]` line of the session router (done, from the final review)

- Files: `cli/src/services/router.ts`, `cli/src/services/router.spec.ts`, `cli/src/lib/routeDecide.ts`,
  `cli/src/lib/routeDecide.spec.ts`.
- Red: Jev's trace names sessions; the line must not. Then (fix review) desktop-shaped `<computer>\n<harness>` ids and
  45 sessions: the line names the harness id and counts the 40 Jev saw.
- Depends on: none. Effort: high.
- Landed: red `61b1cdf0e4`, code `c67f818034`; red `8c0ed8ffd6`, code `44e0e47706`.

### Task 3: OpenRouter's failure line (done, from the final review)

- Files: `cli/src/lib/openrouter.ts`, `cli/src/lib/openrouter.spec.ts`.
- Red: an error body whose `metadata.flagged_input` holds a sentinel must not be logged; the line keeps the status
  and OpenRouter's message.
- Depends on: none. Effort: high.
- Landed: red `3cfea53c03`, code `402bea2b14`; comment `b1e815840b`.

### Task 4: one-shot failures (done, approved by the PM)

- Files: `cli/src/lib/oneshot.ts`, `cli/src/lib/oneshot.spec.ts` (new), `cli/src/lib/voiceRouter.ts`,
  `cli/src/lib/voiceRouter.spec.ts`.
- Red: each engine's fake program exits 3 with sentinel stderr, Cursor returns an error result with sentinel text,
  Claude times out; neither the error message nor any log line holds the sentinel; the line names the engine, what
  failed and the stderr size.
- Depends on: Task 1 (same `voiceRouter.ts`). Effort: high.
- Landed: red `0d6d93e72d`, code `43967acfeb`. (`e52734331a` is an earlier attempt, undone by `44e0e47706`; the
  squash merge drops it.)

### Task 5: OpenRouter's failure line logs no `error.message` (PM, at the step-up)

- Files: `cli/src/lib/openrouter.ts`, `cli/src/lib/openrouter.spec.ts`.
- Red: an OpenRouter error whose `error.message` holds a sentinel must not be logged; the line carries the HTTP
  status, and `error.code` / `error.type` only when each is a short token (no free text).
- Depends on: Task 3. Effort: high.

## Verification

End-to-end: none. The change is log text only; the specs capture the lines themselves.

Required local gates (`AGENTS.md`, `cli/AGENTS.md` rule 4): `npm run test:core` (100% per file), since
`cli/src/services/router.ts` changed. CI runs the rest.
