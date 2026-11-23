# Dial usage counts

2026-11-23. Ken. For the device roadmap (Diego's `2026-11-13-device-integration-roadmap.md`, "Harness Device with the
other apps"): a person who does not use the Harness app plugs in a dial and drives their agents in Orca, herdr, Claude
Code, Codex and the rest, with the small Harness Device app.

## Intent

Answer, from real use and with counts only, the questions the roadmap decides on:

- Gate G1 (30–50 testers outside the app) and G2 (first sales): how many computers use a dial, and how many of them are
  outside the Harness app.
- Its stated measures: time from plugging in to the first agent on the dial (target under 3 minutes); agents the dial
  recognises out of those running, per host; voice reaching the right agent.
- "Telemetry per host": which host to build or fix next.
- Two open business questions: what voice costs per person (price it in the device or a subscription), and whether the
  dial shortens an agent's wait for its person (the product's core claim).

## Reality this design is built for

- **Small numbers.** At G1 the population is 30–50 computers, many of them the team's. A daily total of 30 is noisy and a
  rate over 30 computers swings. So every measure is a **computer count** (computers where X happened that day) first,
  with an event count only beside it, so one heavy user cannot make a trend; the review shows **7-day totals** next to
  the day and a **28-day** view for gate decisions.
- **Small numbers also identify.** With 30 testers, "the one Linux computer with Zellij on release 0.6.84" is a person.
  No cross products: engine, host and margin are separate one-way splits, never engine × host × release. The review
  shows any cell under 5 computers as "<5" (beyond the existing 20-observation rule for margins).
- **Signed-in only** (Ken). Voice needs a sign-in, so the counted population leans to voice users. The review says so on
  its first line; it is not "all dial users".
- **The team uses dials most.** `staff:` and `testing:` stay apart as today; the review reads outside-team totals first.

## Measures

Phase 1 is what the gates and the roadmap's own measures need; phase 2 is the behaviour signals. Both ship in ONE pull
request (Ken, 2026-11-23).

### Phase 1

