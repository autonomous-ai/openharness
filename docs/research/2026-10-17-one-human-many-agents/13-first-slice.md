# The first slice: what to build first, and on what

2026-10-17. A spec for the smallest Swarm that removes the pilot's top costs ([04](04-bottlenecks.md)), to build only after the rule experiments in [08 §0](08-experiments.md) hold. It's built from parts Harness already ships. Not a plan for everything in [06](06-harness-swarm.md).

## 1. What the slice must remove
| Cost in the pilot | The slice's answer | Accepted when |
|---|---|---|
| Review and merge set the output ([14](14-which-gate.md)) | A reviewer pool; `next` offers the oldest PR waiting review to a worker whose own work is all downstream; the review gate's saturation on the health line | Merges an hour rise with the swarm (were flat at ~9) |
| Builders waiting for the lead | `harness task next` pulls from the backlog | Wait from an empty list to the next task: median under 5 min (was 23) |
| A thread nobody can read | Native tasks and an inbox per worker | No missed assignments; coordination tokens per hour down 10× (was ~1 M) |
| One subscription stopping both gatekeepers | A warning when the lead and the reviewer share a subscription | No window where merges stop (they fell to 0–2 an hour) |
| A lead blocked on the owner | `harness decide` puts a packet in YOU and returns at once | No dispatch stop longer than 15 min |
| No view of the whole floor | The Swarm tab with the floor | The owner runs a day from the floor without a terminal grid |

**Out of the slice:**
- capacity scheduling (slots, disk budgets);
- device holds;
- the verification ladder;
- sub-swarms and budgets;
- pricing.

They come after the slice is judged.

## 2. Objects
```
Swarm    id · name · owner (account) · brief (a markdown file in the repo or the swarm folder)
         members (the shared-tabs roster) · workers · settings (autonomy, areas)
Worker   name (unique in the swarm) · role · person · machine · folder · engine · harness id · areas[]
Task     id · title · bar · area · order · state · owner (worker) · lease {holder, until}
         proposed_by · verified_by · evidence[] (PR, CI run, recording, note) · posts[] · version
Decision id · question · options[] · recommendation · evidence[] · asked_by · answer · answered_by · at
Inbox    per worker: items (assignment, post, review, CI, decision answered, message), each read or unread
```
- **A worker's name is its address** everywhere: tasks, messages, branches. It's never a session title, which goes stale.
- **A task's `version`** changes on every write. Writes are compare-and-set, so two workers can't both take one task.

## 3. States, and who moves them
```
proposed ──lead/owner──▶ open ──next──▶ working ──worker: ready──▶ review ──verifier──▶ verified ──merge/switch on──▶ done
    │                     ▲               │                          │
    └──no answer 24 h─────┘ (closed)      └──lease lost──▶ open      └──changes asked──▶ working
```
- **The worker** moves its own task from open to working (by `next`) and from working to review (by `ready`, with evidence).
- **Only a verifier moves review to verified:** the reviewer, the tester, CI rules or a person. The worker never does.
- **Waiting** is a reason on a working task, not a state ("waiting: device-a at 15:00"). The worker takes its next task meanwhile, up to two in hand.
- **A proposal no one answers in 24 hours** closes with a note. "No answer means no" stays, but it's visible and has a time limit.

## 4. `next`, the pull
```
harness task next   →  1. my working task, if any (resume)
                       2. if all my own work is waiting downstream: the oldest PR waiting review
                       3. open tasks assigned to me, by order
                       4. unowned open tasks in my areas, by order
                       5. unowned open tasks my role may take
                       6. nothing: "list empty" goes to the lead's inbox and the swarm-health line, once
```
A worker never waits on a person to start its next task. The lead's job becomes keeping the backlog ordered and sized, not handing out work one message at a time.

## 5. Leases
- **`next` takes a 10-minute lease,** renewed by the daemon while the worker's harness is alive and turning. Liveness is the daemon's facts, not the agent's word: the same renew-before-expiry pattern `tabActivity.ts` already uses for working state across accounts.
- **The lease is lost** when the harness closes, its machine is offline for more than 5 minutes, or it's stopped by a usage limit for more than 10 minutes. The task goes back to open with a post saying why ("lease lost: fifth's machine offline 12:04").
- **Claim races** were rare in the pilot (4 of 85 tasks claimed twice). The lease is for liveness; compare-and-set handles races.

## 6. Routing: each event to whom it concerns
| Event | Goes to | How |
|---|---|---|
| Task assigned or reordered | Its worker | Inbox, delivered at the next tool call (Agent Messages' hook) |
| Post on a task | The task's worker, the lead, anyone named | Inbox |
| Ready for review | The reviewer pool, oldest first | Inbox; the review board |
| Changes asked, CI red | The task's worker | Inbox, wakes it if idle |
| Verified, done | The lead | FYI, never wakes anyone |
| List empty | The lead | Inbox, once per worker per hour |
| Decision asked | The person it names | YOU box; phone notice if they want it |
| Decision answered | The asker and the lead | Inbox |
| Lease lost | The lead | FYI, plus the task back in the backlog |

No worker reads a thread to find its work. `harness inbox` shows what's unread, and "new since your last read" is the default view.

## 7. Where it lives, and what it reuses
- **A service in the experimental host,** off by default and free when off ([the experimental host](../../design/2026-10-06-core-boundary-next.md)): a swarm adds no process to a machine that isn't in one.
- **The authority is the swarm owner's machine.** Members read and write through the shared-tabs relay: signed roster, sealed requests, a backend that stores but can't read. If the owner's machine is offline, members keep their leases for a grace period and see a read-only copy. Replication comes later.
- **Reused as they are:**
  - **Agent Messages** (`mailbox.ts`, `inbox.ts`): delivery at the next tool call, FYI, read marks.
  - **Shared tabs** (`roster.ts`, `sharedTabs.ts`): invitations, the signed roster, cross-account requests, read-only watching.
  - **`tabActivity.ts`:** working state across accounts, and its lease pattern.
  - **`usage.ts`:** each machine's Claude and Codex limits. The slice uses it only for the shared-gatekeeper warning.
  - **`harness new / ps / show / wait / close`** and the MCP server: workers are ordinary harnesses.
- **Retired by it:**
  - the GitHub-marker tasks (`messages/tasks.ts`);
  - the account-wide messaging switch;
  - Settings ▸ Tab invites;
  - the orchestrator experiment (a Director with specialists), whose job the swarm does. Retire it only once the slice is judged.

## 8. The Swarm tab, in the slice
- **The floor:** a desk per worker, a live terminal scaled to fit that never resizes the real one. ⌘⏎ zooms; typing goes only to your own workers. A desk's mark comes from its task state and its harness state, in priority order: `?` waiting on a person, `✗` CI red, `●` working, `◐` in review, `○` idle with an empty list.
- **The panel** (⌘⇧T):
  - YOU: decisions only in the slice; hands and try-it come later;
  - TASKS: one flat list;
  - PEOPLE: the roster and invitations.
- **The health line:** merges an hour against review capacity, PR wait, waiting PRs, empty-list wait, decisions waiting, and the shared-gatekeeper warning.

## 9. Recorded from the first day
Every state change with its time and actor. Every inbox item with delivered and read times. Every decision with asked and answered times. Exported as one file per swarm, so the [08](08-experiments.md) measures need no extra work.

## 10. How the slice is judged
On the owner's own swarms, for a week, against the pilot's baselines in §1. If a criterion fails, fix that part before adding anything from [06](06-harness-swarm.md).
