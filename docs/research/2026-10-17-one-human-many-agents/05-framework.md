# The framework: how one person and a swarm build software

2026-10-17. The operating model any project can adopt. It generalizes the pilot ([01](01-pilot-evidence.md)), checks it against how others build ([02](02-how-others-build.md)), and designs against the bottlenecks ([04](04-bottlenecks.md)). Harness's job is to make it built-in ([06](06-harness-swarm.md)).

## The shape

```
                     OWNER  (wants · decides · judges · answers for it · programs the factory)
                       │  brief · decisions · try-it
                       ▼
                     LEAD   (plans · orders the backlog · integrates · reports · escalates with a recommendation)
          ┌────────────┼──────────────┬───────────────┐
       builders     reviewer        tester        researcher      … named workers, each owning an area
          │            │              │               │
          └── tasks · threads · PRs · evidence ─── gates ──▶ one merge lane ──▶ on, behind a switch ──▶ shown working
                       │
   PEOPLE AROUND IT: domain owners · experts · testers · hands   (each for what they bring, never for capacity alone)
```

**Hierarchy, not peers.** Every serious report finds flat peer swarms fail (17× error amplification without a coordinator; 20 agents at the throughput of 2–3 on shared locks). The lead decides; workers each own an area; one lane merges.

## 1. The brief: intent written down once
The most important artifact. Every decision the lead makes without asking comes from it.

| Part | Example |
|---|---|
| **Goal** | Ship V2 to homes by 27 November. |
| **The bar** | A person can talk naturally, interrupt it, and it gives way to a hand. |
| **Priorities** | Wide first, deep later. Must-haves before anything else. |
| **Taste** | It must read as a living thing, not a machine. |
| **Facts the models can't know** | "The microphone gets no speaker reference." "The voice key belongs to the user." "Old devices are set up with the mobile app." |
| **Constraints** | Nothing ships unsigned. No motion without a person present. No names in the public repo. |
| **Budget** | $300 a day; heavy builds at night. |
| **Autonomy** | Level 3: I decide what the lead escalates. |
| **Rules** | This repo's AGENTS.md and joining guide. |

The **facts the models can't know** section is new. In the pilot it would have saved days: agents chased an echo problem in software that was a hardware fact in someone's head, and the lead made a decision that only a business fact could correct. Ask every person who joins for theirs, on day one.

## 2. Roles

**Owner** (one person): writes the brief, decides what the lead escalates, tries the result, answers for it, and **programs the factory**: rules, oracles, hidden scenarios, the playbook. Everywhere agents write most of the code, this last job is what people do more of.

