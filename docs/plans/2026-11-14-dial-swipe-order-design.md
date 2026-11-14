# The round dial's swipe order: a fixed ring

Status: approved choices from Diego through the PM (2026-11-14). Branch `fix/dial-swipe-order`.

## The problem

Diego cannot predict which agent the next swipe on the round dial lands on.

With no Harness window, the dial gets this computer's agents (the machine list, #4290). A swipe moves to the next
or previous row of the list the dial holds (`ui_habitat.c`, the `A_AGENT` swipe branch). The daemon re-sorts that
list on every change (`cli/src/cable/hosts/select.ts` `selectForDial`): needs-you, then working, then done and
unseen, then the rest, and inside each group the most recent activity first. Every new order is pushed to the dial
(`agentsKey` includes the order). Diego's daemon log shows 65 list pushes in one hour (2026-11-14, 17:00 local).

What that does under the finger:

- A, B, C working, D done and unseen. Diego is on B. C prints a line and moves ahead of B. Swiping right from B
  gives D: C was skipped.
- E starts asking a question and jumps to the front: every agent moves one place.
- Diego stops on D. D becomes seen, falls to the last group, and the next swipe starts from D's new place.
- Only 10 of Diego's 15 agents are sent. An agent that goes idle falls out of the ring and one that starts work
  comes in, so some agents cannot be reached by swiping at all.

The firmware keeps the agent on screen by its id (`ui_project_apply_order`), so only the neighbours change. The
firmware needs no change.

## What changes

**The machine list becomes a fixed ring of at most 16 agents.**

1. **Order is fixed.** An agent keeps its place from the moment it enters the ring. A state change (working,
   needs-you, done, seen) never moves it. A new agent enters at the end. When an agent leaves, the others close up
   and keep their order.
2. **16 places.** The firmware already holds 16 (`CABLE_MAX_AGENTS`, its arrays are allocated at that size), so
   the firmware's memory does not change. Diego's 15 agents all fit.
3. **An agent in the ring stays until it ends** (its source stops listing it).
4. **When the ring is full**, an agent outside it enters only when it is new (never seen by the ring) or needs the
   person. It takes the place of the ring agent idle the longest: the oldest `lastActivityAt` among the ring agents
   that are idle, that is neither working nor needing the person (Diego's word, "nghỉ"). An agent with no known
   activity (`lastActivityAt` 0, as a Harness agent can be) counts from the moment it entered the ring: missing data is
   not idleness (the PM, 2026-11-14). The newcomer goes to the end of the ring, not into the freed place. An agent that works or needs the person is never replaced. If no ring agent
   is idle, the newcomer waits outside.
5. **A free place** (an agent ended) is filled from outside: agents that need the person first, then the most
   recent activity. The newcomer goes to the end.
6. **Needs-you is not an order.** The dial still learns it as today: the activity line "Waiting for you · {Host}",
   the notification and the bell. No new UI.
7. **The first ring** (the devices process starts, or a dial attaches to a host with no ring yet) takes the agents in
   the order the registry lists them, then cuts at 16 with rule 5's priority. While the Swarm cards are awaited
   (`machineSnapshot`, a few seconds after attach), Harness agents are hidden; they join at the end when the cards
   come.
8. **Several arrive in one pass** (an attach scan, the Swarm cards): they enter needs-you first, then by most recent
   activity; an agent that entered in this pass is not replaced in the same pass, so at most 16 enter; those entering
   together go to the end in the registry's order. An agent that found no place counts as seen: it enters later only
   through a free place or when it needs the person, so the ring never turns on every pass.

`total` stays every agent on this computer.

### What does not change

- **With a window**, the dial holds the active tab's panes in tile order, as today. The ring is only the machine
  list.
- The firmware. Swiping still wraps from the last agent to the first.
- The Buddy filter and the wait for Swarm cards (`machineSnapshot`) still decide which agents the ring may see. An
  agent they hide is, for the ring, not there.
- The 1 s coalescing of machine-list pushes.

### Effect on pushes

The list is pushed when its members or order change. With a fixed order, it changes only when an agent enters or
leaves the ring: a state change no longer moves an agent, so it no longer pushes the list (state still goes as the
per-agent frames). The
PR records the pushes per hour before and after on the same workload.

## Design

- `cli/src/cable/hosts/select.ts`: `selectForDial` becomes a small stateful ring, `DialRing`, with one method,
  `select(agents: HostAgent[]): { rows: HostAgent[]; total: number }`. It holds the ordered ids in the ring (at most
  16) and the ids it has seen, so it can tell a new agent from one that was cut. The seen set is bounded: an id is
  dropped from it once its source stops listing it. Pure apart from that memory, no timers, no I/O.
- `cli/src/cable/cableHost.ts` `machineSnapshot`: one `DialRing` per `CableHost` (so every dial on this computer
  sees the same ring), called where `selectForDial` is today.
- The ring is in memory only. A restart of the devices process rebuilds it by rule 7.
- `docs/specs/2026-11-13-device-without-the-app.md`: its Order and How many lines, and every other line that states
  the old rule (the ten rows, "the ones that need the person first"), say the ring, in the same pull request.

Both code files are also changed by PR #4296; no code on them before it merges.

## Failure cases

- An agent's id changes (a session rebound) — it is a new agent: it leaves, the new id enters at the end.
- No ring agent is idle (all 16 work or need the person): newcomers wait outside, and the notifications still name
  them. An agent waiting for a permission (#4296: the line "<command> · answer in {Host}") needs the person and
  follows the same rules.
- Many outside agents arriving at once (60 observed sessions): each new one may replace one ring agent, so the
  ring changes only at its end, one place per newcomer.

## Tests

- `cli/src/cable/hosts/select.spec.ts` (red first): order kept across state and activity changes; a new agent at the
  end; a removed agent closes up; 16 places; full ring: a new agent replaces the longest idle and goes to the end; an agent with no known activity counts from
  when it entered;
  a needs-you outsider enters; a working or needs-you ring agent is never replaced; no idle ring agent: newcomer
  waits; several in one pass (rule 8);
  a free place is filled needs-you first; the first ring cut by rule 5; the seen set drops ended ids.
- `cli/src/cable/cableHost.spec.ts`: the machine view keeps the order across a state change and sends no push for
  it.
- On a real round dial (needs the PM's go for the shared dial), against an isolated daemon, never Diego's own: 16
  agents in the machine list, swipe the whole ring both ways while agents change state, no reboot, no watchdog,
  heap as before.

Platforms: the daemon on macOS, Linux and Windows (pure TypeScript); the round dial.
