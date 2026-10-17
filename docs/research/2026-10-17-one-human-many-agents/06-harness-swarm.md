# Swarm in Harness: the product

Draft, 2026-10-17. The framework in [05](05-framework.md) as a Harness feature. UI decisions come from the owner's design sessions of 2026-10-17; the infrastructure comes from the bottlenecks in [04](04-bottlenecks.md).

## Principles
1. **A swarm is its own thing.** A Swarm tab with its own UI, like the Store. Ordinary tabs stay plain: no messaging, no notes, no tasks. A swarm never leaks into them.
2. **Workers are people on a floor.** Every worker's live terminal is a desk; you visit a desk to watch or talk.
3. **Harness provides capabilities, not process.** Messaging, tasks, waking, routing, capacity. A project's own playbook decides how it works. Harness's first agent-team protocol prescribed a process; the first real team routed around it and it was removed after 13 days ([01b](01b-harness-repo.md)). What worked was Git, tasks and a doorbell.
4. **The owner's attention is the scarce resource.** Everything that needs a person is routed, batched, and comes with a recommendation.
5. **Off costs nothing.** No process and no polling for a machine that isn't in a swarm.
6. **Remove serial points before adding capacity.** The pilot's largest costs came from things there was one of: one reviewer, one subscription carrying the reviewer and the lead, one integration device, one lead dispatching, one thread ([04](04-bottlenecks.md)). Review and merge set its output ([14](14-which-gate.md)). Compute limits were fixed within a day; the single points never were.

## 1. Making a swarm

```
⚇ New Swarm
  Goal       Ship setup for a home: Wi-Fi, name, 5 s reset
  Repo       acme/device-os  ·  branch: integration
  Playbook   use the repo's AGENTS.md and joining guide  (or Harness's default)
  Lead       Claude Code on studio-mac
  Workers    4 builders · 1 reviewer   on studio-mac, build-box
  Autonomy   3 · I decide what the lead escalates
  [Create]                                             [Invite people…]
```

The lead starts with the brief as its first message. The workers start knowing their name, role, area and playbook, the way the pilot's builders start from `you are fifth`.

## 2. The floor

Every worker is a desk: a live terminal, scaled to fit, that never resizes the agent's real terminal.

```
 ⚇ device-os                                                   Mira ● Tomas ● ⌘K
┌────────────┬────────────┬────────────┬────────────┬────────────┐
│★ lead  Mira│? first Mira│● second    │✗ third Mira│● fourth Tom│
│▌38 merged  │▌elbow won't│▌holds ok   │▌CI 2 failed│▌run 3 of 5 │
├────────────┼────────────┼────────────┼────────────┼────────────┤
│● fifth  Tom│◐ sixth Mira│● seventh   │○ eighth Ine│● nine   Ine│
├────────────┼────────────┼────────────╋━━━━━━━━━━━━╋────────────┤
│○ ten    Ine│● el     Tom│● review Mir┃● tests Mira┃● ines-1    │
└────────────┴────────────┴────────────┴━━━━━━━━━━━━┴────────────┘
  arrows or click to move · ⌘⏎ zoom · ⌘⇧T panel                         2 need you
```

- **Desks keep their places,** so you learn where everyone sits. The lead takes the first desk.
- **Each desk's title** shows mark, name, manager and current task.
- **⌘⏎ zooms** (Harness's existing pane zoom, tmux's prefix-z) to real size; ⌘⏎ again returns to the floor. Esc always goes to the agent.
- **Typing goes to your own workers,** on the floor or zoomed. Other people's workers are read-only (🔒).
- **Attention:** `?` desks get a yellow border, `✗` desks a red one. Avatars show who is looking at a desk.
- **Scale:** about 20 desks fit on a big screen and 12 on a laptop; past that the floor scrolls.

## 3. The panel (⌘⇧T): You, Tasks, People

