# A resumed agent keeps its multiplexer's page while its new caller is looked up (iTerm2 eval I14)

## The failure

Tier B's iTerm2 file on main fails I14 intermittently (load-dependent; I14 alone passes):

- VS Code V12 child's run (main 54977dc9aa): `b/darwin/I14/ringHerdr.{recall,precision,order,cap,archived,apart}` 1 → 0,
  the dial showing iTerm2's page before the scenario's own pick of it.
- This branch's diagnostic run (main ca527a7dbd): `b/darwin/I14/ringHerdr.order` 1 → 0, herdr's ring `d c` where it
  was `c d`.

## The cause

I14 restarts herdr: its server, client and agents end with no hook, then each session is resumed in a new pane
(`claude --resume <id>`), a new process with the same session id. The devices log of the run shows, for c's resume:

```
05:34:56.704 [hooks] paneless claude session-start · forwarded
05:34:56.744 [cable] cable: agents → 1 of 1          <- herdr's ring lost c
05:34:56.827 [device] herdr client · found           <- c's lookup answered
05:34:57.750 [cable] cable: agents → 2 of 2          <- c back, now after d
```

`ObservedSource.askOuter` (cable/hosts/observed.ts) drops an agent's multiplexer (`HostAgent.nest`) at once when a hook
comes from another caller, and puts it back only when that caller's outer lookup answers. Meanwhile the agent is on its
hints' app page (iTerm2's), so:

1. it leaves herdr's ring and comes back at its end: `order` fails (DialRing keeps an agent's place only while it stays);
2. when both c's and d's lookups run at once (the Mac under load), herdr's page has no agent at a read, the dial's pick of
   it is dropped (`AppFilter.shown`: the shown app emptied) and the dial falls back to the app in front, iTerm2: every
   part of `ringHerdr` fails.

The cause predates #4591; the window is a ps read or two long, so load decides whether a read lands in it.

## The change

A hook from another caller, or another pane, whose own hints carry the variable of the multiplexer the agent was
confirmed in (`HERDR_PANE_ID` for herdr, `TMUX_PANE` for tmux; that variable itself, not `detectHost`, which says herdr
for tmux inside herdr, whose hints carry both) keeps that multiplexer while the new caller's lookup runs, as a new ask
from the same caller already does. Only when a lookup was asked: with none, nothing is kept. The lookup's answer then
confirms it or drops it (`landOuter`), as today. The client's place (its app's tab and process) is still dropped at
once, so no tap or rest uses the old tab, and a caller whose hints name another multiplexer, or none, drops the
multiplexer at once as today.

This changes one decision pinned by `observed.spec.ts` "another caller or pane drops nest at once", in both its cases
(another caller, the same caller in another pane): for hints that carry the same multiplexer's variable, nest now stays
until the answer. Diego's rule (2026-11-23) that an agent is on tmux's or
herdr's page only while its lookup confirms its terminal is the pane holds as for the same caller's new ask: the last
confirmation stands until the new lookup answers. A resume in a terminal started from a tmux or herdr pane (VS Code
started from tmux, its `TMUX_PANE` inherited) sits on the multiplexer's page for that lookup, then moves, instead of
sitting on its app's page for it.

Same cause, every case: tmux and herdr both (Nest), any event from a new caller (a resume's session-start, a turn).

Zellij has no `nest` (`Nest` is tmux or herdr), and an agent in Orca is on Orca's page whatever its nest: neither
changes.

Known gap, another cause: the devices' 30 s look (`ObservedSource.tick`) running between herdr's end and the resume
removes the ended agent, and the resume is then a new entry, pending until its lookup answers. The step leaves about a
second between them, so a look lands there in a few runs in a hundred. Not in this change; said in the PR.

## Tests

- Red first, `observed.spec.ts`: an agent confirmed in herdr, and one in tmux, whose next session-start comes from
  another caller (and the same caller in another pane) with that multiplexer's variable keeps `nest`, its page and no
  `appPending` while the lookup runs, its tab place dropped (`paneOf(…, 'tabs')` undefined); an answer with no nest drops
  it; the old ask's answer lands nothing; tmux inside herdr (both variables) keeps tmux; hints with no multiplexer's
  variable, or no lookup, drop it at once. The pinned test above is updated to these.
- `devices.spec.ts`: with herdr's page picked and two herdr agents, both resumed from new callers whose lookups are held
  pending (a deferred process read): the dial keeps herdr's page and both rows in their order across the reads.
- The eval: tier B iTerm2 file 3 times (I14 `ringHerdr.*` all 1 each run), then both tiers once; baseline.json updated
  in the same PR. Tier A's I14 stays as it is.

## Platforms

macOS and Linux (tmux and herdr lookups run there); Windows has no tmux or herdr lookup, nothing changes there.

## Not in this change

`b/darwin/I14/ringHerdr.names` and `ringKeptHerdr` are 0 in the baseline before this change (names after herdr's
restart): looked at after this fix, its own change if its cause differs.
