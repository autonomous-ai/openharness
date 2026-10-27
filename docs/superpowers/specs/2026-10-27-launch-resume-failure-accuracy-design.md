# Launch and resume failures: count them right, keep the reason

Status: spec · 2026-10-27 · from the Oct 26 usage report (items 2 and 3)

## Why

The Oct 26 usage report showed agent start failures at 8–16% a day since Oct 21 (3–5% before) and
17 of 38 resumes failing on Oct 26, 10 of them `resume_preparation_failed`. Reading the code:

- Some "failures" are correct refusals. `SESSION_IN_HARNESS` (opening an outside conversation that
  is already a harness here, `cli/src/core/agents/adopt.ts`) and `INVALID_REQUEST` (a cloud agent
  with no task or no GitHub repository, `cli/src/cloud/service.ts:248-253`) are both counted as
  `launch_failed` with failure `other` (`cli/src/lib/productUsageSignals.ts:96-99`).
- Desktop's first-arrival Retry sends the create again after the first one succeeded but its pane
  was not found yet (`desktop/lib/state/first_arrival.dart:226-288`). The second create resumes the
  same session and gets `SESSION_IN_HARNESS`.
- `harness new <cloud>` sends a cloud request without checking the task or repository first
  (`cli/src/lib/newCommand.ts`), so a typo becomes a counted failure.
- The launch counters do not say whether a person or an agent started the launch, so Swarm and
  agent-started launches (much more of them since Oct 21) move a rate people read as user pain.
- `RESUME_PREPARATION_FAILED` discards the error (`cli/src/lib/resumeAgentService.ts:276-278`). In
  practice it comes from Codex history repair (`cli/src/engines/kit/resumeRepair.ts`), and nobody can
  tell which check failed. One of them, invalid JSON, refuses a whole conversation because its last
  line is half written, which is what an interrupted Codex leaves behind.

Out of scope: sign-up (item 1, the sign-in service is outside this repo), rejected usage reports
(item 4, needs a database query, not code), `dsh_runtime_failed` (needs a Windows reproduction
first), the phone relay spike (back to normal).

## What changes

### 1. Resume preparation keeps its reason

- `repairHistory` throws a typed `ResumePreparationError` with `kind` ∈ `invalid_json`,
  `foreign_session` (first record missing or another session's), `not_owned_file` (outside the
  session folders, a symlink, not owned), `changed_during` (still being written), `other`. The
  message stays as today: file name and line number, never conversation text.
- `resumeAgentService` returns `RESUME_PREPARATION_FAILED` with that kind in the reply
  (`reason: <kind>`) and logs `resume preparation failed: <kind>: <message>` to the daemon log.
- New counters `request_<source>_resume_preparation_<kind>` (one per kind), counted once per
  resume reply, beside the existing `resume_reason_preparation_failed`.
- Desktop's text for the refusal names the cause for `changed_during` ("Codex is still writing this
  conversation. Try again once it stops.") and keeps today's text otherwise.

### 2. A half-written last line does not refuse the resume

In `historyRepair`, a final line with no trailing newline that is not valid JSON is passed through
unchanged (not repaired, not refused) and logged; no counter (a resume that succeeds has no failure to attach it to). Every other
check stays as strict as now: invalid JSON anywhere else, a foreign or missing first record, a file
outside the session folders, and a file that changes during preparation still refuse. Those are
integrity and safety checks, not damage.

### 3. Launch counters separate refusals and who started

- New `launch_refused` (with `launch_refused_code_<code>`): a create refused because the request was
  correctly turned down, not because Harness failed. The set is fixed: `SESSION_IN_HARNESS`,
  `SESSION_OPEN_ELSEWHERE`, `SESSION_OPEN_IN_TERMINAL`, `SESSION_BUSY_IN_TERMINAL`,
  `INVALID_REQUEST`. These stop counting as `launch_failed`.
- Every launch counter gets an agent-started twin: `launch_agent_started`, `launch_agent_created`,
  `launch_agent_failed`, `launch_agent_refused`, counted when the create request carries a
  `startedBy` (the field `core/agents/create.ts` already records for agent and Swarm starts). The
  measurement at `backendSocket.ts:939` reads it from the same payload. The existing totals keep counting everything, so
  history stays comparable; person-started = total − agent.

### 4. First-arrival Retry checks before it creates again

When the last attempt already has an `agentId` (the create succeeded and only the pane was missing),
Retry waits for that agent's pane again and does not send a new create. It creates again only when
the previous attempt failed or never got an id.

### 5. `harness new <cloud>` checks before sending

Before sending, `harness new` refuses locally, exit 2, with the same wording the cloud service uses:
no task; `--repo` not a GitHub repository; a coding cloud agent with no `--repo`.

## Rollout

- The counter names live in two mirrored files, `cli/src/lib/productUsageContract.ts` /
  `productHealthContract.ts` and `backend/src/types/`. The backend drops unknown names one by one
  (`withoutUnknownCounters`), so the backend ships first, then the CLI. A CLI that ships first only
  loses the new counters until the backend catches up.
- `docs/product-measurement.md` documents the new counters and the refusal set.
- Desktop changes (sections 1's copy and 4) ship in the next Desktop release; nothing depends on
  the order between Desktop and CLI.

## Testing

- `resumeRepair`: one test per kind; a half-written last line resumes and keeps its bytes; invalid
  JSON in the middle still refuses; a half-written line followed by a newline still refuses.
- `resumeAgentService`: the reply carries `reason`, and the log line has kind and message.
- `productUsageSignals`: each refusal code counts `launch_refused` and its code, not `launch_failed`;
  an agent-started create counts both the total and the `launch_agent_*` twin; a person-started one
  only the total.
- Contract parity test (CLI vs backend files) stays green.
- `newCommand`: the three local refusals, exit 2, and nothing sent.
- Desktop `first_arrival`: Retry after "has not opened yet" sends no second create and opens the
  pane when it appears; Retry after a failed create creates again. The New Harness coverage gate
  stays at 100%.

## Success

After a week on the new CLI: `launch_failed` (person-started) back near the pre-Oct-21 3–5% unless
real failures remain, and every `resume_preparation_failed` attributed to a kind.
