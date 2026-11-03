# Harness product direction

Where Harness is going, why, and the bar it must meet. Written 2026-11-03. It replaces the
[September thesis](docs/product-direction.md), [what we're building](docs/strategy/2026-09-26-what-we-are-building.md) and
the audience in [who we're building for](docs/ideal-users.md).

This document leads; the code follows. Where the product today falls short of it, that is work to do, not a reason to
change the direction. The project's Product Manager owns the product by this document: every request is weighed against
it, and every "no" or "later" names the section it rests on. Who decides what, and how this document changes, is in
the project's Instructions.

**Milestone: December 31, 2026.** Every target below is due then.

## What Harness is

**Harness runs a crew of agents from every lab, on the machines you own, directed by a Product Manager agent, with
work verified before it ships.**

- **A person says what they want; the crew delivers verified work.** The Product Manager turns accepted requests into
  tasks. Engineers build, Reviewers and Testers check, and the result is a merged change that works.
- **People give direction, taste and acceptance, from anywhere.** They answer questions and approve results at the desk,
  in the browser, on the phone or on the Harness device. Agents do the execution.
- **Agents are the labs' real CLIs** (Claude Code, Codex, OpenCode and the rest) under each person's own login, so a
  lab's new feature works in Harness the day it ships.
- **Capacity is one pool**: every person's machines and subscriptions in a Swarm, used before anyone waits.

## Who it is for

In this order:

1. **The Swarm owner.** One person running 5–50 agents on two or more machines: a founder, a staff engineer.
   Customer zero is Harness itself: the openharness project and Autonomous's other Swarms ship through Harness every
   day. A wall they hit is the most trustworthy backlog item we have.
2. **The people the owner invites.** A domain expert, a tester, someone lending a machine or a device. Inviting a
   second person is how a Swarm spreads, and the moment it becomes worth paying for.
3. **The company.** Several owners, many Swarms, shared capacity, roles, audit and budgets.

The [voice and wording rules](docs/ideal-users.md#the-identity-how-we-use-the-word-polymath) for describing these
people still apply.

## Why we can win

Every lab now gives away a lead-plus-workers swarm inside its own subscription, for its own agents. Slack, GitHub and
Linear own human team chat and the system of record. Harness owns what they structurally will not:

- **Every vendor at once**, in one crew (a Claude Engineer reviewed by a Codex Reviewer).
- **The customer's own machines and devices**, and their subscriptions, as one pool of capacity.
- **Verification before work reaches GitHub**: independent review, and tests on real machines and real devices.
- **Work across accounts**: people and machines from different accounts in one Swarm, safely.

If a lab or GitHub ships real cross-vendor capacity and verification, this position shrinks. Watch for it.

## What we are not doing

A request that falls here gets "no" or "later", with this section named.

- **Our own agent or model.** The labs out-build us every month. We run theirs.
- **What a single lab already gives away** for its own agents, unless ours works across vendors, machines or accounts.
- **Chat for people talking to people.** The project chat is where people direct agents. A chat feature belongs only
  when it changes what agents do or how quickly people answer them (editing a request that became a task does; emoji
  reactions do not). Work is reported outward to GitHub, and later Linear or Slack.
- **Beyond code, for now.** CAD, music, games, new viewers and a growing Store catalog are paused. What exists keeps
  working; it is not extended.
- **Anything that settles what is not decided yet:** pricing, capacity we host for customers, encrypting Swarm chat and
  files end to end, the Autonomous Computer as a product, the next integration after GitHub, and the name "Swarm".
  Work does not build toward one answer until this document gives it.
- **New surfaces or hardware form factors.** The phone, the Harness device and the Autonomous Computer serve the Swarm:
  answering agents, seeing status, running agents. The terminal interface is maintenance only. Windows is supported;
  Windows-only work is done when a named person in a Swarm is blocked by it.

### Anti-goals: failures even when the feature works

- More agents and more pull requests, while people spend more attention or quality drops.
- Something shipped that our own Swarms do not use.
- Locking a customer to one lab, or to our servers, for their agents' execution.
- The server silently changing or hiding a customer's data.

## Bets until December

| Bet | The state we want by December 31 | How we know |
| --- | --- | --- |
| Customer zero runs on Swarm | openharness and Autonomous's Swarms do all their work through Harness, and their walls are gone | Verified tasks shipped rise while people's attention per task falls |
| An outside company | A company outside Autonomous owns a Swarm and ships work every week, set up without our hands on their machines | At least one such Swarm |
| The second person | Inviting an expert, a tester or a machine lender takes a minute and is useful in their first hour | Share of active Swarms with two or more people grows |
| Verification is the moat | Problems are caught before merge, not after | Fixes after merge stay under target |
| One pool of capacity | No work waits for capacity while any machine or subscription in the Swarm has some left | Work waiting for capacity, cost per shipped task |

## Priority order

When two pieces of work compete, the higher one goes first:

1. Production down, or a security problem.
2. Data loss; a broken Swarm loop (work that cannot reach an agent, be reviewed, merge or ship); a missed tech target
   that got worse.
3. A wall our own Swarms hit today.
4. What the outside company needs by December.
5. The second-person loop.
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
| People's decisions per shipped task | ≤ 0.5 | Most tasks should need no one |
| Time a question waits for a person, in working hours | Median ≤ 15 min | Why the phone and the device exist |
| Cost per shipped task | Lower each month | Work must cost less than it is worth |
| Tasks with no progress for 30 minutes, unnoticed | 0 | Work must never stop silently |
| Outside Swarms shipping every week | ≥ 1 | The milestone |
| Weekly active Swarms with two or more people | Growing every week | The way a Swarm spreads |

A Swarm is active in a week when it ships at least one verified task; a one-person Swarm counts. A person is active when
they post, answer a decision, or lend a machine that ran work.

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

How the work meets them:

- **A missed target that got worse is a regression**, priority 2 above any new feature.
- **Optimizations need numbers:** profile first, change, then before and after on the same workload. A claimed win
  with no measurement does not merge.
- **Every feature that stores, syncs or exposes data** answers the [feature design rules](docs/feature-design-rules.md)
  before it is built.

## Tech choices

Chosen on purpose; changing one is a change to this document.

- **One Flutter codebase for every screen**: desktop, web and phone. A screen is built once.
- **TypeScript for the backend and the daemon.** One language across the server, the daemon and the tools agents use.
- **Rust only on the terminal's hot path** (terminal interface, PTY), where latency and memory matter most.
- **Run the labs' real CLIs under the person's own login.** Never wrap a lab's API to imitate its CLI, and never run one
  person's work under another person's login.
- **Execution outlives views.** The daemon that owns the work is the truth; every client can disconnect and rebuild.
- **The daemon's core stays small.** Features live in services around it.
- **Terminal traffic is end-to-end encrypted, with no switch.**
- **The backend speaks a change before clients use it, and older clients keep working.**
- **No new language, framework, datastore or hosted service** unless this document adds it.
- Names follow the [Naming System](docs/naming-system.md); validation and release follow
  [validation and release](docs/validation-and-release.md).
