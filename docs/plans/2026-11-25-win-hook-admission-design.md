# A session's hooks are never lost while it is being admitted (2026-11-25)

A Windows user's agents went silent for hours. One agent showed "idle" in the Harness app while it worked, a Codex
agent finishing a turn gave no beep (while `harness device notify` beeps worked), and creating a new harness stuck
with its button working. A macOS user reports the same Codex symptom: three Codex sessions that never beep when done.
So the causes below are not Windows-only, and the fix and its tests cover every OS.

Goal: every hook an engine sends for its session reaches the core in order, and a session is bound to its agent as
soon as the engine's own verified process identifies it. No hook is refused because the session is still being
admitted.

## How it happens today

The evidence is the user's daemon log (2026-11-19 to 11-24, CLI 0.6.73 to 0.6.86), counted by its fixed log words
only, and scratch reproductions against the real registry and hook server (not committed).

### A. A resumed agent refuses every later conversation of its own process

1. A stopped agent resumed or restored through `registry.resumePendingAgent` (`lib/registry.ts:1982`) keeps its old
   `sessionId` with `resumeOnly: true`, `lastHookAt: 0` and `boundAt: null`. The resume is confirmed by its own engine
   process (`registry.confirmLaunch`, `lib/resumeAgentService.ts`, `lib/restoreAgents.ts`), which sets `launch: ready`
   and the process but neither `lastHookAt` nor `boundAt`.
2. `registry.register` keeps a guard armed while `resumeOnly && lastHookAt === 0` (`registry.ts:2337-2349`): a hook
   naming another conversation is taken for a resume that opened the wrong one, and the row is saved
   `active: false`, launch failed `RESUME_SESSION_MISMATCH`, and the hook gets nothing (`return null`).
3. The guard stays armed until a hook of the resumed conversation itself registers. Codex sends its SessionStart only
   at the first prompt, and Claude Code's can be dropped, so for such a row the next hook its verified process sends
   is often another conversation: a `/clear`, a `/new`, or Codex's first prompt naming a new thread. That hook fails
   the row; the pending admission then finds the row inactive and rejects as `stale_hook`
   (`core/engines/pendingAdmission.ts:132`, `hookServer.ts:740`). Discovery confirms the running engine again
   (`active`, `ready`) but `resumeOnly` and `lastHookAt: 0` stay, so every later UserPromptSubmit of that conversation
   goes the same way. The state is saved, so it survives daemon restarts.
4. In the log: Claude sessions 24874d20, 5b68ee9b, c4949148, 85ec8662, b04442ec of one agent (each `SessionStart held
   · DURABLE_ADMISSION_WAIT` then `SessionStart ignored · stale_hook` one second later, then `UserPromptSubmit
   ignored · stale_hook` for hours), and Codex sessions 01a203a8, 01a204c4. On Nov 23 the same `/clear` bound one
   second after its hold, because the resumed conversation's own SessionStart had registered first and disarmed the
   guard.

### B. A binding with no time makes every other conversation ambiguous

1. `createAdmissionOrder.observe` (`core/engines/admissionOrder.ts:19-30`) takes the agent's current binding as the
   order watermark: `firedAt: binding.at ?? undefined`. A resumed row's `boundAt` is `null` in memory (A.1; a reload
   turns it into `registeredAt`, `registry.ts:1518`), so the watermark has no time.
2. `status()` then compares the new conversation's timed hook by arrival only (`admissionOrder.ts:37`): `arrival > 0`,
   so `ambiguous`, on every retry. `pendingAdmission.ts:118` holds it `HOOK_ORDER_AMBIGUOUS`, retries every second,
   and logs once. Only `register` could put a time on the binding, and the hold never reaches it: held for good.
3. An accepted hook with no fired-at header (an older hook client) leaves the same untimed watermark through
   `accept()`, with the same result for any later timed hook of another conversation.
4. In the log: Codex sessions 01a209f4, 01a20af3, 01a20b4d, each held about a minute after `[resume] … confirmed ·
   engine=codex · hook=no · same conversation`, then 36, 7 and 46 unbound refusals at least.

### C. A session's other hooks are refused while its admission waits

1. SessionStart and UserPromptSubmit go through admission (`/api/hook/session-start`): resolved to the agent's
   process (up to 20 s while the process is not yet recorded), queued per agent, and held while their evidence is
   incomplete (Claude Code on Windows sends SessionStart before its transcript exists: `DURABLE_ADMISSION_WAIT ·
   IDENTITY_UNAVAILABLE`, `registry.ts:2321`).
2. The session's other hooks (`turn-stop`, `wait`, `subagent`, `tool-start`, `turn-start`, `session-end`) need the
   session already bound (`verifiedBoundMutation`, `hookServer.ts:313-336`). While it is not, each gets 403
   `UNBOUND_HOOK` (`refuseUnbound`, `hookServer.ts:964-970`), logged at most once a minute for all sessions together.