**Lead** (one agent per swarm, or per domain):
- plans tasks with a bar for done, each about an hour of work. The 80% reliability horizon is ~1–3 h, so bigger tasks get split.
- keeps the backlog ordered, sized and three deep for every area, so workers pull their next task without waiting for it. In the pilot, builders waiting for the lead lost the most hours ([04](04-bottlenecks.md)), though review set the output ([14](14-which-gate.md));
- checks that the work decomposes before parallelizing it (16 agents on one kernel bug is one agent's work).
- integrates: merge order, conflicts, a green integration branch;
- runs the whole product end to end every evening;
- reports to the owner: what changed, what's **on**, what to try, what needs a decision;
- escalates with options, a recommendation and evidence, never with an open question.

The lead is a single point of failure, so its state lives outside it (§7), its claims are checked by another agent (the pilot's lead got 7 of 62 claims wrong in one summary), and it's restarted fresh periodically to avoid drift. **It never blocks:** a question to the owner becomes a packet and the lead carries on (the pilot lost 3.4 hours of dispatch to one question). A deputy takes its queue if it stops. The lead and the reviewer run on different subscriptions, so one usage limit can't stop both.

**Workers** (named agents). Each has a name, a role, a home (machine, folder, subscription, permission mode), an **area it owns** (crates, folders), and a log:
- **builder:** takes a task, delivers a PR with evidence;
- **reviewer:** clean context, ideally a different model from the builder (models rate their own patches as more correct). Reviews every PR within a time bar and merges what the rules allow.
- **tester:** owns test speed, flakiness, the end-to-end runs and the device schedule. It may never weaken an assertion.
- **researcher:** answers "how do the best do X" before builders start;
- **gardener:** removes duplicates, retires switches, refactors. Scheduled, never optional.

**People around it** (optional, see [03 §5](03-first-principles.md)): domain owners (judgment bandwidth), experts (knowledge outside the model), testers (reality), hands (the physical world).

## 3. The unit of work: the task

| Field | Why |
|---|---|
| **Title and bar** | What done means, machine-checkable where possible |
| **Owner, by lease** | One worker at a time. The lease renews while the worker's session is alive and expires if it stops, so stalled work returns to the backlog without anyone noticing by hand. |
| **State** | proposed → open → working → **verified** → on → done. Only a verifier (reviewer, tester, CI, the owner) moves a task past *working*, never its own worker. |
| **Order** | Its place in its owner's list; the lead sets it |
| **Waiting on** | A person, a device, a key, another task |
| **Evidence** | PR, measurements, recordings, the write-up: what changed, how it was verified, risks, deviations, findings |
| **Thread** | The conversation and the record of why |

Rules that made the pilot fast, and fixes for what hurt it:
- **One task, one branch, small PRs.** A task may need several PRs; follow-ups are new tasks.
- **Claims are instant and idempotent.** No label races.
- **Duplicates are checked before a task is opened** (23% of rejected agent PRs are duplicates).
- **Questions go on the task to the lead,** never to a worker's person.
- **Proposals are tasks in the proposed state.** No answer means not taken up.
- **A decision is its own object:** options, recommendation, answer, date. Repeated decisions become playbook rules.

## 4. The flow and the verification ladder

```
brief ─▶ lead plans ─▶ task ─▶ worker leases it ─▶ builds in its own worktree ─▶ PR + write-up
                                                                                  │
   shown working ◀── switched on ◀── owner/device check ◀── merged (switch off) ◀── gates
         │
         └─▶ release train ─▶ users ─▶ observations ─▶ brief
```

**Merge behind a switch, turn it on after it's shown to work.** Merging behind a switch is what keeps a swarm fast. But the pilot found **merged is not on, and on is not working**: 89 switches, 37 still off, and work counted as done that ran nowhere. So:
- **Progress** counts only what is **on and shown working with a person or on a device**.
- **Every switch is a task** until it's on for everyone or removed.

**The verification ladder.** Each change climbs as high as its risk requires; the route is chosen by path:

| Rung | Who | Required for |
|---|---|---|
| 1. Fast local checks, a sampled test mode | the worker | every change |
| 2. CI on the target platform; capped at two red rounds, then back to the lead | machines | every change |
| 3. Review with a clean context, on a different model | reviewer | every change, within a time bar |
| 4. Hidden scenarios the worker never saw; read-only tests | tester, machines | behaviour changes |
| 5. Real environment: device, staging, field | tester or lead | anything users feel |
| 6. A person tries it | owner, domain owner, testers | experience, taste, safety |
| 7. Real users | people | before release |

**Paths decide the route.** Security, money, cryptography, public interfaces, safety and anything irreversible always reach a person. Docs and tests can merge on rungs 1–3.

## 5. Keeping everyone busy, without burning anything
- **A worker is never idle while the backlog has work.** At turn end it gets its next step; with all its own work waiting downstream it reviews the oldest PR in the queue; with an empty list it pulls the oldest unowned task in its area; only when there is none does the lead hear. (In the pilot, builders posted 64 "list empty" reports and the lead wrote 81 comments chasing silent ones.)
- **Assignments and messages are delivered, never polled.** No reading a 1 M-character thread to find your task.
- **A dead worker's leases expire** (machine offline, subscription limit), and its tasks go back to the backlog.
- **Pace never overrides safety.** "Test 24/7" and "never idle" in the pilot produced unattended motion and a full disk. Anything physical, irreversible or shared needs its owner's rule, not the swarm's clock.
- **Throttle creation to what can be verified.** More PRs than the gates can check is waste: 24 waiting, a quarter of CI cancelled.

## 6. Scaling past one lead
- **Offload the lead first:** reviewer, tester, gardener. The pilot added a reviewer on day two, because every PR waited for the lead.
- **Widen the narrowest gate, not the builder count.** CI saturates near runners ÷ 0.58 builders, one reviewer near 15 builders, one lead near 15 ([04 §3](04-bottlenecks.md)). Past the narrowest, more builders only lengthen the queue.
- **Choose autonomy by oracle class** ([03 §6½](03-first-principles.md)): work with a machine oracle runs at level 4; work whose oracle is reality or a person runs at the pace reality can be sampled, whatever the worker count.
- **Split by domain at ~10–15 workers,** each sub-swarm with a lead and ideally a human domain owner. Leads coordinate through the shared brief and explicit interfaces.
- **Areas, not files.** Each worker owns an area; a conflict is a sign the areas need redrawing.
- **Watch the direction changes.** Each owner redirect moved 10+ builders within the hour. Direction changes are decisions too, recorded and costed ("this pauses 6 tasks").

## 7. Memory: the factory remembers, not the agent
Agents forget, get compacted, restart; a fresh context per task resists drift but misses connections. So everything lives outside any context:
- **the playbook:** AGENTS.md as a short map, directory-scoped rules, the joining guide;
- **the brief and decisions;**
- **observations** ("What the device showed");
- **per-worker logs and structured handoffs:** what was done, concerns, deviations, findings;
- **tasks and threads.**

Every recurring agent mistake becomes a rule or a check. **Constraints beat instructions:** types, linters and structural tests are followed; prose is interpreted.

## 8. Resources are planned, not discovered
See [04](04-bottlenecks.md). Each worker has a budget of compute, disk, model capacity and CI. Heavy jobs wait for slots. Devices are booked. Several accounts and providers keep the swarm alive through any single limit. The pilot found every limit by hitting it.

## 9. What to measure

| Metric | Why | Pilot (Oct 15–17) |
|---|---|---|
| **Shown working per day** (changes on and verified with a person or device) | real progress | not measured; build % counted merges |
| Merged per day | throughput | ~165 |
| PR wait (opened → merged) | gate capacity | p50 1.5 h, p90 7.9 h |
| Work waiting (open PRs) | queue health | p50 24, max 67 |
| Rework share | first-attempt quality | 18% |
| **Escaped defects** (found after merge by people or users) | the real quality signal | not measured |
| **Decision latency** | owner bandwidth | e.g. 3.4 h overnight |
| **Human minutes per surviving change** | the attention budget | not measured |
| Idle worker-hours | liveness | found by hand |
| Cost per surviving change | economics | not measured |
| Switches on vs off | entropy | 89 total, 37 off |

## 10. Safety and trust
- Least privilege. Each worker runs in its home's permission mode, in its own folder, with scoped credentials and no production secrets in its workspace.
- No teammate, the lead included, can make a worker publish, deploy, delete or push to the default branch because it asked.
- Destructive or irreversible steps are owner decisions.
- Secrets never travel in messages or tasks.
- Every action is attributable: which worker, whose machine, which task.
- **A teammate's claim is a thing to check:** another agent's word is evidence, not truth.