| Question | Measure (per UTC day; computer counts unless said) | Where it is counted |
|---|---|---|
| Who uses a dial? | Computers with a dial connected; with a dial **used** (a turn, a press, a voice); computers using a dial for the first time | devices component |
| Who is outside the app? | The same, for computers where **the Harness Desktop app has not been opened in the last 28 days** (a local flag over the existing 35-day window), not "today": a Desktop user who skips the app one day is still an app user | gateway (it already sees Desktop opens) |
| Does a new dial work fast? | From the moment a dial is connected **and** an agent is running on the computer (whichever comes last) to the first agent on the dial: under 1 min, 1–3, 3–10, over 10, none within an hour. On the first connection ever and, apart, on each day's first connection | devices component |
| Which engines and hosts? | Computers whose dial showed an agent of each engine; of each host; distinct agents shown by engine and by host (capped per computer per day) | devices component |
| Does the dial find the agents? | Of the agents the daemon knows from their hooks (Claude Code, Codex and the other hooked engines): placed on a host's page, on "Other", held (voice not delivered by design), or not shown, by engine; agents on "Other" by the app holding them, from a fixed product list (Warp, Zed, Cursor, Windsurf, Alacritty, Terminal.app, …) plus `unlisted`. An agent with no hook is invisible to both sides: the review says recognition covers hooked engines only | devices component |
| Does voice reach the agent? | Voice sent: delivered (the agent's turn began within 10 s), failed by fixed code, held, cancelled; tap to open ok / failed by code; by host | devices component |
| What does voice cost? | Seconds of audio transcribed and transcription time: per-account-day buckets (under 1 min, 1–5, 5–20, over 20) and in total. Per account, not per computer: the route knows the account, not the computer, and the question is the price per person (harness-pm, 2026-11-23) | **backend, at the transcription route** (`backend/src/routes/voice.ts`): it already handles every second, signed in, and is exact |

### Phase 2

| Question | Measure | Where |
|---|---|---|
| Does the dial shorten an agent's wait for its person? | For a "Needs you" or a hooked agent waiting on the person (question, permission): time to the person's answer (under 30 s, 30 s–2 min, 2–10 min, over 10 min, none), whether the answer came from the dial or elsewhere, and the same wait on computers without a dial used that day, for comparison | devices component + gateway |
| Did voice go to the wrong agent? | Proxies, labelled as such: a voice followed within 30 s by a voice to another agent; a delivered voice whose turn the person interrupts within 10 s. By host | devices component |
| Do they come back? | Computers using a dial on day N and again on N+1 / N+7 / N+28; outside-app apart | gateway's existing cohort flags |

## Non-goals and anti-goals

- No dial serial or id, no account, machine name, window title, path, project, prompt, voice text or transcript, no
  host-specific identifier. Product names only from a fixed list.
- Not CLI-only computers without a dial; not individual dials (the unit is the computer); not signed-out computers.
- Not sales, pre-orders or returns: those come from the shop, not the daemon.
- Not firmware updates: they run in the Harness Device app, which sends nothing; a firmware count would need a second
  sender. Out of this spec.
- Failure if a count can identify a person, reveal what they work on, or make the daemon core grow a rule.

## Approaches

1. **The daemon's devices component observes; the gateway counts and sends** (chosen). The devices component
   (`cli/src/cable/`) already sees the plug, the agents it shows by host, every input and voice result. It writes its
   day's counts, fixed names and numbers only, to a state file of its own (`atomicWriteJson`, at most 35 days). The
   gateway reads that file at its existing report tick (`readState`, with a size cap), takes only names in the dial
   vocabulary and drops anything else without logging its content, remembers what it already reported (per day, with
   a revision) so a restart never counts twice, and adds the new part to its existing signed-in daily report, beside
   what it already knows (Desktop opens, phone requests, cohort flags). Voice seconds are counted where the
   transcription happens, in the backend. No new endpoint, no new sender, no core change.
   The dial's names live in a vocabulary file of their own (for example `cli/src/lib/dialUsageContract.ts`), used by the
   devices component, the gateway and the backend's copy, which the core's process does not import:
   `cli/src/architecture.coreFiles.txt` gains no line.
   (Changed from `product_observe` by harness-pm, 2026-11-23: that door takes only `hn`'s window
   (`localWsServer.ts`, `backendSocket.ts` `observeProduct`), and the devices' link to the core has no counter door, so
   either would have been a core change.)
2. The Harness Device app counts and sends: it does not know agents or hosts. Rejected.
3. Split between the app and the daemon: two vocabularies for one table. Rejected.

## Decided

- Signed-in computers only; the unit is the computer (Ken).
- Approach 1, through the devices' own state file read by the gateway (harness-pm, 2026-11-23); voice seconds at the
  backend, per account-day.
- Opt-out: the account's existing "Share product usage data", which already governs the signed-in report.
- Phases 1 and 2 in one pull request (Ken).
- Approved by Ken 2026-11-23.
- Daily review: a "Dial" section in `usage:daily` with day, 7-day and 28-day columns, outside-team first, "<5" for small
  cells, and the signed-in and hooked-engines-only limits on its first lines.
- Settled while planning (harness-pm, 2026-11-23):
  - The wait comparison is between days a dial was used and days it was connected but not used, labelled so in the
    review: a computer with no dial runs no devices component, so it cannot be measured without a core change.
  - The interrupt proxy counts hooked agents only, through their `turn-aborted` hook.
  - The main rows (dial used, outside the app, first use) also count distinct computers per period: first use in the
    UTC week starting Monday and in a fixed 28-day period, since gate G1 counts testers, not computer-days.
  - Dial voice is counted apart: the devices component's transcription request sends one fixed header (a surface value,
    `dial`), and the backend counts dial voice apart from the rest. No id in it.
  - Audio seconds are bucketed per account-day; transcription time is a total only.
  - "Needs you" waits are the `waiting` and `plain` notices, not `proceeding`.
  - The "See what's shared" screens on Desktop and phone: if they list specific categories that would now be
    incomplete, each gets one line, with its Flutter test, in this pull request; if they speak generically, they stay,
    and the pull request says so.
  - Backend rule 5: a growth estimate from the vocabulary in the pull request, no production reads.

## Design (docs/feature-design-rules.md)

1. Growth: daily totals in `product_usage_totals`, deleted by the existing TTL after 396 days; on the computer, queued
   counts and flags live 35 days; the devices' state file keeps at most 35 days of fixed counts, older days dropped at
   each write. Nothing new to delete on the backend.
2. Concurrency: the existing totals write path and its busy/retry handling.
3. Read cost: the review reads 28 days of totals at most, except the N+28 returns: 56 days for those 8 names only (the
   six return names and the two used-day names), on the existing (day, name) index (harness-pm, 2026-11-23). A 28-day
   read never holds a cohort old enough for its N+28 return to have happened.
4. Scale: counters join the one daily report per computer; the devices component batches its file writes (one write
   per few seconds at most, not one per turn of the dial), and the gateway reads the file once per report tick.
5. Compatibility: older CLIs send none; an older backend drops unknown names without refusing the report.
6. Migration/rollback: none; removing the names stops the counts.
7. Audience: written by clients, read by the team's review.
8. Identity: the existing report's account link only.
9. Failure: the gateway's existing retry/backoff; coverage via `health_cli_collector_days`.
10. Platforms: macOS, Windows, Linux, same names (on Windows the devices component runs inside the core, #4513: it adds
    no core rule, only its own state file).

## Left to the builder

Exact counter names in the vocabulary's style, the engine and host lists (from the device's own host ids) and the fixed
product list, bucket edges, batching, the review's layout, and tests at each layer (devices observations, gateway
counters, backend vocabulary and the voice route). If the existing typing forces the dial names into
`cli/src/lib/productUsageContract.ts` (which the core loads), stop and ask harness-pm.
