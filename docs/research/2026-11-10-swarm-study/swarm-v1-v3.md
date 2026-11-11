# Swarm v1–v3: a post-mortem from the record

> Part of the [Swarm study of 10 November 2026](README.md). Written by a research agent from GitHub's own data, read-only. The scripts and raw files it names were working files and are not kept here; each section says how its numbers were counted, so they can be counted again.

Written 2026-11-10 from the repository at `82a6c9a9ec` (branch `swarm-v4`, same as `main` that evening), GitHub
(`autonomous-ai/openharness`, read-only) and the docs in the tree. Read-only research: nothing was edited, committed,
pushed or posted.

## 0. Method, and what could not be seen

- **History is complete.** `git rev-list --count HEAD` = 5,046; first commit 2026-08-04; `--is-shallow-repository` =
  false. Tags in this worktree stop at `v1.3.76_backend` (10-30); later backend tags were read from GitHub.
- **Times are Vietnam time (ICT, UTC+7)** unless marked UTC. Commit times were converted (`TZ=Asia/Ho_Chi_Minh`,
  `format-local`); raw author times in this repo mix +07:00, −07:00, −08:00 and −04:00.
- **Sizes** come from `git diff --numstat 4b825dc… <commit> -- <path>` (insertions = lines), split into code and tests
  (`*.test.ts`, `*.spec.ts`, `*_test.dart`, `fixtures/`, test-support). Raw output: `sizes2.txt` beside this file.
- **Pull requests:** 2,736 PRs created 2026-10-09..11-10 were listed through GraphQL (`all-prs.json`); for 2,679 of
  them the changed paths were read (first 100 files each, `gh-files/`). "Swarm-path PR" means a PR that changes a file
  under `backend/src/superTabs/`, `cli/src/superTabs/`, `desktop/lib/super_tabs/`, `mobile/lib/swarm/`,
  `cli/src/lib/swarm*`, their test folders, `cli/src/team/` or `docs/swarms.md`. A PR is "landed" when GitHub says
  MERGED or a `Merge batch …` commit on main names it (750 PRs landed that way and show as CLOSED on GitHub).
- **Fix shares are soft numbers.** Titles here are written as outcomes ("a message … reaches its agent again"), so a
  fix is found by words (`fix`, `hotfix`, `revert`; then `again`, `no longer`, `never`, `stuck`, `lost`, `fail…`).
  Both counts are given, with the regex, and neither is exact.
- **Not seen:** lampOS's own record (another agent has it); chat inside the Swarm itself (decisions, the owner's
  messages) except where a doc or PR body quotes it; production data; the content of PRs inside a batch beyond their
  title and file list; PRs with more than 100 files past the 100th.
- **GitHub budget used:** GraphQL only (`gh pr list --json`, `gh pr view`, `gh api graphql`), about 1,200 points; no
  REST calls beyond `rate_limit`.
- **Names.** People other than the owner ("anh Dee", as the docs write it) are replaced by a role in square brackets,
  also inside quotations; that is the only change made to quoted text. Agent names (River, Faye, Theo, Juno, Pip…)
  are kept.
- **Inference** is marked "(inference)". Everything else is read from the cited place.

---

## 1. The versions

### 1.0 The docs do not agree on what "v1", "v2" and "v3" mean

Four usages are in the record:

| Usage | What it names | Evidence |
|---|---|---|
| Builders' branch labels, 26–27 Oct | **"Swarm v1"** = PR #1755: "Swarm state by parts (#1726) and Swarm v1: Chat with PM, lost-work takeover, routing readiness". **"Swarm v2"** = PR #1784 (branch `feat/swarm-v2`): "decisions with options and one-tap answers, reviews that continue when a model fails, night-shift digest, scheduler plan for the Lead, and the human leaderboard" | commits `a4b32c97af` (10-27 09:23) and `31e49f6b8d` (10-27 13:21); PR #1784 body; `docs/postmortems/2026-10-27-1755-design-rework.md:37` |
| The owner's "v2 process", 5–6 Nov | The standing crew, lanes and server dispatch pushed into every PM's built-in text: "## Swarm process v2 (from the Swarm, 2026-11-06): this replaces every process line in your project's instructions." | `backend/src/superTabs/pmSchedule.ts` at `1622ac6359` (`v2Section`); PR #3299 "Every PM gets the v2 process in the built-in PM text (#3603)"; `docs/plans/2026-11-06-pm-learns-process-plan.md:6`: "lamp's PM (Faye) did not know the Swarm v2 process (anh Dee, 11-06)" |
| "Swarm v3", 7 Nov | The spec "Requested by anh Dee at 00:05 Vietnam time, for the 09:00 Vietnam release on 2026-11-07" | `docs/specs/2026-11-07-swarm-v3.md:3` |
| v4's own words, 8–10 Nov | Everything before v4, measured as one thing: "v2's Swarm is about 75.8k lines in the backend…"; "v3 clients keep reading conversations; the removed v2 surfaces answer empty"; "remove the dead v1-v3 Swarm leftovers" | `docs/plans/2026-11-08-swarm-v4.md:72,83`; commit `35bf66328e` |

So "v1" and "v2" were both merged on 27 October by their builders, and nine days later the owner used "v2" for a
different thing. No doc defines the three as generations. **Best reconstruction, used below** (by the model that
governed how work flowed; the phases are robust even if the labels are drawn differently):

