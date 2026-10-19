# The pilot: one owner, one lead and ~15 agents

2026-10-17. Measured from the pilot repository: 1,000 PRs (Jul 9 – Oct 17, 2026), 156 task issues, 3,240 CI runs (Oct 14–17), its coordination issue (1,500+ comments) and its process documents.

The pilot is an embedded consumer product with voice, motion, a camera and a light ring, tested on real devices. People aren't named: there's the owner, member people A–D, and outside teams. Builders go by their role names (first, second, … ten, reviewer, tests).

## 1. The setup

| Role | What it is |
|---|---|
| **Owner** | Sets direction, dates and priorities. Says yes to keys, spending, publishing, reboots, motion, anything irreversible. **Never posts on GitHub**: talks to the lead in chat and reads a local review page. Every owner word in the repo is a dated quote relayed by the lead. |
| **Lead** ("first builder") | A Claude Code session beside the integration device. It alone opens issues and assigns builders. It owns the integration branch and the queue, merges what the reviewer leaves it, runs hourly rounds and an idle watch, and plays the whole device every evening. |
| **Builders** | ~14 named agents (Claude Code and Codex) on the owner's and four member people's machines and accounts. Each has a role file: person, device, branches, the crates it owns, what it may and may not do. |
| **Reviewer** | A Codex agent added on day two. It reviews every ready PR, oldest first, within a 30-minute target, and merges what's off unless switched on, plus what's shown on the builder's own device. |
| **Tests** | A Codex agent that makes slow and flaky tests deterministic. It may not weaken an assertion. |
| **A person per builder** | Starts its sessions. "Needed only for hands", per the joining guide. In practice the person also gave permissions, voices, verdicts and knowledge (§6). |
| **Outside teams** | Hardware (facts, physical work), DevOps (CI and runners from day two), and the app and backend owners. |

**The loop:**
1. A person types `you are <name>`.
2. The agent reads the joining guide, its role file, the rules, its log and its device's owner file.
3. It claims the first open issue labelled with its name: add `status:taken`, comment, re-read in case of a race.
4. It builds in its own crates on `<name>/<task>` and runs the gate (format, lint, tests one thread at a time, the target-architecture CI run).
5. It hands back one PR per task into the integration branch, with a fixed write-up.
6. Questions are comments on the task's issue. Proposals are one comment headed `<name>-P<n>`, and no answer means no.
7. **Never idle:** before ending any turn, schedule a wake-up in 10–15 minutes.

## 2. How the process evolved in four days

| When | Change | Because |
|---|---|---|
| Oct 10–12 | Three agents coordinate by git, then tmux, then Harness Agent Messages | First rewrite attempts; "a queued message proves submission, not receipt" |
| Oct 13 | The owner collapses everything to **one builder** | Coordination cost between agents |
| Oct 14 | Reversed to **four sessions with a running list on GitHub** | The owner wanted throughput |
| Oct 14 | **Tasks as GitHub issues; one PR per task; `you are <name>`** | A member person's request. The 1,600-line work-split file every builder re-read each loop didn't scale. |
| Oct 15 | **Wide first, deep later**: all non-MVP work paused | Builders went deep while the whole product was incomplete |
| Oct 15 | **Never end a turn without a wake-up** | The owner found three builders idle |
| Oct 15 | **Reviewer and tests agents** | Every PR waited for the lead's review, device minute and merge |
| Oct 15 | CI only on PRs; a newer push cancels the older run | Every push had queued 11 runs behind 8 |
| Oct 15 | DevOps (people) takes CI and runners | |
| Oct 16 | **Only the lead opens issues** | A member person's request: builders filed unowned issues |
| Oct 16 | "Read the newest comments, not the first page" | A builder missed three tasks in the queue |
| Oct 16 | Peer reviews before own work | The owner counted 76 open PRs while the reviewer was out |
| Oct 16 | **Disk rules** | The lead's machine ran out of disk; an install failed half-way |
| Oct 17 | **Motors still until Monday** | An unattended test drifted the arm |
| Oct 17 | **Switch census:** 89 switches, 37 off; "build %" and "quality %" | The owner asked "why off?" |

**The pattern:** mechanics came from the agents and from one member person; speed and priority from the owner. Most changes answered an observed failure, and people noticed about half of them.

## 3. Throughput

| | Before (Sep 15 – Oct 13) | Swarm (Oct 15–17) |
|---|---|---|
| PRs opened per day | ~11 | ~177 (~165 merged) |
| Merged | 93% | 92% |
| Reverts | 0 | 0 |
| Median PR size | ~240 lines | ~240 lines |
| Median time to merge | 7 min | 1.5 h |
| Slowest 10% merge within | 3.1 h | 7.9 h |
| PRs that are review follow-ups | 2% | 18% |
| When | 08:00–19:00 on weekdays | every hour, every day (154 PRs on a Saturday) |
| Tasks opened per day | — | ~40 (82% by the lead); time to close p50 6.6 h |

Best day: 248 merged. About **half the merged work came from member accounts** (247 of the ~491 merged into the integration branch, Oct 14–17).

## 4. Where the gain came from
1. **Around the clock.** About 3.7× a person's working hours on its own.
2. **Parallel builders.** ~14, each opening about one PR an hour (median gap 0.4–1.5 h).
3. **No person in the dispatch loop.** The lead assigns, the builder claims, the reviewer merges.
4. **A fixed shape:** one task, one branch, one small PR.
5. **Several accounts and machines:** the members' agents kept working whenever the owner's account hit its usage limit.