3. The hook client (`cli/hook/notify.mjs` `post`) sends a hook once; a 403 is never retried. So each of those hooks
   is lost: no turn end, no recap, no beep, no waiting state. With A or B the window is hours; on Windows a tester
   measured it at 2 to 3 s for every new Claude Code session (CLI 0.6.89, the terminal host on 0.6.22 and 0.6.87).
4. Why the symptoms: the prompt is credited only after a durable bind (`hookServer.ts:895-899`), so the app shows
   "idle"; the transcript watcher still tails the old conversation's file (9 times at the same offset in the log),
   so nothing ends the turn and no recap rings the dial. `harness device notify` goes straight to the devices, which
   is why its beeps worked.

### D. A settings file with a UTF-8 BOM holds every create

`inspectHookFile` (`engines/kit/nativeHookFiles.ts:141`) decodes with `ignoreBOM: true`, which keeps a leading BOM in
the text, so `JSON.parse` fails. PowerShell 5's `Set-Content -Encoding utf8` writes one. The tester saw `[hooks]
failed to write settings.json: SyntaxError` every 2 s, and a create held `NATIVE_LAUNCH_HELD` "Waiting to confirm the
engine's native hooks." for good. That is the one path in the code that holds a create.

The user's log has no create in it (no `create`, `[agent] create`, or native-hook-held line; it ends on 0.6.86 while
the user now runs 0.6.89), so their stuck create is not proven to be D. The pull request says so plainly.

## What changes

### 1. A verified process that reports another conversation attaches it (A)

`registry.register` drops the `RESUME_SESSION_MISMATCH` branch. A resumed row whose verified engine process reports
another conversation binds it as a rotation, the way a `/clear` does: `rebound` names the old conversation, which
stays on disk and joins `earlierSessionIds`; the row stays active and ready. The running engine is the truth; a failed
row over an engine the person is typing into was wrong. The rest of the resume rule stays: a never-hooked resumed row
still binds only a hook that carries a valid process identity.

Code that exists only because of the guard goes with it (for example the Hermes terminal pass's "confirm the resumed
session first" step, `core/agents/hermesTerminal.ts:141`, if that is all it is for). Clients keep their handling of
`RESUME_SESSION_MISMATCH`: older daemons still send it.

### 2. A watermark with no time orders nothing (B)

- A binding with no time (`boundAt: null`) sets no watermark: it is a reservation no hook has confirmed, and every
  hook of the agent's current process is newer than it (the process started after the resume made it).
- An accepted watermark with no time does not hold a timed hook that arrives after it in this core: that hook is
  `current`. Two timed hooks of different conversations with the same time stay `ambiguous`, and an untimed candidate
  stays `HOOK_ORDER_UNTIMED`, as today.

### 3. Hooks that arrive during a session's admission wait in order (C)

- The core keeps, per session (engine and session id), the admissions (SessionStart and UserPromptSubmit deliveries)
  it has received and not yet settled, in arrival order, from the moment the route has read the delivery (before
  its process is resolved, so the 20 s process-record wait counts). An admission is settled by the delivery's final
  outcome: accepted, rejected, or ignored for any reason (every `ignore`, and every 400, 409 or 429 that ends the
  route). An answer that does not end the work does not settle it: the `onWait` 202 `retry`, and the `200 pending` of
  a held or queued delivery. A delivery sent again (the same delivery id) is the same admission, whichever request of
  it ends the work.
- A `turn-stop`, `wait`, `subagent`, `tool-start`, `turn-start` or `session-end` hook of a session that is **not
  bound** (no row has that session id for that engine), while an admission of that session that arrived before it is
  unsettled, waits behind it. It is answered at once as kept (`200 {pending: true}`: the client treats a pending
  turn-stop as held and the others as delivered), with its fired-at time kept.
- Once every admission ahead of it has settled, it runs through the route's normal path, exactly as if it had just
  arrived (the same `verifiedBoundMutation` fence, the same handler, its original fired-at time), the waiting hooks of
  a session one after another in arrival order. Bound by then, it takes effect; still unbound, it is refused as today
  and logged.
- A bound session's hooks run at once, as today, even while one of its prompts is being re-admitted: that
  re-admission can be held for reasons that have nothing to do with binding (an unreadable source, a binding change),
  and today those hooks take effect at once.
- Admissions are not held back by waiting hooks. A later prompt's admission may commit before an earlier Stop that
  waited has run; the turn layer then orders them by fired-at time, as it orders any late hook today (a Stop older
  than the current prompt does not end it).
- Bounded: a few dozen waiting hooks per session and a few hundred across the core, each waiting at most a few
  minutes (the builder picks the numbers against the measured hold times; a normal wait is under 3 s). A hook over a
  bound or past its time runs at once through the normal path, as it would today, with a log line naming the route
  and the reason, never the body.
- The linked Stop of Cursor and Command Code, which their registration delivery carries, keeps its own path.

### 4. Engine settings files are read with or without a BOM (D)

Every reader of an engine's JSON settings file the hooks install into (Claude Code's `settings.json`, Codex's
`hooks.json` and the others `inspectHookFile` reads, and the review and folder-trust readers of the same files) takes
a leading UTF-8 BOM. A file the hooks rewrite is written without one; Claude Code and Codex read both.

## Approaches

For C, the main choice:

1. **Hold and replay in the hook server, per session (chosen).** The follow-up hook waits behind the session's
   earlier admissions and then runs the normal route path. One place, one fence, every engine and OS, and the order
   is the daemon's arrival order, which is the order the engine sent them in once admission has a turn.
2. **Have the hook client retry a refused hook.** The engine waits on its hook (500 ms budget), so a client cannot
   wait out a hold of seconds, let alone the minutes a person takes to type; and every engine's hook would need it.
3. **Bind the session before its evidence is complete** (accept a Claude Code transcript path that does not exist
   yet). Ends C's short window only, not A's or B's, and weakens the transcript proof the registry relies on.

For A: attach the new conversation (chosen, the orchestrator's decision) or keep failing only a SessionStart whose
source says `resume`; the narrower one keeps a failed row over a running engine in exactly the cases it fires.

For B: no watermark from an untimed binding (chosen), or give a resumed row a `boundAt` at its resume. `boundAt` means
when a hook bound the conversation, and handoffs, closes and purges read it that way, so moving it is the riskier
change.

## Design (docs/feature-design-rules.md)

Nothing new is stored, synced or exposed. The waiting hooks are in memory, bounded, and gone with the core; a core
restart loses them as it loses any hook in flight today. The rotation in 1 writes the same registry fields a `/clear`
writes (`sessionId`, `boundAt`, `transcriptPath`, `earlierSessionIds`).

Measures, with no content or identifiers beyond the short session id the hook lines already carry: a line when a hook
waits (once per session per admission), one when the waiting hooks run (with their count), and one per dropped hook
(route and reason).

## Constraints

- Core (`cli/src/core`, `hookServer.ts`, `lib/registry.ts`): 100% coverage per file (`npm run test:core`), and a new
  file the core loads gets its line in `architecture.coreFiles.txt` with why every session needs it.
- No fixed sleeps in tests; fake timers or events.
- Every OS: unit tests run everywhere; end to end on macOS/Linux (`npm run test:e2e`, the fake Claude Code and Codex
  engines) and Windows (`windows-e2e` by path in CI, and the Windows VM).
- Logs name no stored string, path or prompt (the guard of #4531).

## Tests

Each fails before its change:

- Registry: a resumed, never-hooked row whose verified process reports another conversation binds it as a rotation
  (rebound, the old id in `earlierSessionIds`, active, ready); the same across a reload. Replaces the two tests that
  expect `RESUME_SESSION_MISMATCH`.
- Admission order: a resumed row's untimed binding does not make a new conversation's timed hook ambiguous; an untimed
  accepted watermark does not hold a later timed hook; equal times and untimed candidates are held as today.
- Hook server: during a held SessionStart, and during its process-record wait, each of the six routes answers pending
  and then runs, in arrival order, with its original fired-at time, after the admission is accepted; after a
  rejection, it is refused and logged; over a bound or past its time it runs at once and is logged; a hook of a bound
  session, or of a session with no admission pending, runs at once.
- Hook files: a settings file with a BOM installs, and a create is not held for it.
- End to end, the real daemon and the fake engines: a Claude Code session whose SessionStart comes before its
  transcript, then a prompt and a Stop: the turn starts and ends, and a recap is made; a resumed Codex agent whose
  first prompt names a new conversation binds it and its turn ends; a Claude Code `/clear` on a resumed agent binds.
  Windows: the same through `windows-e2e`, and a Claude Code and Codex create and turn on the Windows VM.

## Left to the builder

- Where the per-session wait lives (in `hookServer.ts` or a small core module beside `pendingAdmission.ts`), and its
  bounds' numbers.
- How each route's handling is split so that the arrival and the replay run the same code.
- Which settings readers share the BOM rule, as one helper.
- Whether the Hermes terminal pass's step in 1 goes (only if it served the guard alone).

## Found, not fixed here

Listed in the pull request for a follow-up:

- `core/agents/bind.ts` process repair reads `Date.parse(startMarker)`, which is NaN for Windows `w:` markers, so it
  never runs on Windows.
- The voice router's warm Claude worker spawns `claude` without `lib/windows/program.ts` on Windows: `[router-pool]
  claude warm spawn failed … ENOENT`.
- Two held rows that the boot's restore skips have no retry timer (`[restore] held · every service · launched 0 of 2`
  at each start).
- The dial rings `question` every minute for a question of a stale binding.