```
┌─ YOU ──────────────────────────────┐
│ Decide  #1155 hello quiet: lead    │
│         says yes        [yes] [no] │
│ Hands   first: elbow at device-4a  │
│ Try it  3 changes since lunch      │
├─ TASKS ────────── 12 open · 38 ✓ ──┤
│ ● Stop words stop it   fourth      │
│ ◐ Cut-ins not talk     sixth       │
│ ✗ Setup breathes ring  third       │
│ ○ Stuffy air skill     ten         │
│ ◇ Slow tests outside   tests       │
├─ PEOPLE ───────────────────────────┤
│ Mira (owner) 8 · Tomas 4 · Ines 4  │
│ ✉ Invite people…                   │
└────────────────────────────────────┘
```

- **YOU** is per person and routed: the owner's decisions; each person's own resources (their machine, devices, budget); "try it" for testers. Every item names who can act on it. It's raised to the lead if it sits too long.
- **Every YOU item is a packet, not a question.** The lead or worker prepares what changed and why, the options, its recommendation, the evidence (tests, recordings, screenshots, CI), the risk, and how to undo it. The owner answers in one key or one line. Anthropic's "Claude leads" level works the same way: read the write-up, skim the change, decide. The pilot's owner already worked this way, through a chat with the lead and a local review page. The YOU box makes that page a product.
- **TASKS** are native, one flat list with marks: `?` waiting on a person, `●` working, `◐` PR in review, `✗` CI failing, `○` open, `◇` proposed, `✓` done (filter). The row shows the task and its worker; hovering shows the latest recap and the PR. A task's PRs show inside it, with no separate PR list.
- **PEOPLE** lists who's in the swarm and their workers, plus invitations, including incoming ones from other swarms. This replaces Settings ▸ Tab invites.

## 4. Workers

```
+ Worker
  Name       fifth            Role   builder ▾
  Machine    build-box ▾      Folder ~/src/device-os
  Engine     Codex ▾          Permission mode   auto (sandboxed) ▾
  Owns       crates/voice, crates/stop-words
  [Add to the floor]
```

- **Its name is the address everywhere:** messages, task owners, branches, logs. Never the session title.
- **The permission mode is chosen once,** so the worker never needs its manager for routine commands.
- **It starts knowing the swarm:** brief, playbook, its area, how to read its tasks.
- **Members add workers from their own machines.** Owners of shared machines can lend capacity without being present.
- **Spawning has limits.** A worker may start helpers within a quota (in Harness today: 4 open, one level deep, 20 starts per 10 minutes, 40 per machine), closes what it started, and idle helpers close on their own. Every started task says who sent it.

## 5. Tasks and threads (native)

The agent's side is a CLI, and an MCP tool for agents that prefer one:

```
harness task                          # my tasks, next first
harness task next                     # take my next open task (atomic claim)
harness task new "Fix X" --for fifth --bar "9 of 10 within 300 ms"
harness task post 828 "A/B: 10/20 both ways. #1158 isn't the cause."
harness task done 828 --evidence PR#1291
harness task propose "Slow tests outside the realtime group"
harness decide "Hello quiet: count only talk to the device?" --options yes,no --recommend yes
```

- **Pull, not dispatch.** Builders posted 64 "my list is empty" reports, answered after a median 23 minutes and up to 12 hours. Most were builders whose own work was waiting in review ([14](14-which-gate.md)), so pulling helps only once review has room. When a worker's work is all waiting downstream, `next` offers the oldest PR in the review queue first. `next` takes the worker's next task if it has one; if not, the oldest unowned open task in its area; if not, any unowned task its role may take. The lead curates the backlog and the order; it doesn't have to be awake for work to flow.
- **Leases, not locks.** `next` takes a lease that renews while the worker is alive and expires when it stops (machine off, limit hit, crashed), so the task goes back to the backlog. In the pilot, claim races were rare; the lease is for liveness, not races. A lock file collapsed Cursor's 20 agents to the throughput of 2–3.
- **Only a verifier moves a task past *working*:** the reviewer, tester, CI, or a person. The worker asks; it can't mark its own work done. State comes from evidence (PR, CI, the merged tree), never from an agent's report: models say "done" before the signal arrives.
- **Duplicate check on create.** A new task that resembles an open one is flagged to the lead.
- **The write-up is required on hand-back:** what changed, how it was verified, risks, deviations, findings.
- **Storage:** the swarm owner's machine is the authority, and members keep encrypted copies through the relay (the shared-tabs roster model). The backend never reads task content.
- **PR state** (CI, review, merged) is read with each member's own GitHub login and shown on the task.
- **Decisions** are their own objects: options, recommendation, answer, date. They're searchable, and the lead turns repeated ones into playbook rules.

