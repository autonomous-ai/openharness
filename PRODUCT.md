# Harness product direction

Where Harness is going, why, and the bar it must meet. Written 2026-11-03. It replaces the
[September thesis](docs/product-direction.md), [what we're building](docs/strategy/2026-09-26-what-we-are-building.md) and
the audience in [who we're building for](docs/ideal-users.md).

It describes the product we are heading for, not the product as it is today. How code meets its targets is in
[ENGINEERING.md](ENGINEERING.md).

**Milestone: December 31, 2026.** Every target below is due then.

## What Harness is

**A Swarm pools the machines and subscriptions its people bring, and its Product Manager agent directs a crew of
agents from every lab on them, with work verified before it ships.**

- **A person says what they want; the crew delivers verified work.** A crew of agents led by a Product Manager agent
  builds and checks it, and delivers a merged change that works.
- **People give direction, taste and acceptance, from anywhere.** They answer questions and approve results at the desk,
  in the browser, on the phone or on the Harness device. Agents do the execution.
- **Agents are the labs' real CLIs** (Claude Code, Codex, OpenCode and the rest) under each person's own login, so a
  lab's new feature works in Harness the day it ships.
- **People bring the capacity; the Product Manager decides what it builds.** Everyone in a Swarm can bring a machine
  or a subscription, and it joins one pool used before anyone waits.

**The bet.** AI coding is no longer limited by models. It is limited by people's attention and by paid capacity sitting
idle: teams pay for Claude and Codex plans they use a fraction of, and every extra agent adds work a person must check.
Harness turns a team's existing subscriptions and machines into a crew that ships verified work around the clock with
almost no one's attention.

## Who it is for

In this order:

1. **The Swarm owner.** One person running 5–50 agents on two or more machines: a founder, a staff engineer. The first
   market is AI-native software teams of 2–20 engineers already paying for three or more Claude or Codex plans.
   Customer zero is Harness itself: the openharness project and Autonomous's other Swarms ship through Harness every
   day. A wall they hit is the most trustworthy backlog item we have.
2. **Contributors.** People who bring a machine or a subscription into a Swarm: a teammate's idle Mac, a GPU box, a
   Claude or Codex subscription with room to spare. Every contributor makes the Swarm stronger, and contributing is how
   a Swarm spreads and the moment it becomes worth paying for.
3. **The company.** Several owners, many Swarms, shared capacity, roles, audit and budgets.

The [voice and wording rules](docs/ideal-users.md#the-identity-how-we-use-the-word-polymath) for describing these
people still apply.

## Contribution

What people contribute to a Swarm is capacity:

- **Machines**: computers, the devices plugged into them for testing, GPUs.
- **Subscriptions**: Claude, Codex and the other labs' plans, shared through a Team account.

Contributing has four properties:

- **Easy.** A machine or a subscription is working for the Swarm within 5 minutes, started from the phone if need be.
- **Safe.** The contributor's files, secrets and accounts are never exposed. Their own work comes first; they set the
  limits and take it back at any time.
- **Seen.** The contributor sees what their capacity shipped, and gets credit for it. Their quota is never drained
  without them knowing.
- **Used.** Contributed capacity never sits idle while work waits.

## Why we can win

Every lab now gives away a lead-plus-workers swarm inside its own subscription, for its own agents. Slack, GitHub and
Linear own human team chat and the system of record. Harness owns what they structurally will not:

- **Every vendor at once**, in one crew (a Claude Engineer reviewed by a Codex Reviewer).
- **The plans people already pay for.** Agents run on the team's own subscriptions, where hosted agents bill per task
  or per compute minute: the same work at a fraction of the price.
- **The customer's own machines and devices**, and their subscriptions, as one pool of capacity.
- **Verification before work reaches GitHub**: independent review, and tests on real machines and real devices.
- **Work across accounts**: people and machines from different accounts in one Swarm, safely.

If a lab or GitHub ships real cross-vendor capacity and verification, this position shrinks. Watch for it.

## What we are not doing

- **Our own agent or model.** The labs out-build us every month. We run theirs.
- **What a single lab already gives away** for its own agents, unless ours works across vendors, machines or accounts.
- **Chat for people talking to people.** The project chat is where people direct agents. A chat feature belongs only
  when it changes what agents do or how quickly people answer them (editing a request that became a task does; emoji
  reactions do not). Work is reported outward to GitHub, and later Linear or Slack.
- **Beyond code, for now.** CAD, music, games, new viewers and a growing Store catalog are paused. What exists keeps
  working; it is not extended.
- **New surfaces or hardware form factors.** The phone, the Harness device and the Autonomous Computer serve the Swarm:
  answering agents, seeing status, running agents. The terminal interface is maintenance only. Windows is supported;
  Windows-only work is for people it blocks.

### Anti-goals: failures even when the feature works

- More agents and more pull requests, while people spend more attention or quality drops.
- Something shipped that our own Swarms do not use.
- Locking a customer to one lab, or to our servers, for their agents' execution.
- The server silently changing or hiding a customer's data.
- A contributor's own work slowed, or their quota drained, without them knowing; a contributor's data exposed.
- Contributed capacity sitting idle while work waits.

## Bets until December

| Bet | The state we want by December 31 | How we know |
| --- | --- | --- |
| Customer zero runs on Swarm | openharness and Autonomous's Swarms do all their work through Harness, and their walls are gone | Verified tasks shipped rise while people's attention per task falls |
| An outside company | Three named design partners onboarded by December 1; one ships work every week, set up without our hands on their machines | Three onboarded by December 1; at least one shipping weekly |
| Contribution | Bringing a machine or a subscription into a Swarm is easy, safe, seen and used, and people keep doing it | The contribution targets below |
| Verification is the moat | Problems are caught before merge, not after | Fixes after merge stay under target |
| One pool of capacity | No work waits for capacity while any machine or subscription in the Swarm has some left | Work waiting for capacity, cost per shipped task |

## What matters most

In order:

1. Production down, or a security problem.
2. Data loss; a broken Swarm loop (work that cannot reach an agent, be reviewed, merge or ship); a missed tech target
   that got worse.
3. A wall our own Swarms hit today.
4. What the outside company needs by December.
5. Contribution: bringing machines and subscriptions into a Swarm.
6. Polish of other surfaces.

## Product targets

Measured weekly, split three ways: the openharness project, Autonomous's other Swarms, and outside Swarms. A Swarm is
outside when its owner is neither an Autonomous account nor a member of any Autonomous Swarm. Team, tester and test
accounts never count as a customer's.

**North star: verified tasks shipped per week.** A task counts when its change is merged, every review passed (and every
test, where the task had one), and no revert or fix of it lands within 7 days. It should rise every month.

| Measure | Target by December 31, 2026 | Why |
| --- | --- | --- |
| Shipped tasks reverted or fixed within 7 days | ≤ 5% | Speed must not cost quality |
| Request to merged, in working hours | Median ≤ 2 h | Waiting, not building, is what makes work slow |
| Verified tasks shipped per person-hour of attention | Rising every week, published weekly from our own Swarm | The bet in one number |
| Changes people see that an agent ran for real before merge | ≥ 95% | Verification is the moat only if it runs |
| Work on capacity that dropped (a machine offline, an account that stopped answering) moved and running again | ≤ 5 min, nothing lost | Contributed capacity comes and goes |
| People's decisions per shipped task | ≤ 0.5 | Most tasks should need no one |
| Time a question waits for a person, in working hours | Median ≤ 15 min | Why the phone and the device exist |
| Cost per shipped task | Lower each month | Work must cost less than it is worth |
| Tasks with no progress for 30 minutes, unnoticed | 0 | Work must never stop silently |
| Outside Swarms shipping every week | ≥ 1 | The milestone |
| Contributors per week, in each Swarm with two or more people | ≥ 3 | A Swarm grows by what its people bring |
| Work run on capacity someone other than the owner brought | ≥ 50% | The pool, not the owner, carries the work |
| From starting to contribute to the first work run on it | ≤ 5 min | Contributing is easy |
| Contributors this week still contributing next week | ≥ 80% | Contributing is worth it |
| Contributed capacity idle while work waits | 0 | Contributing is used |

A Swarm is active in a week when it ships at least one verified task; a one-person Swarm counts. A contributor in a
week is a person whose machine or subscription ran work in that Swarm that week.

## Tech targets

The system is designed for **10x the December scale**. Each target is a bar for the current release, measured fresh;
numbers in older documents describe the build they measured.

| Area | Target | Why |
| --- | --- | --- |
| Swarm messages | Posted to received by the agent: p95 ≤ 1 s. A person's answer from the phone reaches the agent in ≤ 2 s | The crew feels live |
| Reads | Every read returns only what changed since the reader's last read; nothing polls whole state | Cost grows with change, not with size |
| Storage | Everything stored has something that deletes it, and a stated limit per Swarm | Growth never surprises us |
| Database | Hot-path queries p95 ≤ 100 ms; none scans a collection | The backend stays cheap at 10x |
| Backend cost | Cost per active Swarm falls as Swarms grow | Scale must improve unit cost |
| Desktop at rest | With 16 terminals: ≤ 1% of one core, ≤ 500 MB | Harness runs all day beside the work |
| Daemon at rest | ≤ 1% of one core | It runs on every machine all day |
| Remote terminal | Echo over a direct connection p95 ≤ 50 ms | Typing on another machine feels local |
| Failures | Nothing fails silently: every failed delivery, launch or sync is visible to someone who can act | Trust |
| CI | `ci/required` ≤ 15 min | The crew is never waiting on CI |
| Headroom | Every resource stays at least 10x below its limit; less than that triggers a design review | Rule 2 of the feature design rules |

## Tech stack

- **One Flutter codebase for every screen**: desktop, web and phone, so a screen is built once.
- **TypeScript for the backend and the daemon**: one language across the server, the daemon and the tools agents use.
- **Rust on the terminal's hot path** (terminal interface, PTY), where latency and memory matter most.
- **The labs' real CLIs, under each person's own login**, so a lab's new feature works the day it ships.

## Not decided yet

Pricing; capacity we host for customers; whether Swarm chat and files are end-to-end encrypted; the Autonomous Computer
as a product; the next integration after GitHub; the name "Swarm".
