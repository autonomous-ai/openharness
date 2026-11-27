# Dial: herdr pane ids with letters

## Problem

#4500 shipped (CLI 0.6.74), yet on Diego's Mac an agent in herdr inside a Terminal tab never reached Terminal's page and a
swipe never followed it. The devices log said `[herdr] listed · 0 agents`, no `[device] herdr client · …` line at all,
and `tab · skipped · unknown agent` on each swipe.

## Cause

herdr writes its public ids in base 32 over `123456789ABCDEFGHJKMNPQRSTVWXYZ0` (`src/workspace.rs` `encode_public_number`,
the same in 0.8.0 and 0.9.5), and a workspace's pane numbers keep counting across restarts (the snapshot's
`next_public_pane_number`). The tenth pane of a workspace is `pA`. Diego's two Claude Code panes were `w2:pE` and `w2:pF`.

Harness held a pane id to `^w[0-9]{1,9}:p[0-9]{1,9}$` (`herdrClient.ts` `HERDR_PANE`, `herdr.ts` `PANE_WITH_APP`), so:

- the herdr source dropped every listed agent (`listed · 0 agents`);
- `herdrOuter` returned before its lookup, with no log line;
- the herdr adapter took no pane, so the agent had no place and a tab line found no agent.

#4500's e2e started a fresh herdr server, whose ids are `w1:p1` and `w1:p2`, so it never met a letter. A fresh herdr
0.9.5 on Diego's Mac worked for the same reason, until a workspace opens its tenth pane.

## Design

1. `HERDR_PANE` takes herdr's own id form: `^w[0-9A-HJKMNP-TV-Z]{1,9}:p[0-9A-HJKMNP-TV-Z]{1,9}$`. `PANE_WITH_APP` in
   `herdr.ts` is built from the same id form, so one definition holds it.
2. A skip is seen, in fixed words, with no id in the line:
   - `[device] herdr client · skipped · pane-id` when a hook's `HERDR_PANE_ID` is there but out of form, said once per id
     (a bounded set);
   - `[herdr] skipped · <n> pane-id` when `agent.list` rows are dropped for an out-of-form pane id, said when the count
     changes.
3. Tests at each layer with `w2:pE`, red first, and the herdr-in-Terminal e2e on herdr 0.9.5 with two Claude Code panes
   whose ids carry a letter.

No daemon core change; nothing new stored, synced or exposed. Platforms: macOS (the herdr-in-Terminal lookup), and the
herdr source and adapter on macOS and Linux.