## 6. Delivery and liveness

Built on Agent Messages' delivery (hook at the next tool call, typed when idle, FYI, the 5-minute hold) and shared tabs' cross-account relay:
- **Each event goes to whom it concerns:** an assignment to its worker; a post to the task's worker and the lead, plus anyone named; a CI failure to the PR's worker; a review result to the worker and the lead.
- **Never idle:** when a worker's turn ends with open tasks, Harness gives it its next step. When it has none, the lead hears at once.
- **Dead workers:** offline or out of budget past a grace period, so their tasks go back to the backlog.
- **No single stop.** A lead's question to the owner becomes a packet in YOU, and the lead carries on; it never sits on a prompt (the pilot lost 3.4 hours of dispatch to one). If the lead itself stops, a deputy takes the lead's queue until it's back.
- **Inbox per worker,** with read state and "new since your last read". In the pilot one builder read only the oldest 100 comments and missed three tasks.
- **No polling** anywhere: no worker reads a thousand-comment thread to find its task.

## 7. Capacity: the bottlenecks as features

From [04](04-bottlenecks.md), each one designed in:

| Bottleneck | Swarm feature |
|---|---|
| **Dispatch through one lead** (most hours lost; less output lost, see [14](14-which-gate.md)) | Workers pull from the backlog; a deputy lead; the lead never blocks on a question (§5, §6). |
| **Review and merge** (set the pilot's output) | Merge authority by change class (§7½); a reviewer pool with failover after N minutes of silence; a live board of first-review waits against the bar; a merge lease, so two agents never merge the same PR. |
| **Gatekeepers on one subscription** (stopped output) | Each subscription's usage and burn rate per worker, with a forecast of when it stops. A warning when the lead and the reviewer share one; Harness places them on different subscriptions or engines. A worker that hits a limit says until when, and its queue moves to a standby. |
| **Flaky tests under load** | A flaky-test registry that labels red runs ("known flake, task 739"); one test red across unrelated PRs becomes one task with one owner. The load average is recorded with each local result. |
| **CPU and load** | A per-machine limit for heavy jobs (builds, full test runs), scheduled by Harness. Workers queue for a slot instead of piling on. |
| **CI** (#5) | Shown per swarm: queue position and expected wait, runs per PR, the runner limit. A warning before a workflow change multiplies runs beyond the runners. Run CI for a branch without a PR. Tests left out of the fast run are a tracked gap, not a silent one. |
| **Devices** (#6) | A device registry: owner, parts (body, voice, camera), what runs on it. A lease held by a worker's session that ends with the session; "unreachable" is never "free". A job queue per device ("needs a minute on device-a"), batched so one install carries several PRs, routed to any free device of the right kind. A safety hold per device kind that only a named person clears. |
| **Hands and decisions** (#7) | The YOU box, with decision latency measured. Hands requests batch into the hours each person is there; nights get work that needs no hands. Work built on a provisional decision is marked, so a reversal shows what it touches. |
| **Disk** (#8) | Per-worker build folders with a size budget. Cleanup when a task ends, including the agent's own scratch folders. A machine below its floor gets no new heavy jobs, and the lead hears why. |
| **Shared build caches** | One build folder and one container volume namespace per worktree, never shared, created by Harness. Two builds pointed at one folder are refused. |
| **Integration branch** (#9) | Merges go through a queue tested on the real head. When the branch is red, one worker claims the fix and the others wait or rebase automatically. Cancelled runs never show as failures. |
| **Coordination volume** (#10) | Native tasks and inboxes; no worker reads a thread to find its work. |
| **Access** | Scoped, time-limited grants (ssh, sudo, keys, repos) approved on the right person's phone; a standing grant covers a class ("read-only ssh to my device"). An access check when a task is assigned, so a missing repo surfaces before the work starts. |

## 7½. Verification as a product surface
- **Routes by path.** The swarm's rules map paths to verification rungs. For example: `docs/**` and `**/tests/**` merge on CI plus review; `crypto/**`, `payments/**`, `deploy/**` and anything irreversible always reach a person.
- **Reviewer on a different model** by default. A Codex reviewer for Claude builders, and the reverse.
- **Hidden scenarios.** Acceptance scenarios a worker never sees, run by the tester. Tests that grade a worker are read-only to it.
- **The "shown working" step.** A switch is turned on only after a device run or a person's try-it, and the floor shows how many merged switches are still off.

## 8. Swarm health

One line under the floor, with a page behind it:
```
165 merged/day · PR wait p50 1.5 h · 24 waiting · rework 18% · idle 0 · decisions waiting 2 (oldest 40 min) · $212 today
```

The page behind it shows **each gate's saturation point** ([04 §3](04-bottlenecks.md)): CI saturates near runners ÷ 0.58 builders, one reviewer near 15, one lead near 15. With 16 builders it says "add a reviewer", not "add a builder".

## 9. What we keep from what's shipped
- **Agent Messages:** delivery, hold, FYI, read marks, the pane line.
- **Shared tabs:** invites, owner-signed roster, trust pins, blind relay, consent, read-only watching, limits, the leader setting, and the People panel. All of it moves under the Swarm.
- **Removed:** the account-wide Settings switch, the GitHub-marker tasks, the per-tab team mode, Settings ▸ Tab invites.

## 10. Primitives: capabilities, not process

Harness shouldn't encode one team's process. It should give every swarm a small set of primitives that any playbook can compose. The pilot's playbook (queue, claims, reviewer, wake-ups, device ownership) should be expressible entirely in these:

| Primitive | Agent's side | What it replaces in the pilot |
|---|---|---|
| **name** | `HARNESS_WORKER=fifth`; `harness whoami` | `you are fifth`, role files found by hand |
| **task** | `harness task new/next/post/done/propose` | issues, `builder:` labels, `status:taken` races |
| **decide** | `harness decide "…" --options … --recommend …` | questions buried in comments; "no answer means not taken up" |
| **send** | `harness send <name> "…"` (Agent Messages) | comments addressed "First builder, to Fourth" |
| **wake** | automatic: next step on turn end; idle reported | "Never end a turn without a wake-up" plus `/loop` timers |
| **slot** | `harness slot build -- cargo build …` waits for a heavy-job slot on this machine | builds piling up until tests fail under load |
| **hold** | `harness hold device-4a --for 20m "fold test"` with a queue and an owner | device owner files, "ask before every ssh" |
| **space** | a worktree and build folder per worker, with a budget and cleanup | "one build folder per checkout", manual `cargo clean` at 20 GB |
| **ask a person** | `harness ask hands device-4a "unplug the servo bus" --person owner-of-device` | requests in queue comments |
| **report** | `harness report` gives the swarm-health line and per-worker state | the lead tallying by hand ("80% today") |

What Harness already ships toward these (CLI 0.4.x, October 2026):

| Primitive | Status |
|---|---|
| name | partial: `harness whoami` knows the agent and machine, not a worker name |
| task, decide, slot, hold, space, ask a person | new |
| send | shipped: Agent Messages, with hook delivery, FYI and hold |
| wake | partial: delivery wakes an idle agent; no "next step" on turn end |
| managing workers | shipped: `harness new / ps / show / wait / close`, `--machine`, the MCP server |
| report | partial: `harness ps`, recaps per turn |
| people | shipped: shared tabs (invites, trust, relay, read-only watching) and shared machines |

A swarm that ignores some of these still works. The lead can keep its own queue issue, and a team can keep using GitHub. Each primitive simply makes one part of the hand-built process unnecessary.

## 11. Order of building
The first step is specified in [13](13-first-slice.md), after the rule experiments in [08 §0](08-experiments.md).

1. **The Swarm tab and floor,** with plain workers you add, and the panel's People. No tasks yet. You can already run a swarm as the pilot does, with the lead using GitHub.
2. **Native tasks and threads, and the YOU box,** with `harness task` and `harness decide`.
3. **Delivery and liveness:** routing, never idle, dead-worker release.
4. **Capacity:** disk and CPU budgets, the device registry, subscription usage.
5. **Swarm health and the autonomy dial.**
6. **Sub-swarms:** domain leads under one brief.
