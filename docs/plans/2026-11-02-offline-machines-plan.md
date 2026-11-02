# Desktop Machines: an offline machine never looks busy or without a subscription

**Goal:** Dee's Mac 1, offline, showed "34 agents" and "No Claude or Codex allowance reported for this machine".
Both read as facts about now. The machine is off, so nothing runs there, and its allowance is unknown.

**Scope:** `desktop/lib/super_tabs/machines.dart` (agent count and Subscriptions builders), the two strings in
`machine_allowance.dart`, and their Desktop tests. Row layout is out.

## What changes

1. Agents line keeps the total and says what happens now. Online: `N agents · K working` (K is the Working group of
   the list below, so the two agree). Offline: `N agents · none running, machine offline`, in the muted ink. If a
   session this Desktop holds says an agent is working, the machine is not shown as idle (the list says Working).
   A machine the Desktop cannot read (unknown, refreshing) shows the total only.
2. Subscriptions with no Claude or Codex card: an offline machine says `Not read yet. Shows when the machine is back
   online`, with `offline` beside the heading. `No Claude or Codex allowance reported for this machine` stays for an
   online machine only.
3. A machine whose engine list still names a retired engine (OpenCode) showed an empty block unless it had quotas.
   Its Claude and Codex cards now come from its quotas, its configured Claude/Codex, and what it has installed
   (`observation.readiness.engines[].installed`, already reported by the CLI). An installed engine with no reading says
   `Not read yet` (offline: the longer line), not "Update Harness".

## Tests (written first, each fails on main)

- `super_tab_machines_test.dart`: offline total + muted ink (34 and 1 agent); online `N agents · K working` with
  native sessions.
- `super_tab_machine_subscriptions_test.dart`: offline machine with no reading; retired-engine list with installed
  Claude+Codex (offline), only Claude installed, and a live reading beside an installed engine that sent none.

## Design

- growth, concurrency, read cost, migration: N/A because it only changes what a build derives from the snapshot the
  screen already holds; nothing is stored, synced or read more.
- compatibility: hosts before `readiness` send none, so they behave as before (an empty or quota-listed block).
- audience / identity: N/A because it reads no new field of another person's data; `readiness` is the machine's
  own engine probe, already in the pool every viewer reads.
- failure: an unreadable machine shows the total only, never "none running".
- platforms: Desktop and web share these widgets; the phone has no copy of these strings (searched).
