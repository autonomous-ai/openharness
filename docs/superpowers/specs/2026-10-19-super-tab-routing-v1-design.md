# Super Tab routing v1

> Replaced by [2026-10-30-project-instructions-design.md](../../plans/2026-10-30-project-instructions-design.md): the instruction document and agents' direct messages
> replace what this describes. Kept as history; do not build from it.

Date: 2026-10-19. Status: design approved and implemented on branch `feat/super-tab-routing-v1`; not yet merged.

## Purpose

A Super Tab Lead delegates work by choosing a machine, an engine and a model itself, then calling
`harness super-tab start …` or `command {work.assign}`. Each Lead chooses differently, nothing
follows the account's cost and quality preferences, and nobody can see afterwards why a task went
where it did.

Routing v1 adds one step before a start or an assignment. The system filters out what cannot run
the task, **Jev** chooses among the rest with the full context, and a fixed policy order decides when
Jev is unsure or unavailable. The Lead still acts, and a person can change the choice later. Every
decision is logged, so routing can be measured and tuned, as the voice router was
(`cli/src/lib/routeDecide.ts`, `docs/design/2026-10-09-auto-router.md`).

### Decisions taken in discussion

- **Approach: hybrid.** Hard filter → Jev chooses with full context → fixed policy order as the
  fallback → the Lead or a person may override, with a reason. (Owner, 2026-10-19: "Jev quyết định OK,
  nhưng phải đưa nó đủ context.")
- **Policy scope (C):** an account-wide default, which each Super Tab may override.
- **Priority (D):** first the quality the difficulty needs, then the cheapest, then the most quota
  left, with reset timing breaking ties.
- **Who assesses difficulty and risk:** the Lead, who holds the task's context. Jev receives the
  Lead's assessment as input and does not guess difficulty itself.

### Success criteria

- Every Lead delegation in a Super Tab goes through `route`, and the decision is visible in the
  conversation with a one-line reason.
- Routing never blocks on Jev: with no key, no budget or a timeout, the policy order decides.
- A person can change a decision in two clicks plus a reason, and the Lead is told to hand over.
- The log holds enough to compare Jev's picks with the policy order and with task outcomes.

## Architecture and flow

```
Lead: harness super-tab route GROUP '{difficulty, risk, why, needs:{tools, devices, cwd?}}'
  1. Collect candidates: idle members of the tab, plus "new agent" on each reachable machine for each
     model the effective policy allows.
  2. Hard filter: offline, no permission, capacity admission refused, exhausted quota, engine missing.
  3. Order the rest by the policy order (D). Apply the quality floor and the quota reserve (below).
  4. Ask Jev once, with the context below, to choose among at most 12 candidates.
  5. Read the answer; fall back to the policy order when Jev is unsure or unavailable.
  6. Record the decision in the tab (route.record) and return it to the Lead.
Lead: start or assign the pick, passing routeDecisionId — or choose another, with a reason.
```

- `route` refuses a caller who is not the group's Lead (`LEAD_REQUIRED`). It checks the 30-per-hour
  limit before Jev is asked: the CLI counts the tab's decisions created in the last hour
  (`RATE_LIMITED`).
- The group's Lead and the tab Lead are never candidates; a Lead cannot route work to itself.
- `route` runs in the Lead's CLI, in the Super Tab service (`cli/src/superTabs/`), beside the
  existing `capacity` and `start` subcommands. It reuses the capacity reader and `admission()`
  (`cli/src/superTabs/capacity.ts`) for the hard filter, including quota windows and their reset
  times.
- Jev is asked through the existing `createJevDecide` (`cli/src/lib/jev/jevClient.ts`): the
  person's own OpenRouter key, or Harness's hosted key through `/api/route/jev`, which counts toward
  that route's existing daily budget. No new backend service.
- The Lead remains the executor. `route` only recommends; nothing starts or assigns automatically.
- The Lead's Super Tab instructions and the `harness super-tab` help gain one rule: before starting or
  assigning work, run `route`, pass its `routeDecisionId`, and give a reason when choosing otherwise.

## Policy

### Fields

Every field has a built-in default, so routing works with no setup.

| Field | Meaning | Default |
|---|---|---|
| `models` | Allowed model profiles. Each row: `engine`, `model`, `effort`, `quality` (1–3), `cost` (relative, positive integer), `enabled`. | A built-in catalog in Harness: e.g. Opus / GPT-5.x high = quality 3, Sonnet / GPT-5.x medium = 2, light models = 1. Rows can be disabled ("no Codex"). |
| `floor` | Minimum quality by the Lead's difficulty: `{low, medium, high}`. A `high` risk raises the floor by one, to at most 3. | `{low: 1, medium: 2, high: 3}` |
| `quotaReserve` | Percent of quota left below which an account is used only when nothing else remains. | `10` |
| `notes` | Free text for Jev, at most 500 characters ("frontend prefers Claude", "long jobs on remote-1"). | empty |

The policy order (D) is fixed in code and is not configurable:

1. meets the floor;
2. lowest `cost`;
3. most quota left (the account's tightest window);
4. earliest reset of that window;
5. an existing idle member before a new agent (no start cost);
6. stable by candidate id.

`notes` is how a person tells Jev what the fixed order cannot express.

### Storage and scope

- **Account default:** a new backend model `RoutingPolicy`, one document per user and environment,
  versioned JSON validated with zod on write. Read and written (GET and POST) through `/api/super-tabs/routing-policy`, so
  the Desktop and CLI reach it through the existing Super Tab backend passthrough without a new
  daemon route.
- **Tab override:** an optional `state.routingPolicy` in the Super Tab state holding only the
  overridden fields. Only the tab **owner** changes it, through a new command `tab.routingPolicy`.
- **Effective policy:** the tab owner's account default, with the tab's overridden fields replacing
  it field by field. A tab with several people follows its owner's policy, never the viewer's.
- A corrupt or unknown-version policy falls back to the built-in default, and `route` returns a
  warning with its result.

### UI

- Desktop: Settings ▸ Agents ▸ **Routing**, a short form: the model table (enabled, quality, cost),
  the three floor values, the quota reserve and the notes. It follows the desktop design system and
  `SettingRow`.
- Settings ▸ Routing holds Save back while a value is out of range.
- Super Tab: **Routing** in the sidebar footer, beside New group and Invite. It opens the same form in
  override mode; each field has **Use account default**, which shows the owner's account value for
  that field (`GET .../routing-policy` also returns `account`, the owner's account policy). Viewers and collaborators see the effective
  policy read-only.

## Jev context and reading the answer

### Before asking

- Candidates are ordered by the policy order after the hard filter.
- The list is narrowed in a fixed order: floor, then known, then reserve. Each step keeps its subset
  only if anything survives it.
- Floor: when any candidate meets the floor, **only those** are shown to Jev. When no viable
  candidate meets it, all are shown and the result is marked `belowFloor`.
- Known: a candidate whose capacity or quota could not be read is **unknown**. It is shown only when
  no known candidate remains, and never when `quotaRequired` is set (the existing admission rule).
  A member whose machine the Lead's account cannot open (a collaborator's machine, or one not in the
  account's list) is unknown, not offline. A machine the account lists as offline is not opened, and
  its members and new agents are excluded as offline. New agents are probed only on the account's
  machines, so an account machine that cannot be opened excludes them as unreachable. The account's
  machines are read through the core (the Super Tab service runs in its own process); when that list cannot
  be read, `route` adds a warning ("The account's machine list could not be read; only known machines were
  considered.") and considers the Lead's own machine and the members' machines.
- Reserve: an account below the quota reserve is shown only when no other candidate remains.
- At most **12** candidates, the first 12 in the policy order.
- With exactly **one** candidate, Jev is not asked (`via: 'only'`).

### What Jev is given

Jev decides, so it is given enough to decide on: what the task is, what each candidate is doing now and
has done, what the machines have, every quota window, and what was tried before. One choice question,
"Which candidate should do this task?", with one criterion line per candidate.

The hosted route allows 4 string keys and 17,000 characters of `state`, criteria of at most 640
characters, instructions of at most 1,500 and 48 criteria. The state keeps four keys, each with its own
budget, so that a long brief cannot push out the messages or the history. A part is cut at its own budget
and the cut is marked with "…". For the two logs (messages and attempts) the **newest** lines are kept and
a leading "…" says older ones were dropped.

```
state:
  task (7,000):    group title (160); brief (2,000); checks (1,000);
                   the last 10 messages of the group, newest last (3,500), tagged "person", "Lead"
                   or the agent's name: "person: Please add the endpoint." / "Lead: On it."
  lead (1,000):    difficulty, risk, why (300); the task folder as a basename and, when it is a git
                   repository on the Lead's machine, the repository name; needs (tools, devices)
  policy (1,000):  why the floor is what it is (the difficulty's quality, plus one for high risk, at
                   most 3); the cost scale ("cost is relative: cost 3 is about 3 times cost 1"); notes
  history (6,000): every ended attempt in this group (agent, outcome, result cut at 200 characters);
                   the Super Tab's last 5 routing decisions (pick, via, outcome)
criteria (640 each, most telling parts first, the end is what a cut removes):
  c0: "Member Multiply · Claude opus high · quality 3, cost 3 · remote-1 · idle · same repo ·
       on "Fix auth" · in api, branch feat/auth · last active 2h ago ·
       quota 5-hour 60% left (resets in 2h), weekly 90% left (resets in 5 days) ·
       earlier here: API done; Docs stopped"
  c1: "New agent · Codex gpt-5 medium · quality 2, cost 1 · Mac · new agent · has the task folder ·
       3 agents running · 6.5 GB memory free · quota 5-hour 90% left (resets in 4h), weekly 70% left
       (resets in 5 days)"
```

A member's effort in the label is the one its configuration reports. When that is missing or `auto` (Claude never
reports the effort it was launched with), it comes from the tab's start record (`request.effort` of the `starts`
entry with the member's `harnessId`), unless that is `default`. The value feeds both the label and the quality/cost
rating.

Where each piece comes from, all read by the Lead's `route` (the attempts read, below, is the one backend endpoint this adds):

| Piece | Source |
|---|---|
| Messages | `GET /api/super-tabs/:tab/conversations/:group/messages` as the Lead, in the service action `routeHistory` (the group's Lead only, like `routeJev`), read alongside the machine probes. Only plain group talk is kept: rows with a `source` (a native agent transcript, a route note) are dropped. Authors become roles in the service; a person's name is their email and never leaves it. |
| Task folder | `needs.cwd`. The Lead's machine first checks that the folder exists; if not, Jev is told "not on the Lead's machine" and `task folder` is logged as missing. Otherwise the SCM description gives the repository's name, remote and root. |
| Member activity | The member's `agents_list` frame on its machine: session `title`, `project` (name, remote, root, cwd), the git branch and `updatedAt`, shown as "last active 2h ago". |
| Same repo | The strongest member signal. The same remote is the same repository wherever the checkout is; a member standing exactly in `needs.cwd` (its root or cwd) is in it on any machine, since the path is the one that will run the task; otherwise the same root counts only on the Lead's own machine. A member whose frame names no checkout, or whose machine cannot be compared, is "repo unknown", not "different repo". Shown only when the Lead named a folder. |
| Earlier work | The member's ended assignments in this Super Tab (group and outcome, newest first, three at most), from the group's attempts read, the decision log and the tab state. The group's own entries are ordered oldest first by the attempts read, the current assignment last; without that read the log's order stays. |
| New agents | The capacity probe's answer for the task folder (`has the task folder`), the number of agents in the machine's `agents_list`, and free memory from the capacity resources. |
| Quota | Every window the reader reports, by name (`5-hour`, `weekly`), each with the percentage left and a relative reset. The tightest window still orders the candidates. |
| Attempts | Every earlier attempt of the group, from `GET /api/super-tabs/:tab/conversations/:group/attempts?asAgentId=`, read by `routeHistory` in parallel with the messages and the log. `work.define` takes a stopped assignment out of the tab state, so without this read a retried group looked untried (manual run 2026-10-19). The log's ended decisions and the group's current assignment are joined to it by assignment id, so an attempt shows once; the log still names the agent that a decision started. Each shows the agent, the outcome and the result, scrubbed and cut at 200 characters. The same attempts feed the member's "earlier here". |
| Recent decisions | The first 5 of the same log, newest first. A decision without a recorded `via` shows without it. |

A source that cannot be read (an offline machine, a failed read, a missing frame) is left out and
replaced by one phrase: "Recent messages: unknown", "activity unknown", "repo unknown", "agents running
unknown", "free memory unknown", "repository unknown", "Recent routing in this Super Tab: unknown". An older backend that answers 404 to the attempts read is a failed read: the history falls back to the log and the current assignment, and `attempts` is logged as missing. Routing
never waits on or fails because of context: once `routeContext` has named the machines and members, the probes,
the task folder read and `routeHistory` (messages, decisions and attempts) start together, and each context read gives up
after three seconds. What needs several of them (whether a member is in the task's repository, its earlier
work) is joined afterwards. When the latest 100 messages hold only log rows, Jev is told "none in the latest 100
messages".

**What Jev never receives:** emails, tokens, credentials, or an agent's transcript. Session titles are short
summaries and are allowed. Group messages carry the same exposure as the brief, which is the same exposure as
the voice router: the task text goes to OpenRouter, or through the backend with the hosted key.

**Scrubbing.** Every piece of free text (messages, results, titles, branches, notes, names) is scrubbed
before it is cut, so a cut cannot leave half a key behind. Email-like strings become "[email]". Token-like
strings become "[secret]": `sk-…`, `ghp_…` and the other GitHub prefixes, `xox…-`, AWS `AKIA…`,
`Bearer <20+ characters>`, a JWT, and runs of 32 or more hex characters. A base64 or base64url key of 32 or
more characters is recognised by having upper case, lower case and digits and no words joined by hyphens;
`/` and `.` end a run, so paths, URLs, branch names, UUIDs and file names are kept. A commit id is replaced:
a lost id costs less than a leaked key.

**Decision log.** The record carries `context: { chars, missing }`: how many characters Jev was given in all
(state, criteria and instructions) and which sources could not be read (`messages`, `route log`,
`attempts`, `task folder`, `member activity`, `machine load`). It is optional, absent when Jev was not asked, and lets
pick quality be compared with how complete the context was.

Instructions tell Jev to prefer a member marked "same repo" over an equal candidate, to treat a candidate that
already failed or stopped on this task as worse, and not to read "unknown" as a bad sign.

### Reading the answer

- Jev's choice is taken at **p ≥ 0.6**, or when it **leads clearly**, by the same rule and constants
  as `jevPick` in `routeDecide.ts` → `via: 'jev'`.
- Otherwise the first candidate in the policy order is taken → `via: 'order'`, reason "Jev unsure".
- When Jev cannot be asked (no key, hosted budget spent, 3-second timeout) → the policy order, with
  reason "Jev unavailable". No retry. Routing never waits on Jev beyond the timeout. A timeout
  reports `TIMEOUT` as the reason; other failures report `UNAVAILABLE`.
- A choice outside the candidates, or broken probabilities, counts as unsure.
- Reset times in the criterion lines are given as how far away they are ("resets in 2h"), because
  Jev does not know the current time.
- The result: `routeDecisionId`, `pick`, `via`, `p`, `belowFloor`, `why` (one sentence),
  `alternatives` (the next two in the policy order), `warnings`.
- Cost: exactly one Jev call per `route` (about 0.6 s).
- `next` for a new agent is a complete start JSON: `conversationId`, a sample `name`, the task's `cwd` (else a
  placeholder path), `worktree`, `requirements` (the help's defaults, with the task's `needs.tools` added and
  `needs.devices` set), and the pick's machine,
  engine, model and effort, with `routeDecisionId` only when the decision was recorded. The capacity probe
  uses the same requirements (memory, disk, tools, devices; quota stays optional; CPU is not capped, because it is only a momentary reading and a busy machine would refuse every candidate), so a pick the
  route admitted is admitted again by the start it suggests.

## Log, override and the Desktop

### The decision log

A new backend collection `SuperTabRouteDecision`, kept apart from the tab state so the state stays
small. Each record holds:

- `tabId`, `conversationId`, `createdAt`;
- the Lead's assessment (difficulty, risk, why);
- the candidates shown to Jev (id and criterion line), and the filtered-out ones with their reasons;
- the effective policy's floor and whether `notes` were set;
- `pick`, `via`, `p`, `belowFloor`;
- `context`: the size of what Jev was given and the sources it lacked (see "What Jev is given");
- `final`: who was actually started or assigned. For a started agent whose routed model switch failed, `model`
  and `effort` are what actually runs and `requested` keeps the routed pair;
- `override`: by whom (the Lead or a person) and the reason;
- `outcome`: `done`, `stopped` or `superseded`, with its time. A person's or Lead's change of
  choice is recorded in `override`, never as an outcome; a new route supersedes.

Writes and links:

- The Lead records a decision with a new command `route.record`, authorized like the other agent
  commands. Only transport failures make a result `unrecorded`; any other refusal of the record is
  returned to the Lead as an error.
- `work.assign` and `agent.start` accept an optional `routeDecisionId`. The backend fills `final`. A
  `final` that differs from `pick` without an `overrideReason` is refused with
  `OVERRIDE_REASON_REQUIRED`.
- A start request carries optional `model` and `effort`. A routed Claude start launches the agent with them as
  launch arguments that apply to that session only: `agent_create` accepts optional `model` and `effort`, and
  Claude Code is started with `--model <model> --effort <effort>` (`claude --help`: "for the current session").
  Nothing is typed into the pane and nothing is written to the person's Claude settings. This replaces typing
  `/model`, which Claude Code saves as the default model in its `settings.json`, and which also cost about 13 s
  of retries (manual run 2). `default` for the model, and `default` or `auto` for the effort, add no flag.
  - The daemon takes them only for an engine whose launch contract declares the flags (`modelArgs`; now Claude).
    Any other engine, and a Claude whose `--help` lacks `--model` or `--effort` (read through the permission-flag
    probe and its cache), is answered `LAUNCH_MODEL_UNSUPPORTED`; a malformed value, an effort the flag does not
    take, or any of them beside a grid model, `INVALID_LAUNCH_MODEL`. Both come before a creation receipt exists.
    The values travel as separate argv items, are never part of a shell string, and are not kept on the agent's
    row. On a relaunch, `--resume` restores the session's model (`cli/src/lib/subscriptionModel.ts`), but the
    effort comes from the person's settings again. An effort of `auto` adds no flag, so the person's own
    `effortLevel` applies.
  - An older daemon would ignore the unknown payload fields and start the agent on the engine's own model. The
    agent's frame cannot tell the two apart at creation (its `selectedModel` is not yet read from the pane), so
    the daemon names the engines it launches with a model in the `launchModel` field of its `super_tabs`
    `capacity` reply, and `start.ts` sends `model` and `effort` only to a machine that lists the engine, for an
    engine that is not on a grid model. For any other start (Codex, a grid model, a daemon without the field)
    the agent is created without them and uses the post-create switch below. When a machine that was sent them
    refuses with `LAUNCH_MODEL_UNSUPPORTED` or `INVALID_LAUNCH_MODEL` (a value or a Claude build it cannot use),
    the same creation id creates the agent without them and the switch follows. A start resumed after the create
    was sent cannot know which of these happened, so it reads the agent's frame (`agents_list`): the routed pair
    (`default`, and an `auto` effort, match anything) means nothing to do; another pair runs the switch; a
    frame that cannot be read leaves the agent as it is and reports a `modelWarning`. `/model` is never typed
    without knowing the current state.
  - The post-create switch: `start.ts` first sends `agent.started`, so the agent joins the roster and the
    join turn that `agent_create` submitted can finish, and only then applies them with
    `agent_update {agentId, selectedModel}`. Until that turn ends the switch answers `BUSY`, and a fresh
    Claude answers `UNSUPPORTED_CLI_VERSION` until its first transcript records tell the daemon its CLI
    version (seen in the 2026-10-19 manual run). The daemon does not put that version on the agent's frame,
    so a known old version cannot be told from an unknown one: `start.ts` retries both every second for at
    most 60 s (for Claude only; another engine's UNSUPPORTED_CLI_VERSION is final) and returns only after the switch settled, so the Lead assigns work once the routed model is
    in place. If it still fails and the agent's frame does not show the routed pair, `start.ts` leaves the agent on the engine's own model, reports
    `modelWarning`, and corrects the decision with `route.modelResult` (below). A launched agent has no switch
    to fail, so it has no `modelWarning` and no correction; its model is observed afterwards through the
    host's `agent.configuration`. A policy row whose `model` and `effort` are both `default` launches the
    engine as configured and skips both paths; the default catalog uses `default` for Codex because its model
    slugs come from each machine's `models_cache.json`.
- A command the backend refuses as invalid names the failing field before zod's message, for example
  `command.request.requirements: Invalid input: expected object, received undefined`.
- `route.modelResult {decisionId, startId, model, effort}` is sent by the Lead's CLI only when the routed
  switch failed, with the model and effort the agent's frame (`agents_list`) shows. It is authorized like
  `route.record` (the coordinating Lead of the decision's group), needs an open decision whose `final` is
  the `new` start named by `startId` (otherwise `ROUTE_MISMATCH`), sets `final.model` and `final.effort` to
  what runs, keeps the routed pair in `final.requested`, and posts no message. Matching a later assignment to
  a candidate uses `requested` when it is there. If the frame cannot say what runs or the command fails, the
  start still succeeds and `modelWarning` adds that the decision log could not be corrected. Only the first
  `start` invocation knows the decision id, so a start resumed after an interruption is not corrected.
- Assigning an agent that was started from the decision keeps the start's `final` (engine, model and
  effort) and only adds the assignment. A direct assignment of a member records `final` as a member.
- Quality and cost of a member come from the policy row matching engine, model and effort, then
  engine and model, then the engine's `default` row. A member's model is the one its engine reported
  after work, so a Claude id (`claude-opus-4-7`, `claude-sonnet-4-5[1m]`) is first reduced to its
  family (`opus`, `sonnet`) and a Codex slug (`gpt-5.5`) falls to the `default` row. A member
  matching no row is quality 1, cost 1, so it rarely meets a floor.
- `outcome` is filled automatically when the assignment becomes `done` or `stopped`. A
  host-confirmed stop of the agent closes the linked decision too, except where a person's Change
  named another candidate than the one that was running: that stop is the handover, so the decision
  stays open with its `final` and assignment cleared, and the Lead's start or assignment of the
  chosen candidate links to it and closes it later.
- A start or assignment that names a decision whose assignment is still running is refused with
  `ROUTE_LINKED`, so a second attempt cannot overwrite the first one's `final`.
- A newer `route` for the same group supersedes the open one.
- Records are kept 90 days and read through `GET /api/super-tabs/:id/route-decisions` for analysis. A single decision is read
  through `GET /api/super-tabs/:tabId/route-decisions/:decisionId`, which expanding a route row uses. Both return
  `createdAt` and `outcomeAt` beside the record.
- The attempts of one group are read through `GET /api/super-tabs/:tabId/conversations/:conversationId/attempts`,
  authorized like the messages read (a member of the tab, or an agent through `asAgentId` with the same checks;
  never across tabs). It returns at most 50, newest first, each with `id`, `agentId`, `status`, `result` (cut at
  500 characters) and `createdAt` (when the assignment was replaced). Execution grants, receipts and the
  configuration stay on the server.
  v1 has no analysis screen.

### Timing: the Lead is never blocked

- The Lead runs `route`, then starts or assigns **immediately**. No approval wait.
- A person overrides **afterwards**: **Change** on the route row, then another candidate and a reason.
  The backend records the override and posts the Lead a message in the group: "[person] chose X
  instead of Y. Hand this task over to X." The Lead uses the existing handover flow: it stops the active assignment, then starts or assigns
  the chosen candidate with the same `routeDecisionId`. A Lead's own
  override also posts a message (`source.kind: 'route-override'`), because route rows are immutable
  messages.

### Desktop

- Each decision is one compact row in the conversation, in time order:
  `Routed to Multiply · Claude Opus high · remote-1 — Jev 82% · "schema change, high risk"`.
  The quoted text is the Lead's own reason (`assessment.why`), also carried as `source.why`; the
  verdict's one-sentence `why` stays in the decision record only.
  - `via: 'order'` reads "by policy order (Jev unsure)" or "(Jev unavailable)", from
    `source.fallback` (`unsure` or `unavailable`, carried by the record when the policy order decided).
  - `belowFloor` adds an amber **Below quality floor** label.
  - A Lead override is shown as a message in the conversation with the Lead's reason, beside the
    unchanged route row.
- **Change** appears only for the owner and collaborators, never for viewers. It opens a dialog that loads
  the decision record: the alternatives first, then the remaining candidates, each with its
  criterion line, leaving out the current choice. A short reason is required before confirming.
- Expanding the row reads the single decision and shows every candidate, the filtered-out ones and why, and the policy applied.
- Visible copy follows the [Naming System](../../naming-system.md).

## Errors and limits

| Situation | Handling |
|---|---|
| No candidate survives the hard filter | `route` returns `NO_CANDIDATE` with each candidate's exclusion reason. The Lead tells the person in the group and does not guess. |
| A machine's capacity or quota cannot be read | The candidate is unknown (see above). |
| Jev errors, times out, has no key or no budget | The policy order, `via: 'order'`, with the reason. No retry. |
| Jev returns an unknown choice or broken probabilities | Treated as unsure; the policy order. |
| `route.record` fails (network) | `route` still returns its result, flagged `unrecorded`. The Lead starts or assigns without a `routeDecisionId`. |
| Corrupt or unknown-version policy | The built-in default, with a warning in the result. |
| The pick disappears between `route` and the start | Existing admission refuses. The Lead runs `route` again; the old record becomes `superseded`. |
| An override names a candidate that is no longer available | Refused with a clear error; the person chooses again. |

Limits:

- at most 12 candidates shown to Jev;
- `why` at most 300 characters, the brief cut at 2000, `notes` at most 500;
- the state parts within their budgets (7,000, 1,000, 1,000 and 6,000 characters), each criterion within 640;
- one open decision per group;
- at most 30 `route` calls per tab per hour, so a looping Lead cannot spend the Jev budget.

## Testing

- **CLI unit tests, 100% coverage for the new files** (`npm run test:core` where they fall under
  it):
  - the policy order (floor, cost, quota, reset, member before new agent);
  - `belowFloor` and the quota reserve;
  - the hard filter, one test per exclusion reason;
  - reading Jev's answer: the p threshold, a clear lead, an unknown choice, a timeout, `only`;
  - the context respects every limit, at the worst case, and contains no email or token (each token shape is scrubbed);
  - every new label, the same-repo marking, both quota windows, and a phrase for each missing source;
  - each context source failing on its own still routes, and is listed in the record's `context.missing`.
  - a stopped attempt stays in the history after a new definition, shows once when the log also knows it, and has its result scrubbed;
  - the Lead's reason ends in exactly one period.
- **Backend integration (in-memory Mongo, `test:super-tabs`):**
  - the account policy and the tab override, merged field by field, owner-only;
  - `route.record`, `final`, `route.modelResult`, and `OVERRIDE_REASON_REQUIRED`;
  - automatic outcomes on `done` and `stopped`, and `superseded`;
  - a person's override posts the Lead its handover message;
  - viewers are refused, and the rate limit holds.
  - the attempts read lists a stopped attempt after a new `work.define`, lets a viewer read, refuses a non-member and never crosses tabs.
- **CLI end to end** (isolated daemon, `FakeBackend`, a fake Jev):
  - the Lead routes, then starts the pick;
  - Jev failing falls back to the policy order;
  - a person's override reaches the Lead.
- **Desktop widget tests:** the route row for each `via` and for `belowFloor`; **Change** only with
  permission and with a required reason; the Settings ▸ Routing form and the tab override form with
  **Use account default**.
- Tests never call the real Jev or OpenRouter. One manual run with the real Jev on a test tab is
  recorded in the PR.

## Delivery

One change, shipped complete: backend (policy, log, commands) → CLI (`route`, Lead instructions)
→ Desktop (route row, Change, forms). No part is merged on its own.

## Out of scope for v1

- Policy per group, spending caps in money, machine restrictions (machine sharing already grants or
  withholds machines).
- An approval gate before delegation.
- A statistics dashboard, and learning the policy from outcomes.