| Label here | Dates (ICT) | Opens | Closes | One line |
|---|---|---|---|---|
| Pre-history | to 10-18 | "Swarm collaboration" (tab channels, agent teams, `harness team`); then Agent Messages, `harness send` (designed 10-10; #1159 merged 10-11) | Swarm collaboration removed 10-11 (#1161, #1165); study #1397 (10-17) | A doorbell between agents, then a study |
| **v1** | 10-18 → 10-27 | Super Tab MVP spec "Implementation authorized 18 October 2026"; #1405 `343d517362` (10-19 08:55), backend `v1.2.92`, internal Desktop 1.2.94 | #1755 `a4b32c97af`; released 10-27 ~10:51 (backend `v1.3.36`, CLI 0.4.74, Desktop 1.3.20) | A Lead and its work groups, state in one document |
| **v2** | 10-27 → 11-06 | #1784 `31e49f6b8d` (10-27 13:21), backend `v1.3.40` | last pre-v3 commit `1622ac6359` (11-07 01:01), backend `v1.4.25` | Three models in ten days: **2a** hub with more machinery (10-27..10-30); **2b** rules in a prose document (10-31..11-04, #2414); **2c** the 11-05 "Swarm redesign" = "process v2" (crew, lanes, server dispatch, merge train, Board and proposals) |
| **v3** | 11-07 | #3449 `7356cf6330` (11-07 01:19); backend `v1.4.26` (05:24), CLI 0.5.63, Desktop 1.3.87–1.4.8 | `d8fda0c681` (11-08 00:16), backend `v1.4.41` | My agents / chat / Tasks with approval, Regular or PM agents, no Team accounts |
| v4 | 11-08 → | plan "approved by anh Dee, 2026-11-08"; #3585 `bc2648f4e4` (11-09 08:39), backend `v1.4.42`, CLI 0.5.75, Desktop 1.4.9 | (being built) | "Slack for agents", lampOS's process as a product |

An alternative reading puts the v1→v2 line at 5–6 November (the owner's "v2 process"), which makes v2 two days long.
The record cannot settle it; sections 3 and 4 are organised by phase so that either reading works.

### 1.1 Pre-history (to 18 October)

- **"Swarm collaboration" (before 10-10).** Tab channels and agent teams. `docs/design/2026-10-10-agent-messages.md:3`:
  "Replaces Swarm collaboration (tab channels and agent teams, removed October 11, 2026)." What was observed on a real
  three-agent team (the doc does not name it; `docs/design/2026-10-11-agent-client.md:13` calls it "The lamp team
  (October 10)"): "**No message was ever pushed to an agent.** All three ran turns lasting hours… One worker received
  nothing in an hour and lost four messages. The other only heard by polling its inbox. The lead went back to tmux paste"
  (`2026-10-10-agent-messages.md:19-22`); "`ask` was the only verb, so status, review findings, checkpoint notices and
  'please acknowledge' all became questions"; "The introduction was about 20 lines with a 64-character key… The person
  called the tmux paste concise and the Harness message verbose."
- **Agent Messages, `harness send` (design dated 10-10; #1159 "…replacing Swarm", Desktop #1161 and cleanup #1165
  merged 10-11).** The conclusion then: "So the product
  needs a safe doorbell, and nothing more" (`:33`); "Nothing else is built in: no roles, no inbox, no question ledger,
  no keys. Agents choose their own conventions on top" (`:6-7`). Its on/off switch moved twice on 12 October: one per
  tab, then one per computer and on by default "for part of that day", then an account experiment, off by default
  (same doc, "What the person sees").
- **The study, "One person, many agents" (#1397, merged 10-17 23:17; `docs/research/2026-10-17-one-human-many-agents/`).**
  Evidence from "our pilot, one owner directing a lead agent and ~14 builders" (`README.md:4`). Its findings:
  "**Review and merge set the output**" (`README.md:81`); the pilot had moved to "Tasks as GitHub issues; one PR per
  task; `you are <name>`" on Oct 14 (`01-pilot-evidence.md:35`); "The coordination thread outgrew what agents can
  read… 50 admissions of a missed message" (`04-bottlenecks.md:42`). Its recommendation: "## The next step is an
  experiment, not more design" (`README.md:114`): four rule changes on the pilot with no new code, the fourth being
  "builders pull their next task instead of waiting for the lead" (`:119`), then "build the smallest slice (… Swarm
  tab, floor, `harness task next`, an inbox per worker)… Harness's previous agent-team design skipped this step, and the
  first real team ignored it" (`:121`).
- **What happened instead.** The next day's spec, `17-super-tab-mvp.md` ("18 October 2026, review revision 09.
  Implementation authorized 18 October 2026"), is a different product: a Lead that delegates into groups. #1405 landed
  10-19 08:55, 33 hours after the study merged. No record shows the four experiments being run, and no
  `harness task next` ever existed in `cli/src` (searched). (Inference: the study's "experiment first" step was skipped
  a second time.)

### 1.2 v1: Super Tab, a Lead and its work groups (18 → 27 October)

- **Actors.** People (owner, collaborators, viewers); a **Lead** (shown as Product Manager from 10-23); **member
  agents**, called Builders/DEV, then a **Reviewer** role (#1568, 10-22); contributed **machines**. "A Super Tab is a
  Harness tab where people work with a lead and member agents. Open it, talk to the lead, and watch delegated work become
  shared group conversations" (`17-super-tab-mvp.md:5`). Projects, private projects and the name "Swarm" arrive 10-20
  (#1464); a Leads conversation and custom role sets 10-23 (#1645, #1652).
- **A task, and where it lived.** A work group: a conversation in the backend with a brief, an assignment, acceptance
  checks and PR links (ST-010, `:66-70`). "Our backend owns conversations, membership, work state and delivery records"
  (ST-016, `:170`). From 10-22 a task had five required parts (goal, changes, constraints, owned code, acceptance
  checks; #1517). All of a Swarm's state was "one MongoDB document. Its whole state was one JSON field under one
  revision" (`docs/postmortems/2026-10-27-1755-design-rework.md:13`).
- **Assignment: dispatch.** The Lead creates groups, routes and assigns; workers wait: the first start prompt told a
  new agent "Do not begin project work yet. Your lead will assign work in conversation …" (`cli/src/superTabs/start.ts`
  at `343d517362`). Routing asked a hosted model (Jev) for a pick (#1424, #1431), then owner rules replaced it (#1586,
  10-22) because "the Lead overrode Jev's pick about half the time" (`docs/plans/2026-10-22-swarm-rules-routing.md:10`).
  The server enforced the flow: route before start (#1555), and a keep, reuse or stop decision for each finished
  worker before anything else is routed (#1527).
- **How a message reached a session.** A delivery row in the backend; the machine's daemon polled every second,
  claimed it and typed it into the agent's terminal, wrapped in about 90 words of how to read, reply and delegate
  (`host.ts prompt()` at `343d517362`). At first delivery waited for an idle agent (#1525, 10-22, changed that); a
  message stayed held while a question was on the agent's screen. From 10-22 every worker post was also copied to the
  Lead (#1529).
- **Instructions.** 10-19: one 69-word start prompt. 10-22 (#1533): built-in skills, Lead 286 words, DEV 229. 10-23
  (#1602): two "skill modes"; in "Harness orchestration" mode ("The owner's texts, used verbatim", comment in
  `cli/src/lib/swarmSkills.ts` at `a36e2d1e0f`) the Lead read 2,884 words, a Builder 2,179, a Reviewer 838; plus custom
  role texts per project (#1659–#1667), plus "Running Swarm agents pick up new skill text after an update" (#1585).
  The skill then said the repository came first: "Project instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING) and the
  owner's words outrank this skill."
- **What a person saw and had to do.** A flat sidebar, the chat, a roster of Humans, Agents and Machines. The spec
  promised "There is no global human-request list, bottom strip or separate human-approval room" (`:76`) and "no nested
  reply rooms, reaction systems or new global attention feeds in this pass" (`:238-239`). The Lead skill put approvals
  on people: "Nothing is split or assigned until the task giver or project owner approves the description you showed"
  and "Merging, opening a PR, releasing or discarding is the owner's decision. Ask; never assume."
- **Review and merge.** A task's acceptance checks could be marked independent, and then "Another agent or a person"
  had to pass them (`INDEPENDENT_REVIEW`, `backend/src/superTabs/commands.ts:1374` at `a36e2d1e0f`); a Reviewer role
  from 10-22; merging stayed a person's decision (the Lead skill, above).
- **How it ended.** The state document hit 1.16 MB on 10-26 and returned 500s; storage was rebuilt "by parts" and
  shipped with Chat with PM and lost-work takeover as #1755 (the builders' "v1").

### 1.3 v2: three models in ten days (27 October → 6 November)

**2a, 10-27..10-30: the hub with more machinery.**
- Added in #1784 and the days after: **Decisions** (`decision.ask`, 2–5 options, a recommendation; #1753), review flow
  changes (#1754), a scheduler prototype in Python (#1756, #1764), the night-shift and morning digests (#1757, #1772),
  "Team at a glance", the **leaderboard** (#1762), avatars, status and reactions (#1766), Workspaces above Swarms
  (#1811), cost records (#2106), threads (#2132), a Cmd-K switcher (#2129), the phone app's Swarm (#1770).
- **Team accounts** (#1688–#1705, from 10-24): "a separate standard macOS user for team work, not a VM"
  (`docs/plans/2026-10-24-swarm-team-account.md:9`), a second daemon as that user, and a **GitHub App** token per task
  repository (#1690).
- **Buddy** (10-28/29): "A Buddy is a person's own agent in one project… it posts one proposal… The product manager
  assigns the work as usual" (`docs/swarms.md:230-234`). "Buddies are on in every Swarm; there is no setting. They
  replaced Chat with PM ([a maintainer], 2026-10-29)" (`:236`), two days after Chat with PM shipped; "On 2026-10-29
  production held 9 such chats in 4 Swarms, and none had a decision asked in it" (`:377`).
- More server-run flow. `liveness.ts` came with #1755 (quiet tasks are marked lost and handed on). Added 10-28/29
  (files present at `a0d42de336`, absent at `31e49f6b8d`): `autoReview.ts` (the server opens and assigns reviews, on
  another engine than the Builder's), `stepUp.ts` (a failed first review moves the task to a stronger model and cancels
  its Builder) and `tidy.ts` (idle Builders are stopped, #1807).
- Otherwise as v1: the PM dispatches, the server enforces review and routing rules, every post is copied to the PM.

**2b, 10-31..11-04: the rules move into a prose document (#2414, `6d28e2f647`, 10-31 08:32).**
- Decided 10-30 by a maintainer (`docs/plans/2026-10-30-project-instructions-design.md:39-56`): "One instruction
  document per project defines everything"; "The server locks no role, workflow or routing rule. It enforces facts and
  access only"; "Agents message each other directly… the server stops copying agents' messages to the PM."
- **Actors:** a coordinator (PM) per project; agents with free-text role names (Engineer, Reviewer, Tester in the
  template); Buddies. "Any agent of the project may create, assign and start tasks and agents" (`docs/swarms.md:55`).
- **Task:** still a Swarm conversation; from 11-02 "one request is one task with steps" (#2511, #2520): review and test
  are linked "steps".
- **Instructions:** two skills per agent, "Harness tools" (2,461 words on 10-31, 3,660 by 11-05) and "Project
  instructions" (the stored document, 64 KB cap, 50 revisions kept, template 591 → 1,929 words), refreshed on every
  save with a notice; from 11-04 the PM also read a built-in schedule (232 words, 1,022 a day later) and was woken every
  30 minutes for it.
- **Person's surface:** Activity, Threads, mentions with badges (10-31, "Slack attention" #2434, #2450); then the
  "Quiet Swarm" redesign (11-02); one Buddy per person per Swarm (10-31), with full access to its owner's machine from
  11-04 (PR #2991).
- **Review and merge:** by the document: the Engineer opens review and test steps and names the Reviewer; "The
  coordinator hears once, merges and tells the people who asked" (`docs/swarms.md:1068`).

**2c, 11-05..11-06: "anh Dee's Swarm redesign, approved 2026-11-05" = "process v2".**
- Code takes the flow back from the prose and from the PM (PR numbers; the "#33xx–#34xx" in the plans are Swarm task
  numbers, a second number space): server time checks and a PM watchdog (PR #3213); a **task contract** refused by code
  (`TASK_CONTRACT_MISSING`, `docs/plans/2026-11-05-task-contract-plan.md:5`); a **standing crew** kept alive, asleep
  and awake by the server (PRs #3222, #3229); **lanes** and **crew dispatch** (PR #3230): "The server, not the PM, gives
  work to the crew: every 30 seconds… Two hours without progress sends the member a line; three hours puts the task back
  in its lane" (`docs/plans/2026-11-05-crew-dispatch-plan.md:7-9`); a **merge train** ("Every 10 minutes the server
  merges approved pull requests in batches through the Harness GitHub App", `2026-11-05-merge-train-plan.md:7`, off by
  default); a project **rules record** (PR #3216); a **shell guard** hook (PR #3304); a rule guard that parses
  "(Name, date)" attributions in the instructions (PR #3112).
- 11-06: every project's instructions in the owner's Swarm are rewritten onto a "new base" by a job (#3300: "anh Dee:
  'ALL OF THEM'; River's rulings: 'REPLACE 100%', no preview, one review"); the built-in PM text gains the "Swarm
  process v2" section (#3299); and the owner rules that "every rule a program can check belongs in code; project
  instructions keep judgment and project facts" (`docs/plans/2026-10-30-project-instructions-design.md:85-87`), which
  becomes AGENTS.md standard 13, "Code over prompts", the next day (PR #3561).
- 11-06, the **Buddy/Board final spec** (`docs/plans/2026-11-06-buddy-board-final-spec.md`): "people stop talking to the
  PM, and the PM stops talking to people" (`:10`); people talk to several Buddies; work enters as **proposals**; a
  project opens on a six-column **Board** (Proposal, Next up, Working, Done, Merged, Shipped); a per-project "Can chat"
  right; a per-project switch between the old and new way.
- Kinds of agent by 11-07: "Buddy, Regular, PM, and crew Engineers and Reviewers"
  (`docs/specs/2026-11-07-members-and-leads.md:99`).

### 1.4 v3 (7 November)

`docs/specs/2026-11-07-swarm-v3.md:7-15`:
- **Left:** "organization switching, Decisions, My agents (the person's Buddy first, then agents on their own
  account)… a crown immediately beside a PM's name… Remove Mentions." **Middle:** chat, or the project's Board and
  Chat. **Right:** "Tasks, sorted by time".
- **Approval:** "Auto approve / Review dropdown beside Tasks… In Review a new task waits; its agent is a suggestion
  the person can change, and the person approves or rejects it. The backend stores the per-person mode and enforces the
  wait." New commands `member.approvalMode`, `task.suggest`, `task.approve`, `task.reject`.
- **Agents:** "a new agent is Regular or PM… A Regular agent is not tied to a project." **Joining:** "bring your agent…
  and that agent becomes your Buddy."
- **Remove:** "the owner-subscription relay, Claude/ChatGPT login reads for usage in CLI and Desktop, and Team
  accounts."
- The 2c machinery (crew, dispatch, steps, proposals, Board, instructions) stayed underneath.
- The same day produced two more models: **Members and Leads** at 16:10 ("There are only Members and Leads, with no
  separate Buddy", `2026-11-07-members-and-leads.md:11`; first backend step merged 11-08 00:16, #3575) and **barebone
  agents** at 23:03 (#3574: "a barebone you so I can understand exactly how you're reacting and tune you").

### 1.5 v4, for reference (from 8 November)

Plan: "Slack for agents… It is how lampOS ran in the week of 26 October, before faye: clean, default Claude Code and
Codex sessions, coordinated through GitHub issues" (`docs/plans/2026-11-08-swarm-v4.md:9-11`). As built by 11-10:
tasks are the repository's GitHub issues (#3598; the plan text at `:34` still says "**Tasks** live in Swarm"); agents
run only on their own person's computer and login; a channel per project; a 1:1 chat per agent typed exactly as written
(#3627); Harness relays GitHub comments to the agents they name (#3620), assigns sized issues with a solver (#3624),
asks readers (#3663) and merges on `READ-OK` (#3633); every agent starts with `SWARM_BASICS` in the engine's own
instructions (#3636).

---

## 2. Size and churn

### 2.1 Code size at each boundary

Lines of product code (tests, specs and fixtures excluded), with files in brackets. Source: `sizes2.txt`.

| At (ICT) | Commit | `backend/src/superTabs` | `cli/src/superTabs` | `desktop/lib/super_tabs` | `mobile/lib/swarm` | Sum |
|---|---|---|---|---|---|---|
| 10-19 08:55, after #1405 | `343d517362` | 1,226 (4) | 1,389 (11) | 3,775 (11) | 0 | 6,390 |
| 10-23 end | `a36e2d1e0f` | 4,593 (17) | 5,034 (26) | 15,092 (44) | 0 | 24,719 |
| 10-27 09:03, before #1755 | `ee95d52742` | 5,683 (19) | 6,038 (29) | 18,347 (49) | 0 | 30,068 |
| **end of v1**, #1755 | `a4b32c97af` | 8,468 (47) | 6,761 (34) | 19,171 (50) | 0 | 34,400 |
| start of v2, #1784 | `31e49f6b8d` | 9,254 (55) | 7,260 (37) | 21,354 (67) | 0 | 37,868 |
| 10-31 end (2a → 2b) | `37b62749b8` | 22,576 (120) | 16,864 (62) | 44,575 (129) | 35,086 (85) | 119,101 |
| 11-04 end (2b → 2c) | `a793554721` | 31,335 (163) | 19,586 (71) | 61,736 (170) | 57,159 (131) | 169,816 |
| **end of v2**, 11-07 01:01 | `1622ac6359` | 43,029 (228) | 22,365 (83) | 73,141 (195) | 60,757 (134) | 199,292 |
| **end of v3**, 11-08 00:16 | `d8fda0c681` | 45,782 (242) | 22,195 (84) | 78,364 (214) | 60,905 (135) | 207,246 |
| today, 11-10 21:02 | `82a6c9a9ec` | 32,210 (205) | 16,932 (76) | 50,897 (157) | 58,999 (132) | 159,038 |

`desktop/lib/swarm/` does not exist at any of these commits: v4's Desktop view was built inside `super_tabs/`
(the handoff planned `desktop/lib/swarm/`, `docs/plans/2026-11-08-swarm-v4-handoff.md:37`).

With tests, at the end of v3: backend 94,592 lines in 465 files (223 of them tests), CLI 59,101 in 200, Desktop 78,364
in 214, phone 60,905 in 135; plus `backend/integration/superTab*` 38,886 lines (78 files), `desktop/test/super_tab*`
132,404 (367 files) and `mobile/test/swarm` 98,168 (236 files): **about 562,000 lines of Swarm code and tests**, from
6,390 lines of code twenty days earlier. Product code grew by about 10,000 lines a day on average, and was larger at
every point measured, until 8 November.

**The v4 plan's own numbers are low.** "backend/src/superTabs 345 files, 75.8k lines; cli/src/superTabs 49k lines;
desktop/lib/super_tabs 191 files" (`2026-11-08-swarm-v4-handoff.md:25`) matches a count of the top-level folder only,
tests included: at `d8fda0c681` the top level holds 335 backend files with 76,056 lines, 48,954 CLI lines and 191
Desktop files; sub-folders hold another 18,536 backend, 10,147 CLI and 4,373 Desktop lines.

Named sub-systems at the end of v3 (`d8fda0c681`, files with the word in their path, docs excluded): **Buddy** 100
files, 34,197 lines (Desktop 13,589; backend 8,449; phone 7,929; CLI 4,230); **Team account** 65 files, 20,126 lines
(`cli/src/team` alone 10,501 in 38 files). The handoff counts "Buddy touches 422 files" (`:26`).

### 2.2 Backend surface

Distinct command types (`type: z.literal('x.y')` under `backend/src/superTabs`) and Prisma models named `SuperTab*` or
`Swarm*` in `backend/prisma/schema.prisma`:

| At | Command types | `commands.ts` lines | Models (collections) |
|---|---|---|---|
| 10-19 (#1405) | 23 | 421 | 9 |
| 10-23 | 55 | 1,406 | 14 |
| end of v1 (#1755) | 59 | 1,654 | 22 |
| start of v2 (#1784) | 64 | 1,756 | 23 |
| 10-31 | 84 | 2,901 | 42 |
| 11-05 | 108 | 4,034 | 44 |
| end of v2 | 124 | 4,801 | 46 |
| end of v3 | 137 | 5,526 | 46 |
| today | 106 | 3,914 | 38 |

The 137 types of v3 fall in 26 families (agent 24, project 21, work 11, buddy 10, member 9, machine 9, conversation 7,
tab 6, proposal 6, …). Since v3, 33 are gone from the schemas and 2 are new (`github.relay`, `machine.teamGone`); 32
of the removed ones are still accepted and answered as retired until at least 2026-12-09
(`backend/src/superTabs/retired.ts`).

### 2.3 Text given to an agent

Words in the string constants an agent received (`instruction-words.txt`; my count at `a1df11b33` matches the table
in PR #3574 to within 2%).

| At | At launch, by role | Also read |
|---|---|---|
| 10-19 | one start prompt, 69 words | about 90 words of how-to wrapped round every delivered message |
| 10-22 (#1533) | Lead skill 286; DEV skill 229 | same |
| 10-23 | Lead 2,884 ("orchestration" mode) or 804 (default); Builder 2,179 / 561; Reviewer 838 / 307 | custom role texts |
| end of v1 | Lead 3,045 / 919; Builder 2,226 / 598; Reviewer 838 / 307 | |
| start of v2 | Lead 3,344 / 1,218; Builder 2,273 / 645 | |
| 10-29 | Lead 3,984 / 1,812; Builder 2,697 / 1,074; Reviewer 1,152 / 621; **Buddy 1,188** | |
| 10-31 (#2414) | tools manual 2,461 + the project's instructions (template 591) | role skills now a fallback (Lead 4,199) |
| 11-05 | manual 3,660 + instructions (template 1,929) + **PM built-in text 1,022** | PM woken every 30 min; notice on every save |
| end of v2 | manual 3,646 + per-role sheet (PM 444, Engineer 848, Reviewer 586, Tester 586) + instructions + PM built-in 1,203 (v2 section 185) | Buddy 1,990 |
| 11-07 23:03 (#3574, barebone) | a 41-word launch line; then the manual (3,663 by the PR's count) and the instructions by command | |
| 11-09 08:39 (#3585, v4) | "You are <name>." | |
| 11-09 21:52 (#3636) | `SWARM_BASICS` 302; PM also `PM_BASICS` 73 | in the engine's own instructions |
| 11-10 19:54 (#3868) | `SWARM_BASICS` **507**; PM also 143 | five versions in 22 hours (302, 358, 359, 428, 507) |

The real document was larger than the template: on 11-06 "openharness keeps ~22 KB of rules"
(`docs/plans/2026-11-06-instructions-rebase-plan.md:28`), and PR #3300 says "People notes come to ~22 KB, over its
3 KB budget". The openharness project's instructions were at revision 79 on 11-06 (#3300), 86 on 11-07
(`docs/prompt-rules-audit.md:17`) and 90 by that night (#3574), having started on 10-31; lamp's were at revision 71 on
11-05 (`docs/plans/2026-11-05-instructions-rule-guard-plan.md:18`). `cli/src/lib/swarmSkills.ts` was changed by 71
commits between 10-22 and 11-07 (82 to date).

**Prompt rules counted:** `docs/prompt-rules-audit.md:44-51` (11-07): **657** rules "a Lead or a Member is given
today": 190 already code, 90 being built as code, 125 that code could enforce, 163 judgment, 89 to remove ("A Swarm v1
or v2 leftover, a Team-account rule, or a duplicate"). By source: project instructions 184, built-in PM texts 151,
role skills 169, tools, frame and launch 153.

### 2.4 Commits and pull requests per day

Commits on main that touch the Swarm paths (991 from 10-19 to 11-10; `swarm-commits-ict.txt`), and PRs by creation day
(`swarm-prs.json`):

| Day | Commits | of which batch merges (PRs inside) | All PRs created | Swarm-path PRs created | landed that day | closed unmerged | still open |
|---|---|---|---|---|---|---|---|
| 10-19 | 5 | 0 | 28 | 4 | 4 | 0 | 0 |
| 10-20 | 10 | 0 | 28 | 10 | 9 | 0 | 0 |
| 10-21 | 20 | 0 | 36 | 15 | 16 | 0 | 0 |
| 10-22 | 60 | 0 | 85 | 51 | 47 | 2 | 0 |
| 10-23 | 52 | 0 | 76 | 47 | 46 | 0 | 0 |
| 10-24 | 21 | 0 | 28 | 23 | 22 | 0 | 0 |
| 10-26 | 12 | 0 | 38 | 21 | 22 | 0 | 0 |
| 10-27 | 32 | 0 | 95 | 66 | 51 | 5 | 0 |
| 10-28 | 75 | 5 (23) | 198 | 137 | 110 | 25 | 0 |
| 10-29 | 68 | 29 (98) | 190 | 150 | 145 | 9 | 1 |
| 10-30 | 79 | 6 (28) | 130 | 99 | 101 | 4 | 0 |
| 10-31 | 45 | 2 (5) | 74 | 59 | 52 | 7 | 0 |
| 11-01 | 32 | 0 | 35 | 32 | 32 | 0 | 0 |
| 11-02 | 50 | 26 (74) | 161 | 131 | 111 | 5 | 0 |
| 11-03 | 60 | 47 (116) | 190 | 158 | 162 | 13 | 0 |
| 11-04 | 46 | 32 (126) | 201 | 180 | 163 | 10 | 0 |
| 11-05 | 60 | 40 (96) | 188 | 169 | 147 | 8 | 0 |
| 11-06 | 70 | 31 (60) | 201 | 172 | 125 | 47 | 2 |
| 11-07 | 78 | 7 (26) | 140 | 114 | 99 | 30 | 4 |
| 11-08 | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| 11-09 | 38 | 0 | 80 | 58 | 40 | 6 | 0 |
| 11-10 | 77 | 21 (80) | 207 | 165 | 138 | 28 | 12 |

- **v1–v3 (10-19..11-08): 1,638 Swarm-path PRs**, 77% of the 2,123 PRs created in the repository in those days; 266
  of them are batch PRs. Of the 1,372 others, 1,242 landed, 123 were closed without landing (96,647 added lines; an
  upper bound for abandoned work, since #1984 "Batch 10-28 d: 13 reviewed PRs" names no numbers) and **7 are still
  open**: #2108, #3310, #3437, #3550, #3569, #3573, #3578. In all areas, 30 PRs created 10-19..11-07 are still open.
- By phase: v1 (10-19..10-26) 21 Swarm PRs a day; 10-27..10-31, 93 a day; 11-01..11-04, 94 a day; 11-05..11-06, 130 a
  day; v4 (11-09..11-10), about 100 a day.
- Commits touching Swarm paths: v1 180 in 8 days; v2 617 in 11 days (56 a day); v3 78 in one day.

**Share that are repairs** (soft, see section 0):
- Commits 10-19..11-10, batch merges left out (745): 129 are titled `fix`, `hotfix` or `revert` (17%); 86 more are
  worded as repairs. Together 29%.
- Swarm-path PRs (1,861 to 11-10): 176 titled fix, hotfix or revert (9%); 272 more worded as repairs (15%).
- Commits whose message says **hotfix** (whole repository): 1 on 10-27, 1 on 10-30, 4 on 11-05, 1 on 11-06, **10 on
  11-07**, 1 on 11-09.
- By theme, PR titles since 10-19: 57 about a message being delivered or reaching someone; 25 about idle agents.

### 2.5 Releases per day

GitHub releases (CLI, Desktop) and backend tags by publish day:

| Day | Backend | CLI | Desktop | | Day | Backend | CLI | Desktop |
|---|---|---|---|---|---|---|---|---|
| 10-19 | 7 | 4 | 3 | | 10-30 | 6 | 10 | 4 |
| 10-20 | 4 | 7 | 4 | | 11-02 | 10 | 7 | 6 |
| 10-21 | 6 | 11 | 3 | | 11-03 | 5 | 8 | 5 |
| 10-22 | 12 | 11 | 8 | | 11-04 | 13 | 6 | 5 |
| 10-23 | 9 | 7 | 3 | | 11-05 | 11 | 16 | 12 |
| 10-24 | 8 | 5 | 4 | | 11-06 | 9 | 7 | 8 |
| 10-25 | 2 | 1 | 0 | | **11-07** | **15** | **12** | **21** |
| 10-26 | 3 | 8 | 1 | | 11-08 | 1 | 0 | 0 |
| 10-27 | 11 | 12 | 6 | | 11-09 | 11 | 10 | 4 |
| 10-28 | 13 | 13 | 6 | | 11-10 | 11 | 19 | 11 |
| 10-29 | 11 | 10 | 7 | | | | | |

None on 10-31 and 11-01. 10-19..11-07: **155 backend, 155 CLI and 106 Desktop releases, 416 in 20 days** (not all
Swarm; 77% of PRs were).
Backend went `v1.2.85` → `v1.4.40`, CLI 0.4.20 → 0.5.74, Desktop 1.2.91 → 1.4.8. v3's day alone: 48. v4's first two
days: 22 + 29 + 15 = 66.

### 2.6 Plans

`docs/plans/` holds 479 plan files dated 10-19..11-10 (55,455 lines, 590,778 words). **445 are dated 11-02..11-07:**
67, 60, 96, 91, 70 and 61 a day.

---

## 3. Why each version failed

### 3.1 The record of failures, by date

"Root cause" is what the cited source says, unless marked (inference).

**Pre-history**

| Date | What happened | Evidence | Root cause |
|---|---|---|---|
| ≤10-10 | With the first "Swarm collaboration", no message was pushed to a working agent; one worker "lost four messages"; the lead "went back to tmux paste" | `docs/design/2026-10-10-agent-messages.md:19-22` | Delivery waited for an idle agent; `ask` was the only verb; a 20-line introduction with keys |
| 10-17/18 | The study says experiment first, pull not dispatch; the next day a Lead-dispatch product is authorized and built | `docs/research/2026-10-17-one-human-many-agents/README.md:114-121`; `17-super-tab-mvp.md:3`; #1405 | (inference) the study's step was skipped |

**v1 (10-19..10-27)**

| Date | What happened | Evidence | Root cause |
|---|---|---|---|
| 10-21..23 | "18 of 113 agent starts were one person's Lead starting an agent on another person's machine. Each ran as that machine's owner with full permissions… People asked which machine their work went to, asked for work on their own machine, and removed a machine from the Swarm." | `docs/plans/2026-10-24-swarm-team-account.md:7` | Identity never designed: work ran under the machine owner's login |
| 10-22 | "the Lead overrode Jev's pick about half the time: Haiku, a stopping agent on an offline machine, low effort" | `docs/plans/2026-10-22-swarm-rules-routing.md:10` | A hosted model routed without the owner's rules |
| 10-22 | Three message-path holes fixed in one day: input while busy (#1525), a worker's post to its Lead (#1529), a Lead's message to its worker (#1553) | commit titles | The server decided recipients by role and assignment; each case was a patch |
| 10-22..23 | 51 and 47 Swarm PRs a day; the Lead's skill grows from 286 to 2,884 words in a day | section 2 | |
| 10-26 | "One Swarm reached 1.16 MB with 195 work groups and returned 500s on `agent.add` from write conflicts (#1726). The first fix, #1722, only added retries" | `docs/postmortems/2026-10-27-1755-design-rework.md:19-21` | "the original design (#1405…) never asked three questions: how the data grows, who writes concurrently, and how much a client reads per poll" (`:8-9`); "31 PRs changed the same state model" in seven days (`:16`) |
| 10-26 | "A Swarm's **New project** failed on three machines in one afternoon, each time for a different reason, and each failure left the form locked." | `docs/plans/2026-10-26-swarm-new-project-reliability.md:5-6` | Multi-step create with a local journal and no way out |
| 10-26/27 | The rebuild itself: twelve design incidents, "about 14 h" of rework and 29 review rounds; a private chat "reached a terminal that other people could watch" (D9), found only at the whole-branch review | post-mortem `:183-199`, `:248` | Features added to the branch after its design was approved, from "a scratchpad doc attached in chat… no design review and a 05:00 Vietnam time deadline ('working product first')" (`:168-169`) |
| 10-27 | Release: "Every old client getting 426 at release, so all clients had to update together"; machines offline two minutes during the CLI update; "16 tasks are marked lost, and their agents can never be assigned again" | post-mortem `:28`, `:64`, D8f | The new `lost` state was not traced through its readers; a liveness timer judged a restart as a loss |
| 10-27 | "After the v1 release the production backend went to 5 pods with few users": three polls were about 85% of idle load | PR #1785 | Every agent polled every second and loaded the whole Swarm |

**v2a (10-27..10-30)**

| Date | What happened | Evidence | Root cause |
|---|---|---|---|
| 10-27..29 | Chat with PM ships, and is closed two days later: "production held 9 such chats in 4 Swarms, and none had a decision asked in it" | `docs/swarms.md:371-377` | A surface nobody used, replaced by another (Buddy) |
| 10-28 | 198 PRs created in a day, 137 on Swarm; 13 backend, 13 CLI, 6 Desktop releases; 34 commits titled fix | section 2 | |
| 10-29 | "the prod-watch agent's 'Severe, prod: the backend worker has been down' alarm (19:07 VN) and its answers to the Lead's direct questions… all reached nobody; the worker stayed down about 4 h 50 min" | PR #2243 | A post reached the Lead only while its author held the task's active assignment; after a loss "every later post… was stored with **no recipients and no delivery**" |
| 10-30 | 09:06–11:01: "no message a person sends in their Buddy chat reaches the Buddy… 8 of 8 since the deploy, all queued"; "**Nobody could tell**"; the host logged 223 lines naming nothing | PR #2295, #2336; `docs/swarms.md:1187-1188` | A security fix (#2178) made the claim write one part twice, so every claim ended busy; a queued message showed nothing |
| 10-30 | "tasks waited all morning for review… the server refused… The PM worked around it outside the Swarm and told [a maintainer] 'the server blocks it, there is no route'" | `docs/plans/2026-10-30-project-instructions-design.md:9-13` | "how a Swarm project works is fixed in code" (`:7`), enforced in backend and CLI, "and the two drift" (`:17`) |
| 10-30 | The PM "received 486 messages (about 20 an hour)… 198 agents' posts copied to it by the server"; "[A maintainer] watched the PM's terminal receive a message every few seconds, filling Opus's 1M context" | same doc `:24-25`, `:259-262` | Every message goes through one session |
| 10-29..11-04 | The guarded Buddy: "[a team member] stopped using his Buddy after its jobs were refused, and kept a session of his own instead" | `docs/swarms.md:308-309` | A read-only helper beside a person's real session |
| 10-31 | "why do i have 2 buddies?" | `docs/specs/2026-10-31-one-buddy-per-swarm.md:9` | One Buddy per project |

**v2b (10-31..11-04)**

| Date | What happened | Evidence | Root cause |
|---|---|---|---|
| 11-02 | "it looks like a bad buffet rather than a carefully crafted product": a 10-line Status card, banners over the chat, an always-open column of people and "15+ agents", "9 tabs across the top" | `docs/plans/2026-11-02-quiet-swarm-design.md:7-10` | Each feature added its own surface |
| 11-02 | "In 20 minutes… the openharness PM received 23 messages, and 10 of them were notices the server writes on its own" | `docs/plans/2026-11-02-pm-notice-digest-design.md:8-9` | The server's own notices interrupt the hub |
| 11-02 | "a PM opened 'Test: PR #2514' the old way a minute after saving the steps workflow" | `docs/swarms.md:1155-1157` | The PM does not follow the document it has just saved |
| 11-03 | "While an agent's pane shows a question, a Swarm message to it is withheld… The person's answer in the chat never reaches the agent"; "[A person]'s daemon logged `withheld: team_waiting_user` every 1-2 s"; tags: "Four surfaces, two rules" | `docs/specs/2026-11-03-notices-clear-on-answer.md:25-28` | The chat and the terminal are two inputs to one agent |
| 11-03 | lampOS on a Team account: "Could not clone the repository" | `docs/plans/2026-11-03-large-repo-clone-plan.md:25`; issue #2759 | The Team account had no git-lfs and no login |
| 11-04 | "The red number on Activity is too high (11 on 2026-11-04), and most of what it counts does not need him." | `docs/specs/2026-11-04-activity-needs-you.md:8` | Tags, decisions and stuck tasks all counted as "needs you" |
| to 11-04 | "in a day 402 of 437 agent posts reached the product manager as their only recipient, and only 1 named it" | `docs/swarms.md:874-876` | Agents do not name recipients; the default was the hub |
| 11-04 | "the lampOS mobile team needs Flutter and phone signing, which live in the owner's account" | `docs/plans/2026-11-04-owner-account-teammates-work-plan.md:4` | The Team account cannot do the team's real work |
| 11-04 | "every message is a thread… in a regular conversation only some messages turn into threads." Two days later: "i don't know which one you reply to which... why don't you answer in those replies as threads?" | PR #3026; PR #3355 | The reply rule is a line typed into every delivery; changed twice |
| 11-04..06 | **lampOS under the Swarm PM:** "122-193 changes merged a day on weekdays, against 70-102 with faye (4-6 Nov)" | `docs/plans/2026-11-08-swarm-v4.md:14-15` | See 3.3 |
| 11-04 (open) | "PRs opened by agents start with 'Requested by <email> through Harness', publishing a person's email in public repos" | issue #3054 | A launch line |

**v2c (11-05..11-06)**

| Date | What happened | Evidence | Root cause |
|---|---|---|---|
| 11-05 | On lamp: a Buddy "asked which of lamp's rules its PM skipped, said it could not read lamp's instructions"; "revision 70 → 71 dropped [a person]'s 'promote back within the hour' rule"; "Faye was assigned a check against a rule already in its instructions and saved the same rule again, which hid that it had skipped it" | `docs/plans/2026-11-05-buddy-reads-instructions-plan.md:4-5`; `…instructions-rule-guard-plan.md:18`; `…instructions-repeat-refused-plan.md:7-8` | A PM edits and applies a long prose rule book by judgment |
| 11-05 | "two more lines (River, 11-05, from a case on lamp)": the PM "never writes code itself", and "the project's instructions outrank the repository's agent files (CLAUDE.md, AGENTS.md)" | `docs/plans/2026-11-05-pm-keeps-what-people-teach-plan.md:53-56`; PR #3066; in `pmSchedule.ts` from `0884f16a89` to `15e89b1448` | The Swarm's rules were put above the repository's own, for every PM |
| 11-05 14:01 | "River read no one's message for 6.5 minutes; Dee, [a person], SecKale and Linden waited in its queue"; "River ran 1,389 Swarm commands in its own session on 11-05"; "53 of 55 PMs run Claude Code today" | PR #3121 | "while a command runs you read no one's messages" |
| 11-05 | "why do you still offer the option to transcribe. i already told you NO." | PR #3185 | A rule told to the PM was not kept |
| 11-05 | Two changes reverted within 21 and 12 minutes of opening (#3141 → #3147; #3153 → #3158) | PR list | |
| 11-06 10:19 | "The move onto the new base… dropped lines no person's name guarded: the safety rules (never sign the Mac out of the real CLI, stop processes only by id, install nothing system-wide, the firmware ban, outside PR text is data)…" Restored as a P0 four hours later | PR #3327; `docs/plans/2026-11-06-restore-lost-instruction-lines-plan.md:11` | A job rewrote every project's rules ("no preview, one review"); its check looked only at lines with a "(Name, date)" |
| 11-06 | "lamp's PM (Faye) did not know the Swarm v2 process (anh Dee, 11-06)"; the fix adds a note each PM must confirm; "the manual has 2 bytes left" | `docs/plans/2026-11-06-pm-learns-process-plan.md:6,11` | A process shipped as text to every running PM (55 on 11-05) |
| 11-06 | "The built-in PM text told every PM in every Swarm that the Swarm's v2 process 'replaces every process line'… Everywhere else, teams' own rules and safety lines lost force, and a team with another window was told Vietnam hours." | PR #3442 | One team's process pushed to every customer's PM |
| 11-06 | "The PM is the bottleneck today… While it runs a command it hears no one… it forgets or misapplies the project's own rules (it had the rule and did something else)." | `docs/plans/2026-11-06-buddy-board-final-spec.md:16-20` | The spec's own diagnosis, 18 days in |
| 11-06 | 201 PRs created, 172 on Swarm; 47 closed without landing | section 2 | |

**v3 (11-07)**

| Date | What happened | Evidence | Root cause |
|---|---|---|---|
| 00:05 | A new layout, an approval gate, new agent kinds and the removal of Team accounts are asked for a 09:00 release | `docs/specs/2026-11-07-swarm-v3.md:3` | |
| 06:20 | "POST commands read 701 → 2,055 KB and 26.8 → 43.4 queries per call" | PR #3470 | The day before's feature: "Once anyone in a Swarm has a second Buddy that went quiet, every command there read the whole Swarm twice" |
| 09:20, 16:20, 17:20 | "POST commands p95 3,574 ms (target 475)"; a read "cost agents × people × conversations, and grew with tab data while the code stayed the same" | PRs #3497, #3543, #3564 | Hot paths reading the whole Swarm |
| morning | Acceptance: "**Overall: PASS**… It does not claim a native-window/IME, live provider sign-in, production deployment, Windows session or phone check." | `docs/testing/2026-11-07-swarm-v3-acceptance.md:3,79` | Layers with fakes |
| day | The audit of Desktop 1.3.89: 21 findings, 7 High: "Clicking a card on the Board opens nothing", "The first 'Bring agent' always fails for a new joiner", "One refused Approve locks every card in the Tasks pane" | `docs/audits/2026-11-07-desktop-1.3.89.md:36,48,61` | |
| 12:59 | "how do we design you right?"; "anh Dee's asks sitting unshipped for six hours on 11-07"; "anh Dee: v3 from 5/10 to 10/10" | PRs #3522, #3477 | Hand-offs between engineer, PM, release |
| 18:35 | "Most of the day's problems were agents not following prompts: Leads picking against the routing rules, cancelling people's cards, posting notices into private chats." 657 rules counted | `docs/prompt-rules-audit.md:3-5,44-51` | |
| 19:05 | "I don't want River or Theo to show up in this chat." | PR #3555 | Agents and the server posting in a person's private chat |
| 19:55 | P0: New agent stopped with "This project is no longer available…", and "'Remove this request?' came back until Discard anyway was pressed three times"; on another Mac, "No agent of his joined, and Mac 3 ran no harness" | PRs #3567, #3580 | v3's Member took the project path |
| all day | 10 hotfix commits; 15 backend, 12 CLI and 21 Desktop releases; 114 Swarm PRs | section 2 | |

**v4 so far (11-09..11-10)**, for section 4

| Date | What happened | Evidence |
|---|---|---|
| 11-09 09:21 | "people could not talk to their agents ('Not sent: This session is stopping'). The v3 time checks stopped any Builder idle for 15 minutes" | PR #3586 |
| 11-09 | "i dont see any agent to agent chat btw. is that happening?" | PRs #3652, #3666 |
| 11-10 | "swarm-sandbox #24-#26 got one note 46 times each"; the loop guard then dropped Harness's own ask: it "never reached Juno, and #24 waited. I re-posted the ask by hand" | `cli/src/superTabs/githubMerge.ts:79`; issue #3813 |
| 11-10 | A reviewed, green PR "has not merged since 09:33. Nobody was told why." | issue #3787 (open) |
| 11-10 | "can't delete project lamp?"; "i cant create a project" (clone of lampOS); New Project "sat on 'Starting…'… for minutes… with no way out but quitting the app" | PRs #3873, #3874, #3886 |

### 3.2 The groups, and how often each recurs

| | Group | Pre | v1 | v2a | v2b | v2c | v3 | v4 |
|---|---|---|---|---|---|---|---|---|
| a | Messages or wake-ups that did not arrive; agents left stopped or idle | yes | yes | yes | yes | yes | yes | **yes** |
| b | Amount and churn of instruction text; Swarm rules over the repository's | yes | yes | yes | yes | yes | yes | **starting** |
| c | Load on people: decisions, approvals, notices, inboxes | | yes | yes | yes | yes | yes | less |
| d | A second task system beside GitHub | | yes | yes | yes | yes | yes | avoided |
| e | PM / Lead / Buddy: bottleneck, wrong calls, role confusion | | yes | yes | yes | yes | yes | partly |
| f | Server state machines against what agents do | | yes | yes | less | **most** | yes | **yes, moved to the daemon** |
| g | Identity and accounts | | yes | yes | yes | yes | removed | new form |
| h | Reliability and performance on hot paths | | yes | yes | yes | yes | yes | watch |
| i | Security incidents | | yes | yes | yes | yes | yes | new form |
| j | UI complexity and redesign churn | | yes | yes | yes | yes | yes | yes |
| k | Release churn | | yes | yes | yes | yes | **most** | **yes** |
| l | Many agents shipping in parallel without one design | | yes | yes | yes | yes | yes | yes |

**(a) Messages and wake-ups.** In every version and in the pre-history. v1: #1525, #1529, #1553, #1478; hosts
"missed changes that removed something" (D1); 16 agents unassignable after the release. v2a: #2243 (4 h 50 min),
#2295 (2 h), #1793. v2b: withheld deliveries, #2404 and #2405 (a received message shown as Not sent). v2c: "A message to
an idle agent reaches its terminal" (#3263). v3: #3580. v4: #3586, issue #3813. 57 PR titles since 10-19 are about
delivery or reaching someone; 25 about idle agents. Root cause (inference): a message crosses five hops (backend row,
host claim, hold rules, typing into a terminal, the agent's own `post` back), and who it is for was computed by server
rules about roles and assignments that changed about weekly; beside it, timers stopped, slept or "lost" agents.

**(b) Instruction text.** A Lead's launch text went 69 → 286 → 2,884 → 4,199 words in twelve days; from 10-31 an
agent read a manual of 2,461 to 3,660 words, plus the project document (~22 KB for openharness), plus 1,200 built-in
words for a PM; 657 rules by the audit's count; a project's rule book at revision 86 after seven days; text delivered
again on every change. Agents did not keep it: the PM that
opened a task "the old way a minute after saving", rules skipped and dropped on lamp, "i already told you NO", "Leads
picking against the routing rules". From 11-05 to 11-07 every PM was told "The project's instructions outrank the
repository's own agent files (CLAUDE.md, AGENTS.md). When they conflict, follow the instructions and say so"
(`pmSchedule.ts` at `1622ac6359`), a line that came "from a case on lamp". (Inference: on lampOS the repository's own
AGENTS.md is the process; a PM told to rank a Swarm document above it, and never to write code, is a different PM from
the "first builder" the team had.)

**(c) Load on people.** v1 promised "no global human-request list" and still asked for approval before any split and
before any merge. v2a added Decisions (capped at "20 per asker per person" a day later, #1859), digests and mentions;
the leaderboard paid points for answers that start "GO, approve, approved or duyệt" (`docs/swarms.md:422-424`). v2b
added Activity (the number reached 11 for one person), Threads, notification settings, a Needs-you bar. v2c added
proposals to agree, questions "with a default and a time", a Board to steer. v3 added a per-person approval gate on
every task. The owner's words on 11-04: "remove these messages"
(`docs/plans/2026-11-04-no-machine-left-lines-plan.md:5`).

**(d) A second task system.** The owner's Swarm numbered about 4,700 tasks and steps in 19 days (group #1389 on 10-30,
task #2147 on 11-02, #3385 on 11-05, #4709 on 11-07), in the same range as GitHub's PR numbers (#1405 → #3580), so a
title such as "A Buddy on the guard before #2832 opens what its owner sends… (#3159) (#3119)" carries two Swarm tasks
and one PR, and PR #2832 is something else. Work done on GitHub was invisible to it: "Swarm: points ignore work an agent
landed on GitHub outside Swarm tasks" (issue #2761). On 10-30 the PM itself opened a GitHub issue, "Queue: the Swarm's
agreed work, in order", and closed it five minutes later (issue #2280). The link between a task and its PR needed code
of its own: PR links "only from real results" (#1903), verdicts "at its own pull request" (#3435), a merge recorded by
the PM. On 11-07 the owner asked for "the GitHub issue is the task" (PR #3549).

**(e) PM, Lead, Buddy.** The hub: 486 messages a day; 23 in 20 minutes; 6.5 minutes deaf; 1,389 commands in a day.
Every remedy kept the hub and added a role around it: Chat with PM (10-27), Buddy (10-29), one Buddy per Swarm
(10-31), a full-access Buddy (11-04), several Buddies and "the PM never chats with people" (11-06), the Buddy is the
agent you joined with (11-07 00:05), "no separate Buddy" (11-07 16:10), a 1:1 chat with every agent (11-08): a
person's own line to the work was defined eight ways in twelve days. Five kinds of agent stood on 11-07.

**(f) Server state machines.** Each was added, removed and added again:
- *Idle stop:* added 10-27 (#1807); removed 10-31 ("The server stops no agent", `docs/swarms.md:954`); back on 11-05
  ("requests idle Engineers' stops", built-in PM text); it stopped people's v4 agents on 11-09 (#3586).
- *Review steps:* opened by the server from 10-28 (`autoReview.ts`); "the automatic review step" removed 10-31
  (`docs/swarms.md:517`); "Review and test steps open by themselves" again on 11-06 (the v2 text, #3299; #3312).
- *Refusals:* eleven named refusals removed on 10-31 so that no agent says "the server blocks it"
  (`docs/swarms.md:519-523`); "Rule refusals may use plain code names again" on 11-06.
- *Routing:* a hosted model (10-19), owner rules (10-22), a policy with quality floors (to 10-30), advice only (10-31), no
  ranking at all (11-04, #3010), "The route picks by the Routing order" (11-06, #3296), "Pick agents in code" (11-07,
  task #4546), a solver (v4): eight designs.
- *Lost and dormant tasks:* "`lost` needed six fixes" (`docs/feature-design-rules.md:131`).
- *Crew, lanes, dispatch, nudges at two hours, take-back at three, sleep after an hour, merge train:* all of 2c, built in
  two days, removed five days later (#3847, #3877).

**(g) Identity and accounts.** v1 ran teammates' work as the machine's owner. The answer, a hidden "Harness Team"
macOS user with a second daemon and a GitHub App, cost 20,126 lines and 65 files at its peak and its own stream of
failures: 25 plans dated 11-02..11-07 have "team" in their name (setup lock, relay "survives restart", "survives
update", "never signed out", Windows audits), issue #2760 "one machine without a Team account makes route
fail for the whole project", issue #3086 "Team-account agents… can't reach their model", the lampOS clone, the lampOS
mobile team. Removed in v3 ("Remove:… Team accounts") and v4.

**(h) Hot paths.** 10-26 (1.16 MB, 500s); 10-27 (5 pods at idle); 46 PRs titled `perf(…)` or `fix(backend)` between 10-28
and 11-05; 11-04 "32% of DB time" in one poll (`docs/plans/2026-11-04-changes-poll-reads-plan.md:7`);
11-05 "45% of process CPU" in the Prisma engine (`docs/plans/2026-11-05-prisma-engine-cpu-plan.md:3`); 11-07 three
hotfixes. Each new feature read the whole Swarm again.

**(i) Security.** A private chat on a watchable terminal (D9); work as another person (18 of 113); chat files on a
public address until a release step that had not happened ("The guarantee starts only when the bucket goes private",
`docs/swarms.md:716`); the Buddy's window check, which three listed tricks evade (`docs/swarms.md:268-274`) and which on
Windows "is whatever the shell says it is" (`:275`); "Security fixes from the v3 review: guest quota, chat rights on
rejoin, secret patterns" (#3467); safety rules deleted by the rebase; emails in public PR bodies (issue #3054);
"No secret in any agent post…" still open (#3310).

**(j) UI.** Ten layouts of the Swarm screen in 22 days: flat sidebar (10-19); Projects and Machines groups (10-22);
"like a chat app" then "in Slack's order" (10-27, #1783, #1792); Buddies, threads, Cmd-K (10-29); Activity and Threads
views (10-31); Quiet Swarm (11-02, six PRs); Tasks board, Threads/Mentions/Decisions in the sidebar, a Needs-you bar
(11-04/05); Board first with six columns and the Buddy at the right (11-06); v3's three panes, then five restyles the
same day (#3460, #3464, #3536, #3539, #3563); v4's tab (11-09).

**(k) Releases.** 416 in 20 days; 48 on v3's day. The first release forced every client to update (426). A release
window (09:00–18:00 Vietnam time) was planned on 11-05, written into every PM's text on 11-06, lifted on 11-07 and
removed on 11-09 (#3618).

**(l) Process.** About 80 Swarm PRs a day from 10-28, by agents working in parallel on one model: "31 PRs changed the
same state model" in a week; 445 plans in six days, each with its own Design section and no shared one; the Buddy/Board
spec lists seven areas of "Work in progress that needs replanning" (`:310-322`); 123 PRs closed without landing.

**Groups not on the list.**

- **(m) Deadlines by the clock, at night.** "a 05:00 Vietnam time deadline ('working product first')" (10-26); "release
  today" (11-06, `buddy-board-final-spec.md:246`); "at 00:05… for the 09:00 Vietnam release" (11-07); "do it all
  tonight" (11-09, PR #3711).
- **(n) Proved with fakes, broken for people.** The MVP's own record: "Native interaction, physical shortcut/IME and
  full terminal acceptance remain unverified" (`docs/plans/2026-10-18-super-tab-build.md`); v3 passed acceptance and
  failed its audit the same day.
- **(o) The Swarm built the Swarm, in production.** The openharness Swarm's PM (River) ran the team that changed the
  PM. Its outages stopped their own repair: the lost alarm, the deaf PM, the lost safety rules.
- **(p) Added, never removed.** Product code was larger at each of the eleven points measured from 10-19 to 11-08
  (section 2.1). The first PR to take out much more than it adds is #3574 on 11-07 23:03 (+785, −3,562).
- **(q) No outside measure until the end.** Fixes were judged per incident. The one number from a team outside
  (lampOS, 122–193 a day against 70–102) appears in the record on 11-08, in the plan that replaces everything.
- **(r) Prose read by code.** Attributions "(Name, date)" parsed in four date forms to guard rules (#3112); a Buddy's
  consent recognised by a quoted line after "I'll post this as you:"; approvals recognised by "GO, approve, approved
  or duyệt". Each needed repairs.

### 3.3 Why each version failed, in a paragraph

- **v1** was a different product from the one the study recommended, built in a day, with its state in one document.
  It failed on storage at a week old (10-26), on identity (teammates' work as the owner) and on the hub: the Lead had to
  be told, and had to tell, everything. Its rebuild shipped more features on a deadline and broke production for
  agents the same morning.
- **v2** answered each v1 failure with a new subsystem and kept the hub: Decisions, Buddy, Team accounts, a GitHub App,
  digests, an instruction document, steps, Activity, then crew, lanes, dispatch, a merge train, a Board, proposals. It
  moved the rules from server code to prose (10-31) and back to code (11-06). The code grew fivefold (37,868 →
  199,292 lines), the PM stayed the bottleneck, people got more to answer, and the one outside team's output fell by a
  little under half (inference from the two ranges in the v4 plan).
- **v3** was requested at 00:05 for a 09:00 release. It was a new face and three structural changes on top of v2c,
  proved with fakes. The owner could not start an agent that evening, and two further redesigns were approved before
  midnight.
- **Common cause (inference).** Authority sat in a server model and one LLM session per project, not in the repository
  and GitHub where the agents and people already worked. Every gap between that model and what agents do became a
  patch; nothing was taken out; and the people meant to use it received about 21 releases a day.

---

## 4. The decisions that set each version on its path, and what v4 repeats

### 4.1 The decisions

| # | Date | Decided | Why it seemed right (the doc's words) | What it cost |
|---|---|---|---|---|
| 1 | 10-10 | Agents get one verb, `harness send`, and nothing else | "So the product needs a safe doorbell, and nothing more." (`docs/design/2026-10-10-agent-messages.md:33`) | Nothing: it was dropped a week later. It is the nearest ancestor of v4. |
| 2 | 10-17 | Swarm is its own product with **native tasks** | "The coordination thread outgrew what agents can read… 50 admissions of a missed message" → "native tasks with leases, an inbox per agent with read state" (`04-bottlenecks.md:42,160`) | A second task system beside GitHub (group d): 4,700 Swarm tasks, links and verdicts to keep in step, a Board, a leaderboard blind to GitHub |
| 3 | 10-18 | A **Lead** that people talk to and that delegates; the **backend owns** conversations and work state | "Hierarchy beats peers in every serious report" (`README.md:86`); "Closing the owner's app does not remove coordination" (`17-super-tab-mvp.md:170`) | The hub (group e), and every delivery rule in group a. The same study had said "builders pull their next task instead of waiting for the lead" and "experiment, not more design" |
| 4 | 10-18 | State as one document, with no design check | none written: "The spec had no design-check step" (`docs/postmortems/…:9-10`) | 10-26 outage; the rebuild; 426 for every client |
| 5 | 10-22 | The **server enforces** the owner's rules and the flow | "The rules also lived only in the Lead's head. They move into the Swarm. The system enforces the hard ones" (`docs/plans/2026-10-22-swarm-rules-routing.md:12-13`) | By 10-30: "the server blocks it, there is no route"; each change "needed code, review and a backend release" |
| 6 | 10-22/23 | Built-in role skills, "The owner's texts, used verbatim" | "Ship built-in Lead and DEV skills… without requiring a plugin" (`docs/plans/2026-10-22-swarm-lead-dev-skills.md:6`) | Group b: 286 → 2,884 words in a day; 71 commits to the file in 16 days |
| 7 | 10-24 | Teammates' work runs in a hidden **"Harness Team" macOS user**, pushing with a **GitHub App** token | "It keeps native toolchains (Xcode, Flutter desktop), costs one admin password, and separates company work from personal data" (`docs/plans/2026-10-24-swarm-team-account.md:9`) | 20,126 lines; 25 repair plans; the lampOS mobile team still needed "Flutter and phone signing, which live in the owner's account"; removed after 14 days |
| 8 | 10-26 | Ship new features on the storage-rebuild branch, by a night deadline | "working product first" (post-mortem `:169`) | D8–D12: 7.5 h after the whole-branch review, a private-chat leak caught late, 16 agents blocked in production |
| 9 | 10-29 | A **Buddy** per person replaces Chat with PM | Chat with PM was unused: "9 such chats in 4 Swarms, and none had a decision asked in it" (`docs/swarms.md:377`) | 100 files, 34,197 lines; redefined repeatedly; a guard that made its first users stop |
| 10 | 10-30 | **Rules move to a prose document**; "The server locks no role, workflow or routing rule" | Anti-goals: "An agent answering 'the server blocks it'… A behavior that exists only in code, so a member cannot change it in words" (`docs/plans/2026-10-30-project-instructions-design.md:77-78`) | 657 rules; a 22 KB document; PMs skipping and dropping rules; a parser to guard prose; reversed in seven days |
| 11 | 11-05 | The "Swarm redesign": **code over prompts**, a standing crew, lanes, **server dispatch**, a merge train | "an ask never waits unseen because one agent hung" (`docs/plans/2026-11-05-server-checks-and-pm-watchdog-plan.md:5`); "The server, not the PM, gives work to the crew" | Built in two days by parallel agents, removed five days later; "lamp's PM (Faye) did not know the Swarm v2 process" |
| 12 | 11-06 | One built-in process for every project: "ALL OF THEM", "REPLACE 100%", no preview | "A rule a program can check belongs in code, not in your instructions" (v2 text) | Safety rules lost for four hours; "teams' own rules and safety lines lost force" in every other Swarm (#3442) |
| 13 | 11-06 | People stop talking to the PM; Buddies, proposals and a Board | "The PM is the bottleneck today" (`buddy-board-final-spec.md:16`) | "This is a large change" (`:10`); superseded the next day |
| 14 | 11-07 00:05 | v3, for a release nine hours later | "Change only the delta to the existing Desktop UI" (`docs/specs/2026-11-07-swarm-v3.md:3`) | 21 audit findings, 10 hotfixes, 48 releases, the owner blocked |

Two things the decisions share. Each answered the last failure by moving authority (Lead → server → prose → server →
Buddy and Board), and none removed what it replaced. And several had the opposite advice on record when they were
taken: decision 3 against the study of the day before; decision 12 against the 10-30 rule that the template's
improvements are "offered to the PM as a suggested change, never applied silently"
(`project-instructions-design.md:172-173`).

### 4.2 v1–v3 patterns already visible in v4 (8–10 November)

Counts are for Swarm-path PRs created 11-09 and 11-10 (223; 199 without batch and integration PRs), from titles;
the split is by keyword plus a hand list, so read the numbers as approximate.

**1. The code is growing again, inside the old modules.** The plan: "v4 is a small new Swarm and the old one is deleted
whole… **Backend:** one small module" (`2026-11-08-swarm-v4.md:84-88`). In 2.5 days v4 added 11,316 lines of product
code in 56 new files (Desktop 6,073 in 22; CLI 3,562 in 13; backend 1,373 in 19; phone 308) and about 24,900
insertions in the four trees with their tests, against 95,559 deletions. The removal is piece by piece (slices S0 to
S15, several still open: #3859, #3884), not whole: `backend/src/superTabs` is still 32,210 lines of code with
`buddies.ts`, `crew.ts`, `dispatch.ts`, `instructions*.ts` and `taskApproval.ts` in it; `cli/src/superTabs/host.ts` is
2,514 lines (2,663 at the end of v3) and still branches on Buddy; `desktop/lib/swarm/` was never made. The four trees
still hold 159,038 lines of product code, 77% of the v3 peak, and the phone's 58,999 lines are almost untouched.

**2. Instruction text has come back, and is churning.** The rule, in AGENTS.md: "Agents start as plain Claude Code or
Codex with default settings: no Swarm instructions, skills or manual." The code, a day after #3585: `SWARM_BASICS`,
302 words on 11-09 21:52, 507 by 11-10 19:54 (five versions), plus 143 for a PM, placed "In the engine's own
instructions (Claude Code's --append-system-prompt, Codex's developer_instructions)" (`cli/src/lib/swarmSkills.ts:83-84`),
where a person reading the terminal does not see it. The reason given echoes 11-06's one process for every project:
"the Swarm's basics are the product's, not each repository's to copy" (`:81-82`). The re-send machinery is back too: "an agent started before the
team's basics changed is told the new ones once" (#3669), "told the team's basics once" on attach (#3642, #3654).
`docs/prompt-rules-audit.md:110-114` already records a v4 prompt line kept "only until code does it". The difference
that matters: v4's text says "your project's AGENTS.md comes first where it differs".

**3. A state machine decides who does what, with timers that take work away.** lampOS's process as the plan gives it:
"the PM assigns, the agent takes the next on its list the moment it is free" (`:35-36`), and "Code does the mechanical
steps… merging when approved and green, lamp and device booking, status" (`:45-46`). Built on day one instead: an
assigner that treats the team as "a multi-mode resource-constrained project scheduling problem: NP-hard", solved by
"Simulated annealing… Four chains" (`docs/design/2026-11-09-swarm-v4-assignment.md:29,39-41`), asked for by the owner
that day ("lets write the best algo", PR #3624). Around it: lists "two deep" (the plan says 3); tasks taken back after
30 minutes or 3 hours of a machine being down, and after 4 + 4 quiet hours; another reader asked "after 2 silent
hours"; learned task times; a "Works on:" line that weights the plan. This is 2c's crew dispatch (lanes, a nudge at
two hours, take-back at three, `liveness.ts` leases) under the same file name (`assign/crew.ts`), running in the PM's
person's daemon and writing GitHub labels instead of Mongo rows. The Python scheduler of 10-27 (#1756, "exact global
assignment of tasks to machines and models") was deleted at 19:22 on 11-09 (#3621, −7,186 lines) and a TypeScript
one merged at 23:07 (#3624, +1,665).

**4. Many small repairs to prose and label parsing.** About 62 of the 199 PRs repair v4's own new behaviour, and 24
of those repair how GitHub text, names and labels are read: a `READ-OK` that is quoted, talked about, unsigned, on an
earlier head or in a review body (#3722, #3803, #3809, #3823, #3830); names in lower case, two words, three words, any
script (#3690, #3708, #3760, #3816); the newest thirty PRs against all of them (#3693); the first read's look-back
(#3692); a note said "46 times" (#3819). `githubMerge.ts` now carries lampOS's `markers.py`, `train-bot.sh` and
`merge-when-green.sh` rule by rule, "each rule from a pull request held or merged wrongly" (`:44`). This is group r, and
v2's attribution parser, again.

**5. Messages lost and work waiting in silence, on day two.** #3586: people's agents stopped by a leftover v3 timer.
Issue #3813: Harness's ask "never reached Juno, and #24 waited. I re-posted the ask by hand." Issue #3787 (open): a
green, reviewed PR "has not merged… Nobody was told why", because Attach had renamed the agents and the merger knows
the team by name. The plan's acceptance is "Every message reaches its agent" (`:99`).

**6. The whole state is polled, close to its limit.** The assigner runs "Every minute"
(`2026-11-09-swarm-v4-assignment.md:78`) and the merger every 30 seconds (`githubMerge.ts:30`), each reading every
open issue and pull request. The design doc says so itself: "lampOS had 259
open (2026-11-10), against the 1,000 ten pages hold, so a busy repository is far less than 10x from that limit"
(`2026-11-09-swarm-v4-assignment.md:176-179`). That is #1405's pattern (group h), and
`docs/feature-design-rules.md` rule 2 says to review the design "when a measured limit is less than 10x away". It is
softened by ETag reads that cost nothing when unchanged (`githubRest.ts:1-6`).

**7. One point of failure per project.** The assigner and the merger "run in the Harness of the person whose agent is
the project's PM" (`…assignment.md:3-4`). #3685 keeps them going "while its PM is stopped". (Inference: when that
person's computer is asleep or offline, nothing is assigned, no reader is asked and nothing merges.) The 10-17 study:
"most of the cost came from things there was only one of: one reviewer… one lead dispatching" (`README.md:20`).

**8. Identity moved into prose.** Every agent of a person posts on GitHub "as your person: start every post with your
name" (`SWARM_BASICS`). Whether a review is independent is therefore read from a name an agent typed. Five PRs in two
days are about an author passing as its own reader (#3665, #3690, #3708 still open, #3722, #3760), three of them marked
security. v1–v3's identity problem was the machine owner's login; this is its v4 form.

**9. Features beyond lampOS's process.** Not in the plan's five steps, built in the first two days: the solver,
learned task times, cores in machine reports (#3680), "Works on" focus (#3655), reader assignment by model family
(#3663), label creation (#3682), GitHub cards in a 1:1 chat (#3625), an Info pane (#3748), every pane as an agent of a
Personal Swarm (#3649, #3710), Attach (#3641), a pull-request board (#3871), phone pushes for 1:1 chats (#3811),
instructions edited from another computer (#3619, #3635), a new leaderboard read by each daemon (#3658, #3672). Most
carry an owner's quotation dated the same day.

**10. The plan and the product have already parted.** "**Tasks** live in Swarm" (plan `:34`) against GitHub issues
(#3598); "at least 3 deep" against two; "Only agents post; people read" against a server that "still takes a person's
post" (readiness row 25, draft #3675); "No Buddy" against a 1,941-word Buddy skill still in `swarmSkills.ts`. One
issue, one PR, "Closes #N" is assumed by the board and the merger, while PR #3869 records "lampOS's last 197 builder
pull requests: 1 linked to an issue on GitHub, 106 naming two or more numbers". And agents first talked on GitHub, not
in the channel: "i dont see any agent to agent chat" (11-09); the basics were rewritten on 11-10 to move the talk
("channel chat here replaces the queue").

**11. Release and night-shift pace.** 66 releases in two days (22 backend, 29 CLI, 15 Desktop), more a day than
v1–v3's average; 165 Swarm PRs on 11-10; "do it all tonight" (PR #3711); a hotfix 62 minutes after the first v4
release.

**12. Proof by fakes.** Readiness, 11-10: assignment and merging are "spec only (fake GitHub)" (rows 17, 19); eight of
33 flows have a MISSING part; the journey on the real backend "its first steps pass" (`:67`). The plan's acceptance,
"on two machines… until something concrete ships" (`:98-99`), is not recorded as passed. On the owner's own machines
on 11-10: "i cant create a project", "can't delete project lamp?".

**13. A long compatibility tail.** 32 retired commands answered until 2026-12-09; a no-op shell-guard entry and App
push tokens until 2026-12-10; the phone and older Desktops still send v3 commands (issue #3786: "a person's edit does
nothing").

### 4.3 What v4 visibly avoids

- **No second task system:** tasks are GitHub issues, read with each person's own `gh`; `TASKS_RETIRED`: "Tasks are
  GitHub issues now." (`backend/src/superTabs/retired.ts:40`).
- **No hub that everything passes through:** agents are named with `@Name`; a person's words in a 1:1 chat are typed
  exactly (#3627); no Decisions, Activity, Mentions, proposals, approvals or Accept/Decline.
- **One identity:** "an agent runs only under its own person's login on its person's machine"; Team accounts, the
  GitHub App for new agents and the shell guard are gone.
- **The repository's rules first**, and per-agent rules in `agents/<name>.md` in the repository, not in a server
  document with revisions.
- **A shrinking backend:** command types 137 → 106 with two new ones; models 46 → 38; no server job runs the flow
  (#3603, #3667).
- **Net deletion:** product code −48,208 lines (−23%) and, with tests, about −141,600 lines in 2.5 days.
- **Failures are named** in the new GitHub paths (`GitHubStop` codes, "said once"), and a real-backend journey test
  exists (`cli/e2e/swarmV4Journey.e2e.ts`).

---

## 5. What v1–v3 got right, and where it lives now

| Keep | Why | Where (at `82a6c9a9ec`) |
|---|---|---|
| **Machines:** contribution, memory-based slots, live/late/offline, removal with cleanup | "A machine takes an agent only when it has the memory, disk and tools the job needs" is the product's second line; liveness is tested end to end | `backend/src/superTabs/machines.ts`, `machineReports.ts`; `cli/src/superTabs/contribution.ts`, `capacity.ts`, `reservations.ts` (the reservation ledger); `desktop/lib/super_tabs/machines_manage.dart`, `machine_status.dart`; `backend/integration/superTabMachineLiveness.test.ts`; the state table in `docs/swarms.md:175-181` |
| **Membership and join:** invitations, join links, auto-join by domain | Proved by Desktop join tests and two integration suites (readiness row 31) | `backend/src/superTabs/autoJoin.ts`, `autoJoinDomain.ts`, `members.ts`; `desktop/lib/super_tabs/join_dialog.dart`, `join_link.dart` |
| **Switch PM** (engine, account or computer) | Kept by the v4 plan; e2e `swarmSwitch.e2e.ts` | `backend/src/superTabs/leadStart.ts`; `cli/src/superTabs/leadSwitch.ts`, `leadSwitchRequest.ts`; `desktop/lib/super_tabs/switch_pm.dart` |
| **Leaderboard** | Kept by the plan; v4 counts shipped PRs instead of activity | `backend/src/superTabs/leaderboard/`, `shipping/`; `cli/src/superTabs/shipping.ts`; `docs/plans/2026-11-09-swarm-v4-leaderboard.md` |
| **Storage in parts** and its read path | The one piece with a design, a review and a post-mortem; v4 reuses it: "nothing new is stored, so there is no migration" | `backend/src/superTabs/parts/` (23 files), `read/` (28), `cache.ts`; `cli/src/superTabs/partsStore.ts`, `hostFeed.ts`; `docs/design/2026-10-26-swarm-state-parts.md` |
| **Delivery that says why:** claim, lease and receipt; "Not delivered yet"; a withheld reason after 30 s; a claims-failing alarm | Bought with the 10-29 and 10-30 incidents | `backend/src/superTabs/deliverySettle.ts`; `cli/src/superTabs/withheld.ts`, `host.ts reportWithheld`; `desktop/lib/super_tabs/message_receipt.dart`; `docs/swarms.md:1161-1188` |
| **Security guards:** credentials removed from chat before storage; confidential sessions; private projects; signed file links; one access predicate per read; delete with a 7-day restore | Each closes a real leak (D9, the pasted credential, public file addresses) | `backend/src/superTabs/credentials.ts` (`redactCredentials`), `confidential.ts`, `fileLinks.ts`, `deletion.ts`, `purge.ts` |
| **Swarm as a subsystem the daemon runs without** (`HARNESS_SWARM=off`) | Keeps the core small | #1765; `cli/src/superTabs/inCore/`, `inServices.ts`; `docs/swarms.md:1220-1246` |
| **Test rigs** | The only way these flows are tested without a person's machine | `cli/e2e/` (real daemon, private tmux, `harness/fakeEngine.mjs`; `superTabs.e2e.ts`, `swarmV4Journey.e2e.ts`, `harness/realBackend.ts`); `backend/integration/superTab*` on a throwaway MongoDB replica set; Desktop tests on a memory store with a fake sign-in |
| **The design check and the post-mortem habit** | "The design review with code citations found 6 issues in 9 minutes, before any code" (post-mortem `:270`) | `docs/feature-design-rules.md`; AGENTS.md "Data and design"; `docs/postmortems/` |
| **The retirement pattern** for old clients | Old apps get one constant answer and a counter, with a date to delete | `backend/src/superTabs/retired.ts` |
| **The 10-10 and 10-17 documents** | They state v4's conclusion and its risks before any of this was built | `docs/design/2026-10-10-agent-messages.md`; `docs/research/2026-10-17-one-human-many-agents/` (04, 08, 13, 14) |

Not worth keeping, by the record: the Team account (20,126 lines for a need v4 removes), the stored instruction
document and its guards, the PM's built-in schedule, Buddy as a kind of agent, the merge train on the server, the
routing policy and its eight designs.

---

## 6. Timeline

| Date (ICT) | Version | Event | Source |
|---|---|---|---|
| ≤10-10 | pre | "Swarm collaboration" (tab channels, agent teams): no push to working agents | `docs/design/2026-10-10-agent-messages.md:3,19` |
| 10-10 | pre | Agent Messages designed: "a safe doorbell, and nothing more" | same `:33` |
| 10-11 | pre | `harness send` merged; Swarm collaboration removed | #1159, #1161, #1165 |
| 10-17 23:17 | pre | Study merged: review and merge set output; experiment first; pull | #1397 `867ca20632` |
| 10-18 | v1 | Super Tab MVP "Implementation authorized" | `17-super-tab-mvp.md:3` |
| 10-19 08:55 | v1 | #1405 "Build Super Tab shared conversations"; backend `v1.2.92` | `343d517362` |
| 10-19 | v1 | Routing by a hosted model | #1424, #1431 |
| 10-20 | v1 | Private projects, Cmd-S, the name Swarm | #1464 |
| 10-21..23 | v1 | 18 of 113 starts run as another person's machine owner | `2026-10-24-swarm-team-account.md:7` |
| 10-22 | v1 | 60 Swarm commits: skills, five-part tasks, Reviewer role, owner rules replace the model router | #1533, #1517, #1568, #1586 |
| 10-23 | v1 | Skill modes (Lead text 2,884 words), custom roles, Leads conversation, local models | #1602, #1652, #1645 |
| 10-24 | v1 | Team account, GitHub App tokens; "Swarm chat removes pasted credentials before saving and tells the sender to revoke them" | #1688, #1690, #1687 |
| 10-26 | v1 | 1.16 MB Swarm returns 500s; New project fails on three machines | post-mortem `:19`; `2026-10-26-swarm-new-project-reliability.md:5` |
| 10-27 09:23 | v1 ends | #1755 "Swarm state by parts and Swarm v1"; released ~10:51; 426 for old clients; 16 agents blocked | `a4b32c97af`; post-mortem |
| 10-27 13:21 | v2a | #1784 "Swarm v2": decisions, review flow, scheduler, digests, leaderboard | `31e49f6b8d` |
| 10-27 13:41 | v2a | Backend hotfix: 5 pods at idle | #1785 |
| 10-27 | v2a | Feature design rules set | `docs/feature-design-rules.md:3` |
| 10-28 | v2a | 198 PRs in a day; Workspaces; avatars and reactions | #1811, #1766 |
| 10-29 | v2a | Buddy replaces Chat with PM; threads; PM on a teammate's Team account | #2090, #2132, #2089 |
| 10-29 19:07 | v2a | A production alarm reaches nobody for 4 h 50 min | #2243 |
| 10-30 09:06 | v2a | No message reaches a Buddy for two hours | #2295, #2336 |
| 10-30 | v2a | Project instructions design: "The server locks no role, workflow or routing rule" | `2026-10-30-project-instructions-design.md` |
| 10-31 08:32 | v2b | #2414 instruction document; agents message directly | `6d28e2f647` |
| 10-31 | v2b | One Buddy per Swarm; Activity and Threads views | #2447, #2434, #2453 |
| 11-02 | v2b | Steps inside a task; Quiet Swarm ("a bad buffet"); notice digest; Team accounts in every Swarm | #2511, #2626–#2633, #2505 |
| 11-03 | v2b | lampOS cannot be cloned on a Team account; held deliveries | `2026-11-03-large-repo-clone-plan.md:25`; `2026-11-03-notices-clear-on-answer.md:26` |
| 11-04 11:00 | v2b | lampOS starts working under a Swarm PM, faye (inference from the plan's "26 Oct to 4 Nov 11:00" and "with faye (4-6 Nov)") | `2026-11-08-swarm-v4.md:14-15` |
| 11-04 | v2b | Buddy gets full access; route stops ranking; Activity counts only what needs you; PM schedule; "Answers go right below" | #2991, #3010, #2929, #3026 |
| 11-05 | v2c | "Swarm redesign" approved: server checks, task contract, rules record, crew, dispatch, merge train | plans dated 11-05; #3213, #3216, #3222, #3230 |
| 11-05 12:18 | v2c | Every PM told its instructions outrank the repository's files | `0884f16a89` (#3066) |
| 11-05 14:01 | v2c | The PM hears nobody for 6.5 minutes; hotfix to its text | #3121 |
| 11-06 09:31 | v2c | "Swarm process v2" in every PM's text | #3299 `9c3ee987e5` |
| 11-06 10:19 | v2c | Instructions moved onto a new base; safety rules lost; restored 14:27 | #3300, #3327 `52ec82f635` |
| 11-06 | v2c | Shell guard; Buddy/Board final spec; six-column Board; several Buddies; the owner rules "every rule a program can check belongs in code" | #3304; `2026-11-06-buddy-board-final-spec.md`; #3381, #3383 |
| 11-07 00:05 | v3 | v3 requested for 09:00 | `docs/specs/2026-11-07-swarm-v3.md:3` |
| 11-07 01:19–04:20 | v3 | v3 merges: approval and Tasks, Regular or PM agents, My agents, no Team accounts, acceptance test | #3449, #3447, #3445, #3446, #3456 |
| 11-07 | v3 | 48 releases; three backend read hotfixes; Desktop audit with 21 findings | #3470, #3497, #3543; `docs/audits/2026-11-07-desktop-1.3.89.md` |
| 11-07 12:59 | v3 | "how do we design you right?"; asks unshipped for six hours | #3522 |
| 11-07 16:10 | v3 | Members and Leads approved: "no separate Buddy" | `docs/specs/2026-11-07-members-and-leads.md:3` |
| 11-07 17:22 | v3 | Spec "the GitHub issue is the task" opened (never merged) | #3549 |
| 11-07 18:35 | v3 | Prompt rules audit asked: 657 rules; standard 13 "Code over prompts" | `docs/prompt-rules-audit.md:3`; #3561 |
| 11-07 19:05–22:24 | v3 | "I don't want River or Theo to show up in this chat"; New agent P0s | #3555, #3567, #3580 |
| 11-07 23:03 | v3 | Barebone agents: skills and built-in text removed | #3574 `15e89b1448` |
| 11-08 00:16 | v3 ends | Last v3 commit: "a Member per person and project" | #3575 `d8fda0c681` |
| 11-08 | v4 | Plan approved: "keep it really clean and tiny ... less is better"; no PRs that day | `2026-11-08-swarm-v4.md:3,81` |
| 11-09 08:39 | v4 | Server: plain agents, channel, 1:1 chats; backend `v1.4.42` | #3585 `bc2648f4e4` |
| 11-09 09:41 | v4 | Hotfix: agents were being stopped by the v3 idle timer | #3586 |
| 11-09 15:43 | v4 | Desktop tab; tasks are GitHub issues | #3598 |
| 11-09 19:22–23:07 | v4 | Python scheduler removed; GitHub relay, merger, basics text, solver assigner added | #3621, #3620, #3633, #3636, #3624 |
| 11-10 | v4 | 165 Swarm PRs; removal slices S5–S15; sandbox run loses an ask and stalls a PR; readiness doc | #3667…#3877; issues #3813, #3787; `2026-11-10-swarm-v4-readiness.md` |
