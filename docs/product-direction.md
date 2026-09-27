# Harness: product thesis and roadmap

Working product thesis, September 27, 2026. This records the framing developed with the
founder and the product bet it suggests. Roadmap stages remain proposals for the order of
learning and investment. See the [system diagram and ownership boundaries](architecture.md).

The starting point is the founder's existing daily use: building Harness's desktop, TUI,
mobile app, and device while doing market research, product planning, and X-post writing in
agent sessions. That ongoing body of work is the first reference experience for this roadmap.

## The thesis

**Harness is becoming the environment through which a person directs an entire endeavor.**

The founder is already using Harness to build Harness. Software engineering, hardware,
experience design, research, and communication happen in different sessions under one
person's direction. These are connected parts of building and bringing one product to users.

The person supplies direction, taste, priorities, and acceptance standards. Agents supply
execution across disciplines. Desktop, terminal, phone, and device are places where the person
enters that work: to direct it, inspect it, answer a question, or make something themselves.

The ambitious product promise is: **one person can direct work at the scope of an organization,
while staying close to what is being made.**

For the founder, that endeavor is Harness. The larger bet is making this way of working
accessible to people building their own products, studios, research efforts, or businesses.
The founder's use demonstrates the behavior; the scale of the opportunity remains a bet.

The initial audience remains the [curious technical builder](ideal-users.md): someone already
using agents, responsible for an outcome, and willing to work across disciplines. Start with
one person, one project, and one machine. Additional agents, machines, and interfaces should
become useful as their work grows.

## The coordination opportunity

The breadth of agent capability is already showing up in the founder's day. The opportunity
is to make that breadth coherent and sustainable as the work grows.

Today, the person carries important connections between sessions:

- Which firmware results are ready to talk about publicly.
- Which product decisions should apply across desktop, TUI, and mobile.
- Which work is finished, blocked, superseded, or worth revisiting.
- Where the relevant conversation lives.
- What each agent needs to know about what happened elsewhere.

Harness can make these relationships explicit and useful. A firmware result becomes input to
communication. A product decision has consequences for several interfaces. A release depends
on work spread across sessions. Each connection should lead back to the relevant work,
decision, or evidence so the person can inspect and correct it.

The core design principle is: **preserve the attention that creates value; reduce the attention
spent reconstructing or transporting context.**

Direction, taste, priorities, and quality judgment deserve the person's attention. Repeatedly
finding a conversation, explaining an accepted decision, checking whether a draft uses current
facts, and reconciling conflicting versions are opportunities for the environment to help.
Which responsibilities to delegate remains a choice the person can make and revise.

That gives the roadmap a concrete starting point: observe the coordination the founder performs
every day, preserve their direct access to the work, and make the repeated connections dependable.

## What the user is buying

The core value is **more useful work completed per hour of human attention**. Three benefits
make that concrete:

| Benefit | What the person experiences |
| --- | --- |
| Capacity | Work advances while they focus elsewhere; several activities can progress within a defined budget. |
| Capability | Domain tools and review surfaces let them complete work they previously could not confidently do. |
| Continuity | Their brief, materials, decisions, and results remain coherent across sessions, devices, and revisions. |

The important experience is a loop: describe, build, inspect, decide, revise, use. Terminals,
models, and remote connections support that loop. A finished artifact must survive outside
Harness in a usable form, along with the editable source where the domain supports it.

The [earlier product reset](../work/SUPERPOWERS.md) sets a useful bar: real briefs, meaningful
revisions that preserve approved choices, and exports checked by independent readers.
Interface polish and a convincing demonstration are insufficient evidence of that value.

## The reference experience is already happening

A read-only inspection of local session metadata and selected user turns on September 27
found the following examples. This is a sample of the founder's work; session titles identify
topics and do not by themselves establish that a task succeeded.

| Workstream | Observed session examples |
| --- | --- |
| Desktop product and interaction | "Add Harness activity manager"; "Command palette search results" |
| Mobile | "Mobile app build and deploy" |
| Physical device | "Deploy latest firmware" |
| Positioning and communication | "Review repo and plan marketing"; "Draft X post about harness" |
| Keeping work accessible | "Find harness marketing session"; "Restore lost panes and tabs" |

The founder also identifies TUI development and market research as current workstreams.
Selected turns show concrete links between these activities: the X-post session develops
messaging about firmware responsiveness, while the firmware session concerns the physical
device's interaction with the app. The desktop manager work concerns returning to ongoing
sessions. A separate session asks why the marketing conversation cannot be found in search.

These observations suggest a bottleneck worth investigating: the person carries context,
priorities, quality judgment, and connections between workstreams. We should measure which of
those responsibilities benefit from assistance and which they prefer to perform directly.