## 5. Where it waited and what it cost
- **Gates:**
  - A median of 24 PRs waiting at any hour, up to 67. Mean time in review 3.1 h.
  - Merges ran at 6 an hour (median, up to 24), so the branch itself wasn't the limit.
  - CI ran ~630 target-architecture builds a day (~15 min each); **26% were cancelled** by newer pushes.
- **The lead, a single point of failure.** When it was out (usage limit, or waiting 03:14–06:40 for the owner), "nobody pushed". It made 373 comments in four days, 81 of them chasing silent builders.
- **The channel:**
  - The coordination issue took 1.03 M characters in four days.
  - One builder missed three tasks by reading only its first page; another missed a decision.
- **Usage limits.** The owner's account stopped the lead, the reviewer and a builder at the same time.
- **Rework:** 18% of PRs were review follow-ups.
- **Switches:** PRs named 96 new ones in four days; the census on the last day found 89, with 37 still off.
- **Unread volume:** 846k changed lines merged on the best day, partly generated or vendored.
- **Resources:** see [04](04-bottlenecks.md).

## 6. What people contributed

Importance runs from 1 (nice to have) to 5 (the project would be on a different course without it).

**What the owner could supply alone:**

| Contribution | Evidence | Importance |
|---|---|---|
| Direction, vision, dates | "make it the most fun creature to interact with"; "use all the sensors … don't limit it"; "ship by Black Friday". Without these the agents optimized voice latency, their own default. | 5 |
| Priorities and saying no | "attack the easy components first", "wide first, deep later", no old-version benchmark, one language for now, the touch strip off. Agents don't say no to themselves: every builder pulls more work. | 4–5 |
| Catching blind spots | "Why wasn't the bus first?" "Did you build ALL the components?" (about ten were missing). "Why off?" (37 switches). Three builders idle. 76 open PRs. "Why Monday? Why not now?" | 5 |
| Risk calls | The signing key held back; the trained model not published ("publishing can't be undone"); motors still; the disk rules | 4 |

**What needed other people:**

| Contribution | Evidence | Importance |
|---|---|---|
| **Real-world testing** | Two hours of the owner at the device found ~7 faults the played tests missed: answering without seeing the page, deaf after face/name flips, short requests dropped as "not speech", a 93–94 °C crash, a light the log called done that never came on. A one-hour hardware-team visit found accented English transcribed in the wrong script, a working stop button the agents' notes said didn't exist, an I2C bus four times too fast, and a speaker that came back 8 dB louder after a USB drop. | 5 |
| **Knowledge outside the model** | The hardware team: the voice microphone has **no speaker reference and an unsynchronized clock**, the root cause of the echo and stop-word failures agents had chased in software since day one ("stop" at 0 of 4 after 136 comments). Also: servos should let go under overload, the touch strip is unreliable, there's no clock battery. | 5 |
| **Process design** | A member person who had run agents on the previous product asked for tasks-as-issues and lead-only issues: the structure that let the swarm grow from 4 to 15. | 5 |
| **Business facts** | "The voice key belongs to the user" reversed a lead decision that would have shipped devices with Wi-Fi and no voice. "Old devices are set up with the mobile app": three days of agent study had missed it. | 4–5 |
| **Physical work and safety** | Weighing (3.0 kg and 2.686 kg against the agents' 1.5 kg model and the spec's 7 kg), five power cuts with a hand on the device, folding the arm, sensor swaps, sudo passwords | 4 |
| **Taste** | A member's verdicts on each motion clip; "alive, not a machine" kept for people | 4 |
| **Access** | ssh, sudo, sign-ins, private repos, a quota raised after a device's voice was dead ~7 h | 3 |
| **Capacity** | Members' accounts and machines; four more devices, each with a person beside it | 4, partly the owner's |

**When nobody was there, work stopped:** the lead blocked for 3.4 h overnight; signed updates waiting for the key; setup waiting for a decision; weekend tests moved because nobody was at two devices; builders paused when their person went home.

## 7. Failure modes, and who caught them

| Failure | Caught by |
|---|---|
| **Merged ≠ on ≠ working:** progress counted features that ran nowhere | the owner ("why off?") |
| **Passing tests, wrong behaviour:** a light "done" that never lit; ~33 PRs with a test that could not fail | the reviewer and peers (tests); the owner's session (behaviour) |
| **Synthetic tests vs real people:** accents, short requests, faces, room noise; the synthetic wake word wasn't even detected | the owner, the hardware team, member people |
| **Chasing a hardware limit in software** | the hardware team |
| **Wrong lead decisions** (factory key, setup path) | a member person, the owner |
| **A lossy channel:** missed tasks and decisions | builders themselves; the read instruction was patched, the channel wasn't |
| **Idle agents, review backlog** | the owner first, then the idle watch and the reviewer |
| **Integration breaks from parallel merges:** a duplicated helper turned every run red | builders, within hours |
| **Duplicate work** | the reviewer, the lead |
| **Unsafe unattended motion** | the lead (webcam), the owner ("motors still") |
| **Names and IP near a public repo** | the lead, the reviewer, a member's builder, the owner |
| **Optimistic self-measurement:** 7 wrong and 12 unsourced of 62 claims in the lead's summary | another member's builder, fact-checking |

**Summary:** agents reliably catch code-level faults: flaky and impossible tests, compile breaks, duplicates, confounded experiments, wrong numbers. People catch the rest: wrong product assumptions, features left off, behaviour with real voices and faces, hardware root causes, physical safety, privacy and IP, resource exhaustion, and agents sitting idle.
