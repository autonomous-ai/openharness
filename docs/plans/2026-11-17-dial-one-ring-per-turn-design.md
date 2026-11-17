# Dial: one ring per turn, the agent's notice first

## Why

An agent that needs the person calls `harness device notify "<line>"` ([the notice](2026-11-16-dial-agent-notify-design.md)),
writes the same ask in its answer and ends its turn. Today the dial then rings twice, seconds apart, and the second
ring takes the notice's place:

```
09:07:40  [device] notify · claude · shown          ← ring 1: the notice, pinned
09:07:48  [cable] notify · alert · rule:turn        ← ring 2: the turn's end, 8 s later
```

(This computer's daemon log, 2026-11-17, one test notice from a Claude Code session in Orca, Notifications: All.)

The second ring is worse than noise: the dial keeps one drawer row per agent (firmware `notice_add` removes that
agent's rows, its question row too, before adding the new one), so the turn's recap replaces the notice's line. The
person hears two beeps and finds "Done: …" where "Connect the VPN so I can run the staging tests" was.

In Needs you the turn's end is already lowered to `list`, so it does not beep, but it still replaces the notice's row
the same way.

## What the person gets

One ring per turn. When the agent rang with its own line during the turn, that ring is the turn's ring, and its line
stays on the dial until the person acts.

## Goals, non-goals, anti-goals

- Goal: a turn that sent a notice ends with no beep, no wake and no new drawer row; the notice's card and row stay as
  they were.
- Goal: the same in All and Needs you.
- Non-goal: a question or a permission ask in the same turn. The notice already waits behind it (`notices.held`) and is
  asked when it closes; each is an ask the person must answer.
- Non-goal: a failed turn. It still rings and shows its error, as today (see Decided).
- Non-goal: any change to the menu-bar app, the firmware, the skill text or the core.
- Anti-goal: a notice line lost from the dial while its card is still pending.

## What rings, after this change

| In one turn | All | Needs you |
|---|---|---|
| The agent sent a notice, then the turn ends | notice rings; the end is silent | notice rings; the end is silent |
| No notice, the turn ends | rings (today) | drawer row, no beep (today) |
| The agent sent a notice, then the turn fails | notice rings; the failure rings (today) | the same |
| A question or a permission ask | rings (today) | rings (today) |

"Silent" is the dial's existing `silent` tier: the agent's tile updates its recap, nothing else happens.

## What the person sees

A Claude Code session in Orca needs the VPN. Today, in All:

```
 t+0 s  notify                       t+8 s  turn ends
 ╭────────────────────╮              ╭────────────────────╮
 │ ! Fix login · Mac  │  beep        │ ✓ Fix login        │  beep again
 │ Connect the VPN so │  wake        │ Done: I need the   │  the notice's row
 │ I can run the ...  │  pinned      │ VPN to run the ... │  is gone
 │      In Orca       │              │                    │
 ╰────────────────────╯              ╰────────────────────╯
```

After:

```
 t+0 s  notify                       t+8 s  turn ends
 ╭────────────────────╮              ╭────────────────────╮
 │ ! Fix login · Mac  │  beep        │ ! Fix login · Mac  │  no beep, no wake
 │ Connect the VPN so │  wake        │ Connect the VPN so │  the same card,
 │ I can run the ...  │  pinned      │ I can run the ...  │  still pinned
 │      In Orca       │              │      In Orca       │
 ╰────────────────────╯              ╰────────────────────╯
```

The drawer, after:

```
 ╭────────────────────╮
 │ ! Fix login        │   the notice, on top as every ask is
 │   Connect the VPN… │
 │ ✓ Docs             │   other agents' rows, unchanged
 ╰────────────────────╯
```

Opening the agent from its tile shows its recap, as every silent turn end does today.

The card goes as it does today: when that agent's next turn starts, when the person taps "In Orca", or when the agent
leaves. From then on its turns ring by the usual rules.

A failed turn after a notice (today's behavior, unchanged): it rings, shows its error for 8 seconds and its error row
takes the agent's drawer row. The agent's own answer still carries the ask.

## Flow

```
the agent's turn ends (a summary for the dial)
   ▼
on screen or a sub-agent? ─ yes ─▶ silent (today)
   ▼ no
this agent has a pending notice (notices.ts)?
   ├─ yes ─▶ silent: tile only; log rule:notice
   └─ no  ─▶ today's rules (rule:turn; Needs you lowers it to list)
```

Both of today's paths take the check: a tier decided upstream (`event.tier`, recaps or another machine) and one decided
here (`tierOf`).

## Decided

- The notice wins over the turn's end: it is the agent's own words about what the person must do; the recap is history.
- Silent, not `list`: a `list` summary still adds a drawer row, and the firmware's one row per agent would replace the
  notice's row with it. `silent` is the only tier the firmware leaves the drawer alone for (`ui_notify_summary` returns
  before `notice_add`).
- A failed turn keeps ringing: an error is itself something the person must see, and it is rare. Its row replacing the
  notice's row is accepted; the agent's answer has the ask.
- The daemon decides it, from what it already holds (`notices.from(agentId)`); no firmware or app release is needed,
  and an older dial behaves the same.
- The check is the pending card, not "a notice was sent this turn": a card closed by a tap ("In Orca") means the person
  is already at the agent, so its turn end rings by the usual rules.

## The how

- `cli/src/services/devices.ts`, the `summary` branch (today lines 727-753): after the on-screen/sub-agent check and
  before both tier paths, a pending notice of that agent makes the summary `silent` and tallies
  `tally('silent', 'rule:notice', 'notice', 0)`. Failed summaries (`event.failed === true`) are not touched.
  Whether the card is pending is read as the summary arrives (`toDial`), not when its turn in the agent's queue comes:
  a summary can wait up to 2 s behind its turn's `done` while the turn's tokens are read, and the next turn's start (a
  message sent while the agent worked) ends the card meanwhile.
- `Notices` gets one read, `pending(agentId): boolean`, if `from()` (which returns only the caller's names) is not the
  right question to ask.
- No change outside the devices component. No new setting.

## Tests

- Red then green, `cli/src/services/devices.spec.ts` (or the spec that drives the summary branch today): a notice
  shown, then the same agent's summary, is sent with tier `silent`, in All and in Needs you, on the upstream-tier path
  and the `tierOf` path; a failed summary after a notice keeps its tier; another agent's summary is unchanged; after the
  notice ends (tap or next turn), the agent's summary is `alert` again.
- `cli/e2e/deviceNotify.e2e.ts`: an outside Claude Code session's notice, then its turn end: the fake dial gets the
  summary as `silent` and no question close; the notice card is still there.
- By hand, on the real dial: a session asked to do work that needs a VPN beeps once, and the notice's line is still on
  the dial after the turn ends.

## Platforms

macOS (the dial and its daemon). Linux and Windows run the same devices code; Windows answers "no dial" today, so
nothing changes there.
