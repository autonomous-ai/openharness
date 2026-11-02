# Round dial keeps its screen across a daemon restart: plan

**Goal:** After a daemon restart (each CLI update), the dial stays on the Swarm, Lead and side it was on, instead of dropping to
the tabs list. Task #2051, asked for by Diego's Buddy on 2026-11-02.

**Why it dropped:** a session down wiped all Swarm state (`ui_supertabs_clear`). An empty list opened TABS, and `swarm_regain`
restored the face only within 10 s, while a restart takes 5-40 s to resend the Swarm cards.

## Design

- **Stale, not wiped.** A session down moves the face's Swarm, Lead and side into `sw.lost`. The cards and inbox entries still go:
  nothing is shown as current while the link is down.
- **No time limit.** The face comes back when that Swarm's card returns, however long it took.
- **What ends it:** the person touching the dial, or a non-empty list without that Swarm. An empty list says nothing: the daemon
  may not have read the cards yet.
- **The side.** A restarted daemon remembers no side, so the dial tells it the one it kept, when that Swarm still has Buddies.
- **Following the app.** A TABS the dial opened by itself counts as followable (`swarm_may_follow`), so the app's focus and a
  returning Swarm take it over. A person's own TABS is never followed off.
- **Focus order in the CLI.** `pushSwarmFocus` is only called at the end of `pushSwarmCards`, so the focus already comes after the
  cards. No CLI code changes: a spec pins the order on attach when the daemon reads the cards late.

## Design rules

- Growth: N/A because nothing is stored; one fixed-size struct in RAM, gone at reboot.
- Concurrency: under the display lock, as all Swarm state is.
- Read cost and scale: N/A because no reads are added; one short scan of a list of at most 16 ids.
- Compatibility: no frame changes. An older daemon ignores nothing new; the side frame already exists.
- Migration and rollback: N/A because no stored data.
- Audience: a kept id only ever matches a card the daemon sends this reader. Another account's list has no such id, and it is
  then forgotten.
- Identity: N/A because no person or login is read.
- Failure: if the cards never come, the dial stays where it is, as it does today, and the next non-empty list settles it.
- Platforms: round dial firmware only; a spec on the CLI side.

## Steps

1. Scene tests in `test_touch_ui.py`: session down 40 s, an empty list, app focus on another Lead or Swarm, a Swarm really gone, the
   person touching the dial, the person's own TABS, the side.
2. Change `ui_habitat.c`: keep `sw.lost` across `ui_supertabs_clear`, drop the time limit, forget on a list without it, follow on an
   auto-opened TABS, restore the side.
3. CLI spec for the focus order on attach.

## Not covered

Not run on a real dial: firmware is never flashed from this work. The tests run the production handler on the host.
