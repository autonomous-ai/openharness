# Dial and voice-route logs hold no user content: design

Found by a reviewer of #4381 (pre-existing on `main`). Started as a small item; it grew past the small limits as the
same cause turned up in more places, and stepped up to a full item. This spec covers what landed before the step-up
and the one change the PM added with it (row 6: no `error.message`).

## Rule

The daemon's logs on the dial, devices and voice-route paths never hold:

- what the person said (the voice transcript, or any part of it);
- terminal screen text (a pane's footer);
- chat content or prompts, including a model's words about them (a router's reason);
- tab, session or agent titles;
- an engine's stderr or error result, which can echo the prompt.

Each line keeps its event shape: what happened, ids, counts and lengths, the outcome. Machine names and ids are kept.
`AGENTS.md` code standard 7 ("No secrets or personal content in logs") is the rule; this applies it.

## The seven places

All run outside the core (none is listed in `cli/src/architecture.coreFiles.txt`): `cable/` and `lib/voiceRouter.ts`
in the devices process, `services/router.ts` in its own process, `lib/openrouter.ts` and `lib/oneshot.ts` under the
voice router (`lib/oneshot.ts` is also used by `services/windowNames.ts`, which drops the error unlogged).

| # | Where | Logged before | Logged now |
|---|---|---|---|
| 1 | `cable/cableSession.ts`, terminal activity | the pane's footer text | `footer <n> chars` or `no live footer` |
| 2 | `cable/cableSession.ts`, `routed →` | the router's reason, which describes the sentence | `confidence <0.xx>` |
| 3 | `lib/voiceRouter.ts`, task line | 80 characters of the spoken task, each candidate's name | `task <n> chars`, candidate count, `<id8>/<engine>` each |
| 4 | `lib/voiceRouter.ts`, `logDecision` | the picked agent's name and the router's reason | id, confidence, via |
| 5 | `services/router.ts`, `[route]` line | Jev's trace, which names the sessions it weighed | `session <id8> p=<p> — <n> sessions`, `new (<why>)` or `nothing decided (<why>)`; `why` is fixed text. The id is the last line of the desktop's `<computer>\n<harness>` id, filtered to `[A-Za-z0-9_-]`, so it names the session, not the computer; `n` is how many Jev was shown. The trace still reaches the client for a session pick (`harness route`, ⌘B). |
| 6 | `lib/openrouter.ts`, HTTP error | up to 300 characters of the body; a moderation refusal's `metadata.flagged_input` is a piece of the prompt | the HTTP status, and OpenRouter's `error.code` and `error.type` when they are short tokens; never `error.message`, whose text is not proven never to quote the input |
| 7 | `lib/oneshot.ts` errors, read by `lib/voiceRouter.ts`'s `one-shot failed` line | up to 500 characters of the engine's stderr, Cursor's result text | engine, what failed (`exited <code>`, `timed out after <ms>`, `error result`, a spawn code) and `stderr=<n>B`, for all 8 engines |

Checked and left as they are: the voice turn line (`transcript=<length>`), `voice → error` (the dial's own fixed
copy), machine names, firmware `ESP_LOG` lines (no user text), the rest of `cable/**`, `cable/hosts/**`,
`services/devices*.ts`, `fleet*.ts`.

## How it is measured

Log-capture specs, each red before its fix: a distinctive sentinel is planted in the transcript, the footer, the
agent and session names, the router's reason, OpenRouter's error body, and the engine's stderr and result text. The
spec captures every line the path logs and fails if the sentinel is in any of them, and checks the line still carries
its event shape (lengths, ids, confidence, exit code, stderr size). Specs: `cableSession.spec.ts`,
`voiceRouter.spec.ts`, `router.spec.ts`, `routeDecide.spec.ts`, `openrouter.spec.ts`, `oneshot.spec.ts`.

## Follow-up

- The desktop app may log the router's RPC reply, which still carries the named trace for a session pick. Outside the
  CLI; the PM holds it in the backlog.

## Design (docs/feature-design-rules.md)

Nothing new is stored, synced or exposed: the change only removes content from log lines. Platforms: every platform
the daemon runs on, by the same code; `oneshot.spec.ts` drives fake engine programs and is skipped on Windows.