An immediate reference journey can use this existing work:

1. Find the firmware work, its measured results, and the related communication session from
   the intention to announce the device improvement.
2. Surface the current implementation, checks, and release state, with links to the evidence.
3. Carry the approved facts into the post draft. An unpublished result remains distinguishable
   from a released feature.
4. If a result or release decision changes, identify the affected draft and bring back the
   relevant decision. Preserve earlier versions and the person's approved wording.
5. Let the founder review the device, software, and message through the appropriate interfaces,
   then proceed under the authority they have granted.

Steps involving shared context, impact tracking, and coordinated updates are proposed product
capabilities. Their value can be evaluated against the founder's actual current process.

Mobile, the device, desktop, and terminal access are parts of this ongoing practice. The product
should let the person enter at the right level: a quick decision, a specific session, a project,
or the broader set of work they are directing.

## What is already here

The repository contains more than a terminal manager. It also contains the beginnings of the
project-level system this proposal needs.

| Foundation | Evidence and boundary |
| --- | --- |
| Persistent machine execution and remote access | [Architecture](architecture.md) and [CLI contract](cli.md). Availability still depends on the execution host. |
| Desktop, mobile, and USB device interfaces | [Desktop](../desktop/README.md), [mobile](../mobile/README.md), and [device firmware](../devices/harness-device/firmware/README.md). Their supported capabilities differ. |
| Domain packages and interactive viewers | [Package contract](../store/spec/README.md). A package's presence does not establish output quality for arbitrary tasks. |
| Durable project/task orchestration | [Model](../cli/src/orchestrator/model.ts) and [service](../cli/src/orchestrator/service.ts): dependencies, attempts, delivery state, recovery, and versioned artifact handoffs. |
| Some real end-to-end project evidence | [Orchestrator verification](plans/2026-09-18-orchestrator-pr-verification.md) and [combinations](orchestrator-combinations.md). Evidence is bounded to the recorded workflows and environment. |
| Local-first onboarding requirement | [Development notes](development.md#account-free-local-use). Account-free local startup remains outstanding. |

The next step is to integrate and strengthen these pieces around the founder's daily experience.
The current orchestrator's local runs are a foundation for that work. Reliable cross-machine
project execution and continuing project memory require additional design and validation.

## The architectural center: work across sessions

A continuing endeavor can contain several projects, and each project can contain many sessions.
Preserve that relationship alongside the existing ability to work directly in a session. A
project should retain the intention and evidence while individual agent runs come and go.
The proposed product model is:

```text
ENDEAVOR: for example, building and bringing Harness to users
  |
  +-- Related projects: desktop, mobile, device, research, communication
  +-- Shared decisions and references, with explicit scope and provenance
  +-- Dependencies, current priorities, and decisions needing the person

PROJECT
  |
  +-- Brief: desired outcome, constraints, acceptance criteria
  +-- Materials: source files, references, installed capabilities
  +-- Decisions: approved choices, pending questions, rationale
  +-- Plan: tasks and dependencies, revised as work develops
  +-- Runs: engine, machine, attempt, status, cost, delivery receipt
  +-- Artifacts: versions, provenance, dependencies, editable source
  +-- Evidence: checks, findings, user review, acceptance
  +-- Authority: permitted actions, budgets, stopping conditions
```

This extends existing task and artifact records. It does not require a new distributed service
for the first version. Keep one authoritative owner for a project and clear references to the
machines executing its tasks. Introduce distributed coordination when a real workflow needs it.

Several boundaries matter as the product grows:

- **Execution outlives views.** Clients can reconnect, rebuild their view from authoritative
  state, and resolve uncertain requests without silently duplicating work.
- **Decisions outlive conversations.** Approved choices and their provenance remain available
  outside a model's current context. People can inspect, correct, and remove this memory.
- **Results carry evidence.** Process exit, a quiet terminal, and an agent's success message
  are observations. Completion depends on the project's actual acceptance criteria.
- **Revisions preserve lineage.** A changed upstream artifact identifies downstream results
  that need review or rebuilding. Accepted outputs retain their original versions.
- **Capabilities can be replaced.** Work records and artifact contracts should survive a
  change of engine. Vendor sessions retain their own resume limits; fresh runs can receive
  explicit handoffs without pretending their internal contexts are interchangeable.
- **Autonomy has a scope.** Budgets, permitted actions, and escalation conditions belong to
  the work. Repeated low-impact operations can proceed under previously granted authority.

Shared context should carry relevant, attributable facts and decisions between related work.
Its scope must be inspectable and editable; unrelated sessions should retain their boundaries.
The work model can connect existing sessions without forcing every activity through a director
agent or converting all ongoing work into a predetermined pipeline.

The daemon remains the execution foundation. The desktop remains the main workbench. CLI and
TUI expose operations to terminal users and automation. Mobile and the device reduce delays
at decision points. Web now reuses the desktop Flutter workspace through browser-specific
transport, sign-in, and storage adapters. Publicly viewable shared work remains its growth
hypothesis: people discover Harness through a real session and start using it themselves.
The backend carries identity, reachability, and agreed shared metadata; private project content
requires an explicit storage and encryption design before adding cloud synchronization.

## Web: shared sessions as an acquisition loop

**Implementation decision, September 27, 2026:** build web and desktop from the same
Flutter package in `desktop/`, sharing the screens, state, and terminal renderer.
The browser target is live as a public preview at
[harness.autonomous.ai](https://harness.autonomous.ai), with authenticated machine access and existing
private invitations. Public publishing is a separate next
step requiring the review, snapshot storage, and acquisition flow described below.

The founder identified a concrete growth hypothesis: someone shares a Harness session on X,
other people open the link to see the work, and some download Harness to do work of their own.
Each shared session can become a demonstration created through actual product use.

```text
Do useful work in Harness
          |
          v
Share a session link on X or elsewhere
          |
          v
Someone opens it and sees the work and result
          |
          v
They download Harness and complete their first useful project
          |
          v
Some share their own work, beginning the loop again
```

This gives web a distinct purpose alongside desktop and mobile: discovery through someone
else's work. The shared page should help a new visitor understand what the person wanted,
what the agent did, what was produced, and how they could try something similar.

Extend the existing Share action so its recipient can open the work in a browser.
The original recipient flow opens another Harness app. The acquisition path becomes:

```text
Existing: Share -> recipient opens Harness app -> views the session
Proposed: Share -> recipient opens browser -> views the work -> downloads Harness
```

The first experiment adds a browser destination and a public-link option to that existing flow:

- Open without an account or app installation; work well in a phone browser reached from X.
- Lead with the result and a short brief. Let the visitor inspect selected conversation turns,
  relevant actions, and available output in more detail.
- Provide a useful title and image for the link preview and a clear Download Harness action.
- Preserve the originating example through installation where feasible, so the person has a
  concrete starting point. A later "Make something like this" action could prepare a new project
  from an explicitly published brief or template using the new user's own files and accounts.
- Keep the page useful after the creator closes the app or their machine goes offline.

The smallest version can publish a reviewed snapshot of selected session content and artifacts.
Recorded playback and live viewing can extend it. The author chooses and previews what becomes
public and can unpublish the page; subsequent private session activity is not added automatically.
Published snapshots need storage and delivery independent of the execution machine.

The [existing sharing implementation](plans/2026-09-17-002-share-harness-plan.md) already provides
account-bound invitations and live, view-only observation in the recipient's app. A browser
viewer can reuse the supported private sharing protocol. The acquisition experience additionally
needs a public-link mode for people arriving from X; rendering the current invitations in a
browser alone would still require recipient access. Public snapshots and installation handoff
are further additions to this foundation. A public snapshot page exposes the selected published
work, with no terminal input or access to the creator's machine.

Measure the funnel separately: unique human visitors, download clicks, confirmed first launches,
first useful projects, return use, and subsequent sharing. Link-preview crawlers should not count
as interested visitors. Where a visitor can voluntarily carry the shared example into the app,
use its share identifier to connect discovery with activation. Conversion rates are unknown;
the experiment should establish them and the cost of serving each successful acquisition.

This bounded acquisition experiment can run alongside improvements to the founder's daily work.
Start with a few author-approved sessions worth sharing, and expand the web product based on
whether visitors become users who do useful work and return.

## Where a lasting advantage could accumulate

Persistent agents and orchestration already attract investment elsewhere. Anthropic describes
a hosted runtime separating durable sessions, agent execution, and environments in its
[Managed Agents architecture](https://www.anthropic.com/engineering/managed-agents), published
April 8, 2026. Its March 24, 2026
[application-development research](https://www.anthropic.com/engineering/harness-design-long-running-apps)
also examines planners, generators, evaluators, and structured handoffs. These are primary
accounts of that vendor's systems, not an exhaustive market comparison.

Our strategic inference: execution infrastructure needs to be excellent, and differentiation
must also come from the experience and capabilities built around it. The assets worth growing
are:

- A project history that preserves the user's materials, judgment, and working conventions.
- Domain packages that reliably produce useful, editable artifacts and explain their checks.
- Review interactions that make a new discipline understandable to a technical builder.
- Repeatable ways to compose capabilities, revise their outputs, and preserve consistency.
- An author community whose packages work on other people's machines and improve through use.

As engines improve, re-evaluate orchestration complexity against a direct single-agent baseline.
The product should benefit from better models and retain only the machinery that earns its cost.
Project ownership, real tools, review, and continuity should remain useful through those changes.

## Roadmap: earn each increase in scope

These stages describe user capabilities. Some foundations already exist; each stage includes
integration and proof as well as missing implementation. Later stages depend on earlier evidence.

| Stage | Promise to the user | Main work | Evidence required to expand |
| --- | --- | --- | --- |
| 1. Make returning to work dependable | "I can return to any piece of work and see what needs me." | Search across real sessions, reliable restore/resume/reconnect, clear execution and delivery state, consistent decisions across clients, and account-free local use. | The founder can recover the actual engineering and marketing sessions they seek; restart and uncertain-request exercises preserve work without duplication. |
| 2. Carry decisions across related work | "Related work knows the facts and decisions it needs." | Connect existing sessions to projects, preserve approved decisions and references, show their provenance, and make shared context inspectable and editable. | A real product decision reaches the relevant mobile, desktop, device, or communication work with less repeated explanation and no loss of user control. |
| 3. Understand consequences across sessions | "A change tells me what else needs attention." | Versioned handoffs, release-aware communication, downstream staleness, a decision inbox, and selective updates across a few real workstreams. | The firmware-to-post journey or another observed dependency stays consistent through a revision, with less manual coordination than the baseline. |
| 4. Delegate longer spans of responsibility | "This work advances and recurs within my instructions." | Build on the existing orchestrator with acceptance evidence, budget visibility, failure recovery, recurring work, and scoped authority. | The founder entrusts bounded outcomes and recurring work for weeks; corrections, exceptions, cost, and unwanted activity remain manageable. |
| 5. Make this way of working repeatable for others | "I can bring my own endeavor and add the capabilities I need." | Onboarding for adjacent users, reusable project practices, domain packages, authoring assistance, reproducible environments, and richer collaboration where demanded. | Other people obtain similar value on their own projects, and outside authors deliver capabilities that work beyond their machines. |

Hardware can improve the attention loop throughout these stages. Develop its status, decision,
and voice experience alongside frequent users. Broader hardware ambitions should follow evidence
that a dedicated physical interface changes their daily work. The present USB device remains a
companion to a host that runs the daemon.

## The next 30 days, proposed

Use the founder's ongoing work as the first reference environment. Observe real sessions and
decisions with their permission; keep personal transcripts and credentials out of published
examples. Establish a baseline for finding work, repeating context, coordinating changes, and
reviewing results. Further customer research should test how this practice generalizes.

| Period | Concrete output |
| --- | --- |
| Week 1 | Map the founder's real workstreams and recurring coordination. Reproduce failures to find or restore sessions. Select one observed dependency, such as firmware results feeding an X-post draft. |
| Week 2 | Fix the most consequential continuity gaps and add an inspectable way to associate the relevant sessions, decisions, and evidence. |
| Week 3 | Carry one real change through those sessions, including review and revision. Measure repeated explanation, navigation, stale facts, and human effort against the baseline. |
| Week 4 | Observe whether the founder keeps using that connection. Test the same experience with a few adjacent users on their own projects, and separate founder-specific preferences from general needs. |

Run this as one effort to improve actual daily work. Ongoing desktop, TUI, mobile, and device
development can exercise the same model and contract. Prioritize each surface by the coordination
or interaction it improves. Test the bounded web-sharing acquisition loop with work this effort
produces. Broader web functionality and domain expansion should follow observed demand and a
clear role in the experience.

## Measures and decisions

The main outcome measure is useful, accepted work advanced or completed per person per week.
Read it alongside time spent finding work, repeating context, coordinating changes, and reviewing
results, plus cost, revision effort, recovery incidents, and retained use. Compare similar job
types and quality criteria; splitting a project into small outputs must not inflate success.

Track requests that fail or are abandoned as part of the denominator. Record why a result was
rejected. A deliverable being used outside Harness is stronger evidence than its viewer being
opened. Agent counts, token volume, and catalog size describe activity and capacity.

Three questions should remain open until real use answers them:

1. Which recurring coordination is the founder doing personally, and which parts should Harness
   assist with? Distinguish valuable human judgment from avoidable repetition.
2. Do shared decisions and explicit dependencies reduce stale work and revision effort across
   the actual sessions, without making direct work harder?
3. Which benefits transfer to other people directing their own endeavors, and which interface
   helps them realize those benefits?

A business hypothesis to test after repeat use: open local software and an open package format
can support paid hosted execution, collaboration, and device sales. Validate willingness to pay
for each convenience separately. Sustainable economics require useful outcomes after accounting
for model, compute, support, and hardware costs.

The decision for this proposal is to organize Harness around the continuing work a person is
already directing: its intentions, relationships, progress, decisions, and usable results.
