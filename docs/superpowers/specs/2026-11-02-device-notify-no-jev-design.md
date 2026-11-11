# Device notifications without Jev

Date: 2026-11-02. Requested by Diego.

## Problem

When an agent finishes a turn, the recaps service decides how loudly the person's devices hear of it
(`cli/src/lib/notifyTier.ts` `createTierDecider`, used by `cli/src/services/recaps.ts:61-64` and
`cli/src/services/devices.ts:378-401`; design `docs/superpowers/specs/2026-10-19-device-notify-tiers-design.md`):

1. fixed rules: a failed turn alerts; a sub-agent's turn, an agent on screen or an empty recap is silent;
2. **Jev** (a hosted model) picks alert, list or silent;
3. when Jev cannot answer, a duration fallback: 120 s or more is list, shorter is silent.

Diego does not want a model deciding whether he is told. Today Jev marks most finished turns silent, so the dial
rarely tells him a harness agent is done. The same decider also runs for Swarm agents (PM, Buddy, workers), whose
news already reaches the dial through the Swarm chat cards (`cli/src/superTabs/cards.ts`).

## Decision (Diego, 11-02)

- Remove the Jev step.
- A harness agent's finished turn that passes the fixed rules **alerts** (option A).
- A Swarm agent's finished turn is **silent** on devices: the Swarm tells its news through the chat cards, which this
  change does not touch.

## Design

- `createTierDecider` keeps the fixed rules, in order, then:
  - a Swarm agent (`swarm: true`) -> silent, `rule:swarm`;
  - otherwise -> alert, `rule:turn`.
- It no longer takes, creates or calls a Jev client, and no longer keeps the 30-minute `recent` window. `tierState`,
  the Jev questions and the `jev` option go; `fallbackTier` stays, because `lib/commander.ts` still uses it when a
  decision is superseded before it lands.
- `TierInput` gains `swarm: boolean`.
- A Swarm agent is an agent whose registry row carries `swarmSkill` (any role: PM, Buddy, Builder, Reviewer, Tester),
  or any agent on a Harness Team account machine. `devices.ts` already tells a Swarm worker this way (`swarmWorker`,
  :423-427, role `agent` only); it widens to every role and is shared by the recaps' and the dial's decisions.
- `recaps.ts` decides with the session's row; `devices.ts` (a card that arrives without an upstream tier) decides with
  the same check. A remote agent's card normally carries its own machine's tier, so nothing changes for it.
- The decision log keeps its shape (`notify · <agent> · <tier> · rule:<name> · …` and the day's counts), so the log
  still shows the volume.
- `HARNESS_NOTIFY_SMART` loses its meaning and is removed.

## Who is affected

The tier is decided once for the dial, the Harness Pro, and apps listening over the relay (the phone reads it from
`turn_summary`). So a harness agent's finished turn now alerts on all of them, and a Swarm agent's turn is silent on
all of them. The Desktop window on the same computer reads no tier, so it is unchanged.

## Known limits

- A Swarm agent started without its Swarm skill has no `swarmSkill` on its row, so its turns alert like a harness
  agent's (`superTabs/start.ts` sets the role only with a skill mode).
- A card from an older remote daemon that sends no tier is decided here; a Swarm agent there that is not on a Team
  machine alerts, because this machine cannot read its row.

## Non-goals

- Swarm chat notices on the dial (cards), and making device counts match the apps (the attention-summary work).
- Re-announcing open questions after a daemon restart.

## Design checklist

- Growth, concurrency, read cost, scale: one fewer network call per finished turn; nothing stored.
- Compatibility: devices already accept all three tiers; older daemons keep deciding with Jev.
- Migration and rollback: none; reverting restores Jev.
- Audience, identity: nothing leaves the machine any more for this decision (Jev received the recap text).
- Failure: no external call, so no timeout path; the fixed rules always answer.
- Platforms: all.

## Testing

- `notifyTier.spec`: a harness turn alerts (`rule:turn`); a Swarm turn is silent (`rule:swarm`); the fixed rules win
  over both (failed alerts, sub-agent, on screen and empty recap are silent); no Jev client is called or accepted.
- `recaps` / `devices` specs: an agent with `swarmSkill` (role `lead`, `buddy`, `agent`) and an agent on a Team
  machine are decided silent; a plain harness agent alerts.
