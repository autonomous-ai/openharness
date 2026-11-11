# Swarm: a model for each task

Status: **designed, 12 November. No code.** This is package 14 of [what to build](BUILD.md). Its code waits for two
words from anh Dee: a yes to [the one screen change](model-choice-mockup.html), and a yes to
[the tiers experiment](tiers-experiment.md), which spends his subscription.

[The design](README.md) found its first version wrong here twice. "Harness picks the model for each task": an agent
is one session with one model, `/model` typed in its pane changes its person's default, and model routing was built
in eight designs and removed on 10 November (#3908). And "80% of tokens": two of its three levers stack to 46 to
68%, at API prices, from vendors' figures and one trace; per subscription window nothing is measured.

## In short

1. **One choice, on one screen.** Where an agent is added, its model can be left to Harness: one row, **Auto**. It
   is off until its person picks it. A model a person chose is never changed.
2. **One pure function picks.** From the class's record of finished tasks and the price list: the cheapest model
   whose share of changes landed with no hold is within five points of the best. Until the table's own answer has
   twenty finished tasks in the class, the table the server serves decides.
3. **A session for each task**, started with its model on the command line, for that session only. A fix resumes
   it. No `/model` is typed into a pane, and nothing is saved as anyone's default.
4. **A step up is one tier, on evidence only**: two failed check rounds, a second hold, or twice the expected time.
   It is a new session on the same branch, told what failed.
5. **The server decides nothing.** It serves a table and keeps rows. The agent's own person's daemon chooses,
   starts and steps up. That is the difference from v3.
6. **Whether a cheaper model lands the same work here is not known.** The experiment answers it, coarsely. Until it
   runs, any saving is a guess.

## What v3's routing was

A step before every start. The PM ran `harness super-tab route`. The CLI listed candidates (a machine, an engine, a
model: up to 64 rows) and, in most of its forms, named a pick. The server stored that as a route decision
(`route.record`). The start had to name it (`routeDecisionId`), and by the end the PM had to give a reason to leave
the pick (`ROUTE_REASON_REQUIRED`). At one time or another rules, floors and steps refused starts (`RULE_BROKEN`,
`BUILD_REFUSED`, `STEPPED_UP`). A ledger kept each attempt's tokens, cost and result: 18 counters by model, kind of
job and week. A nightly pass proposed changes to the table.

It went in three pull requests: the CLI's route on 9 November (#3626: 11,606 lines in 44 files), the server's record
on 10 November (#3908: 5,829 lines in 75 files), and the token reports that fed it the same day (#3917). The model
table and the price list were kept: `GET /:tabId/routing-policy` still answers, for Desktop's New project and
Switch PM.

The eight designs, as [the study](../../research/2026-11-10-swarm-study/swarm-v1-v3.md) counts them:

| # | When | What it was | Why it went |
|---|---|---|---|
| 1 | 19 Oct (#1424, #1431) | **A hosted model picks.** The CLI leaves out what cannot run, Jev chooses among up to 12 candidates, and a fixed order decides when Jev is unsure | In three days "the Lead overrode Jev's pick about half the time: Haiku, a stopping agent on an offline machine, low effort". Jev did not know the owner's rules |
| 2 | 22 Oct (#1586) | **The owner's rules pick.** Rules kept in the Swarm (no Haiku, a least effort, which machines); the server refuses a start that breaks one | Every new wish was code and a backend release. By 30 October a PM said "the server blocks it, there is no route" |
| 3 | to 30 Oct (#2314) | **A policy table picks.** A quality of 1 to 3 and a cost for each model, a floor by difficulty, quota fit; cheap first, and the server steps a task up after a failed first review (`stepUp.ts`) | Routing sat "in four places the PM does not control", each "enforced twice, in the backend … and in the CLI's route …, and the two drift". Decided that day: "The server locks no role, workflow or routing rule" |
| 4 | 31 Oct (#2414, #2423) | **Advice only.** The route still ranks, now by measured cost for a shipped change and first-review pass rate; the project's Routing text and the PM decide | "PMs took the route's top line, which was nearly always Opus or Astra, against the instructions' Order and quota" |
| 5 | 4 Nov (#3010) | **No ranking.** Candidates in a neutral order, no pick; the PM chooses by the Routing text and says why | A first row is still a first row. In production Astra xhigh was offered for small work 2,010 times against Sol high 67, Opus high 2,356 against Sonnet high 127 |
| 6 | 6 Nov (#3296) | **The route picks by the Routing order.** A pure function in the CLI ranks by need, quota, idle, load and price; leaving its pick needs a reason | Still advice: "`routePick.ts` in the CLI, the server trusts it", and the reason was free text. The next day's audit: "Leads picking against the routing rules" |
| 7 | 7 Nov (task #4546) | **Pick agents in code.** The whole order, the models, the quota and the machine were to move from the PM's text into code the server checks | Never finished. v3 ended the next day, and v4 removed the route and its record |
| 8 | 9 Nov (#3624) | **A solver.** It plans which builder takes which task. It picks no model: a builder has the one its session runs | It stays: the design's first point. The study counts it; it is not model routing |

Seven of the eight chose a model. Each moved who decides (a hosted model, the server, a table, the PM's text, the
CLI's advice), and each kept a decision on the server with a rule about following it. Where the pick was advice, PMs
left it. Where it was a rule, the server stood in the way of work.

The nearest ancestor of this design is inside the fourth: `routeMeasured.ts` ranked by a first-review pass rate once
a choice had 5 first reviews, and called one worse only when two 95% ranges stood apart. With 5 to 10 reviews "the
ranges nearly always overlap, so cost decides". It lasted four days as a ranking.

## What is different here

| v3 | Here |
|---|---|
| A PM ran a route before a start, and was asked to follow it | No agent is asked anything. The daemon that starts the session calls a function |
| A decision stored on the server, linked to the start, with reasons for leaving it | Nothing is stored about a choice. The finished task's row says which model ran (package 12) |
| The server refused starts by rule, floor and step | The server refuses nothing. It serves the table and the price list, and keeps rows |
| A step up was a state on the task: the server set it and cancelled the builder | A step up is the builder's own daemon starting a new session, from its own record of the task |
| The rule lived in a table, in the Swarm's state, in the PM's text, in the CLI and in the server | One function in one place (`cli/src/superTabs/`). Nothing to drift |
| 18 counters by model, kind of job and week, and a nightly proposal | Two counts and the tokens, by class and model |
| Every agent was routed | Only an agent whose person chose Auto |

No state machine: a task has facts (its session, its model, its failed rounds), and each decision is a function of
them, worked out again whenever it is needed. No authority on the server: it cannot refuse, start, stop or step.

## The one screen change

Where an agent is added: **+ New agent** in a Swarm, which is the ⌘N form with the Swarm's button. Its model
chooser lists one row under **Subscription** today: Anthropic. It gains one row there: **Auto**. Chosen, the form's
model pill reads Auto. [The mockup](model-choice-mockup.html) draws both.

```text
  brain Auto   shield Auto-approve                      [x] Worktree   From main
 +----------------------------------+
 | Search subscriptions and models  |
 | Subscription                     |
 |   Anthropic        79% remaining |
 |   Default account on M2          |
 |   Auto                        v  |   <- the new row
 | Your models                      |
 |   ...                            |
 +----------------------------------+
```

- **Off until picked.** The form remembers it as it remembers its other choices: from the last launch.
- **Claude Code only**, until Codex passes its trial ([below](#what-the-engines-allow)). Never for a model served on
  a grid.
- **Only where a session is started for each task**: the row shows when the chosen computer's daemon says it can.
- **Off again** when its person picks a model for the agent themselves, in the pane's own model picker (⌘:). From
  then on the model is theirs.
- **Nothing else on screen changes.** The agent's card shows the model its session runs, as today.
- An attached agent keeps its model. A PM is not offered Auto: New project chooses its model.

The label is defined in the [Naming System](../../naming-system.md), and the row is added to the Desktop design
system with its Flutter test, in the pull request that ships it.

## The choice

### What it reads

- **A class** is a task's `part:` and `size:` labels together, as [BUILD.md](BUILD.md) package 9 has it.
- **The record** of a class, for each model, from package 12's rows:
  - **finished**: the tasks that ended on that model. A task ends on a model when its change lands, or when it
    leaves that model by a step up. A task given back, taken back or closed for another reason is not counted: it
    says nothing clear about the model.
  - **clean**: of those, the ones whose change landed with no HOLD on any head that model pushed.
  - **tokens**: what those tasks spent, in the four kinds a daemon counts (`cli/src/lib/agentTokenUsage.ts`):
    uncached input, output, cache read, cache write.
- **A step up counts twice**: once against the model it left (finished, not clean) and once for the model that took
  it (finished, and clean if it then landed with no further hold). So the dearer model's record fills with the tasks
  the cheaper one failed, and its share is, if anything, too low. The rule then errs toward the cheaper model, and
  the step up catches the task. Its tokens there are a part of a task's, so it can also look cheaper than it is:
  between two tiers inside the margin the pick may swing, which costs nothing in clean landings.
- **A record is kept by the model's full name**, as its session reports it (`claude-opus-5-5`). A new model under an
  old alias starts with none.
- **The price list** is `catalog.prices` on the `routing-policy` read (`backend/src/superTabs/costs/prices.ts`): US
  dollars for a million tokens of each kind. As that file says, "A model not listed has no cost, never a guessed
  one": it cannot be chosen.
- **The table** is `policy` on the same read (`routingPolicy.ts`, made from `catalog.ts`): rows of an engine, a
  model, an effort, a quality of 1 to 3 and whether it is enabled; and a floor (low 1, medium 2, high 3).

### The function

```ts
type Size = 's' | 'm' | 'l'
interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
/** One model in one class: the tasks that finished on it, how many were clean, and the tokens they spent in all. */
interface ModelRecord { model: string; finished: number; clean: number; tokens: Tokens }
interface ClassRecord { size: Size; models: ModelRecord[] }
/** US dollars for a million tokens of each kind. */
interface Price extends Tokens { model: string }
interface Row { engine: string; model: string; effort: string; quality: number; enabled: boolean }
interface Table { models: Row[]; floor: { low: number; medium: number; high: number } }
/** A row with its price and its record in this class. */
interface Tier { row: Row; price: Price; finished: number; clean: number; tokens?: Tokens }

/** Finished tasks before a model's share counts, and how far under the best share a cheaper model may be, in points. */
export const ENOUGH = 20, MARGIN = 5
const FLOOR = { s: 'low', m: 'medium', l: 'high' } as const
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
/** Whether a full name is the model a row launches: `claude-opus-5-5` is `opus`. */
const launches = (row: Row, model: string) => model === row.model || model.startsWith(`claude-${row.model}-`)

export function modelFor(engine: string, record: ClassRecord, prices: Price[], table: Table): Row | null {
  // The tiers: the engine's enabled rows that have a price, the first row of a model, cheapest first.
  const rows = table.models.filter(row => row.engine === engine && row.enabled)
  const tiers: Tier[] = rows.filter(row => rows.find(r => r.model === row.model) === row).flatMap(row => {
    const price = prices.find(p => launches(row, p.model))
    const done = record.models.find(m => m.model === price?.model)
    return price ? [{ row, price, finished: done?.finished ?? 0, clean: done?.clean ?? 0, tokens: done?.tokens }] : []
  }).sort((a, b) => a.price.output - b.price.output)
  // The table's answer: the cheapest tier whose quality meets the size's floor. It is tried until its share counts.
  const start = tiers.find(tier => tier.row.quality >= table.floor[FLOOR[record.size]])
  if (!start || start.finished < ENOUGH) return start?.row ?? null
  // The tiers whose share counts, the best share among them, and those within MARGIN points of it (in whole numbers).
  const known = tiers.filter(tier => tier.finished >= ENOUGH)
  const best = known.reduce((a, b) => b.clean * a.finished > a.clean * b.finished ? b : a)
  const near = known.filter(tier =>
    100 * tier.clean * best.finished >= (100 * best.clean - MARGIN * best.finished) * tier.finished)
  // Of those, the one whose finished task cost least: its tokens at the list's prices.
  const cost = (tier: Tier) =>
    KINDS.reduce((sum, kind) => sum + tier.tokens![kind] * tier.price[kind], 0) / tier.finished
  return near.reduce((a, b) => cost(b) < cost(a) ? b : a).row
}
```

The rule, in words:

1. **The tiers** are the engine's enabled rows that the price list prices, one for a model, cheapest first.
2. **The table's answer** is the cheapest tier whose quality meets the floor for the task's size: small low, medium
   medium, large high.
3. **Until that tier has twenty finished tasks in the class, it is the answer.**
4. After that: among the tiers with twenty or more, find the best share of clean tasks. Of the tiers within five
   points of it, take the one whose finished task cost least.
5. A tier with fewer than twenty is never weighed. No tier at all: `null`, and the agent runs its engine's own
   model, as an agent not on Auto does.

With today's table that is: Claude Code starts small and medium tasks on `sonnet` at high effort and large ones on
`opus` at high; Codex starts every size on `gpt-6.1-sol` at high. Two cautions. Reading a size as the table's
difficulty is this design's own step: the table was made for a PM's "low, medium, high". And its rows are the
owners' standing decisions of 30 October and 2 November (`catalog.ts`), not findings: the experiment's result takes
their place before any code uses them.

It ran, as written, on the examples below (12 November, outside the repository): no product code lands with this
design.

### What "enough" is, and why

**Twenty finished tasks on a model, in the class.** At twenty, one task is five points of a share: the margin the
rule turns on. With fewer, one hold moves a share by more than the margin.

Twenty does not make the rule sure. How often it takes the cheaper model, by the true shares, when each model has
the same number of finished tasks (modelled: exact, tasks taken as independent):

| True share: cheaper, best | at 20 | at 30 | at 50 | at 100 |
|---|---|---|---|---|
| 85%, 85% (level) | 75% | 71% | 76% | 86% |
| 80%, 85% (5 points worse) | 58% | 50% | 50% | 54% |
| 75%, 85% (10 worse) | 42% | 31% | 26% | 21% |
| 65%, 85% (20 worse) | 17% | 8% | 4% | 1% |
| 55%, 85% (30 worse) | 5% | 1% | 0% | 0% |

So the rule catches a large gap and tosses a coin on a small one. That is accepted, for three reasons:

- A small gap costs little either way.
- **A wrong cheap pick mends itself.** The cheaper model keeps taking tasks, so its share keeps moving toward the
  truth, and each task that fails is caught by its own step up.
- **A wrong dear pick lasts until the record forgets.** Package 12's rows expire. When the table's tier has fewer
  than twenty rows left in a class, the next task of the class goes to it again (line 3 of the rule). So a table
  tier that lost still takes about twenty tasks of a class in each expiry period, one at a time as its rows age
  out. That is the only way a class comes back down, and that is its cost.

One thing the rule is slow at: a class whose table tier does badly moves up only when the tier above has twenty
finished tasks there, and it gets them from steps up. That is about twenty failures. Until then each task is
rescued alone.

### Six examples

Claude Code, with today's table and price list. The dollars are tokens at list prices; the tokens are made up
(0.4 million uncached input, 0.12 output, 12 cache read and 1.5 cache write for a task, which comes to $6.95 on
Sonnet 5.5, $13.90 on Opus 5.5 and $31.75 on Fable 5.1), because nothing has counted a task's tokens yet.

| # | Class | The record: clean of finished, share, a task's cost | Answer | Why |
|---|---|---|---|---|
| 1 | cli, s | `sonnet` 10 of 12, 83.3%; `opus` 28 of 31, 90.3% | `sonnet` high | The table's tier has 12, not twenty. Opus's share is not weighed yet |
| 2 | cli, s | `sonnet` 21 of 24, 87.5%, $6.95; `opus` 36 of 40, 90.0%, $13.90 | `sonnet` high | 87.5 is within five of 90.0, and its task costs half |
| 3 | desktop, m | `sonnet` 17 of 25, 68.0%; `opus` 27 of 30, 90.0% | `opus` high | 68.0 is 22 points under the best |
| 4 | backend, s | `sonnet` 17 of 20, 85.0%; `opus` 18 of 20, 90.0% | `sonnet` high | Exactly five points: within. One more hold (17 of 21, 81.0%) and it is `opus` |
| 5 | cli, m | `sonnet` 20 of 22, 90.9%, $15.29 (2.2 times the tokens); `opus` 23 of 26, 88.5%, $13.90 | `opus` high | Both are within five of the best. The cheaper price was the dearer task |
| 6 | backend, m, with a `fable` row added | `sonnet` 26 of 40, 65.0% (9 stepped up); `opus` 18 of 21, 85.7% (9 from those steps, 12 on agents whose person chose it); `fable` 6 of 6 | `opus` high | 65.0 is 20.7 under 85.7. Fable's six are not weighed |

Three more, in short. A large task: `opus`, the table's tier, and Harness tries nothing cheaper on it; but if agents
whose person chose `sonnet` have landed 20 of 22 large tasks there clean against Opus's 30 of 33, it is `sonnet`. A
class where only `sonnet` has a record, at 9 of 20: still `sonnet`, the slowness named above. Codex, any size, no
record: `gpt-6.1-sol` high.

## A session for each task

1. A task is given, as today: the assigner's label and its line. When a turn of the agent ends, its builder's daemon
   works out its next thing, as today (`nextThing.ts`: a HOLD on its pull request first, then failed checks, then a
   conflict, then the next task given). For an agent on Auto that also says which session comes next.
2. The next thing is a new task: the daemon reads the task's class from its labels, reads the class's rows, and
   calls `modelFor`.
3. It starts a session for the task, in a worktree of the task's own. The engine is launched with the row's model
   and effort on its command line: `claude --model opus --effort high` (`launch.ts` `modelArgs`, applied by
   `lib/launchModel.ts`). The first message is the task's line, as today.
4. The Swarm's agent stays one: its name, its chat, its place in the team. Its session is replaced the way a
   switched PM's is today (the replacement report and the server's `agent.rebind`). That path asks today that the
   new session works in the same folder (`replacements.ts`): a task's own worktree needs that widened. The session
   it left is kept stopped and can be reopened, as the daemon already keeps a conversation it left
   (`keepAbandonedConversation.ts`).
5. Its pull request goes up. There is nothing more to do in that session.
6. **A fix resumes that session.** The next thing is a HOLD, failed checks or a conflict on an earlier task: the
   daemon reopens that task's session with `claude --resume <id> --model <the same> --effort <the same>`
   (`resumeArgs`; a session's registry row keeps its launch model today) and types the fix's line. One session of an
   agent works at a time: a fix waits for the live session's turn to end, as it does today.
7. The change lands. The task's row is written (package 12), its session is forgotten, and its worktree goes by
   package 6's rule.

Its person's own message is typed into the session that is live, as today.

### What the engines allow

From this repository's code on 12 November, not from memory:

| | Claude Code | Codex |
|---|---|---|
| A model for one session, at launch | Yes: `--model` and `--effort`, which `claude --help` (2.1.303) calls "for the current session" (`claude/launch.ts`) | No path for its own login. `codex/launch.ts` declares no `modelArgs`, and `launchModel.ts` answers "codex cannot be launched with a model; it takes one after it starts". The code gives Codex a model on a command line in two other places only: `-m` on a grid launch (`gridLaunch.ts`), and `--model` with `-c model_reasoning_effort=` for a one-shot `codex exec` (`oneshot.ts`) |
| A model after launch | `/model` typed in the pane, which Claude Code saves as the person's default (`launchModel.ts`: found on 19 October) | Its `/model` picker, walked row by row (`codex/modelControl.ts`). That choice is saved as the person's default too (`modelPicker.ts`: "pressing the wrong row saves the wrong model as the person's default") |
| Resume | `--resume <id>` | `codex resume <id>`. A conversation is bound to its provider since 0.166 (`providerBoundConversations`), not to its model |

So Claude Code can do all of this today. **Codex first needs a trial**, on a real install: start it with
`-m <model> -c model_reasoning_effort="<effort>"`, resume it with `codex resume <id> -m <model>`, and compare
`config.toml` before and after. If nothing is saved, Codex gets a `modelArgs` line and the same path. If something
is, a Codex agent keeps its person's model and is not offered Auto.

Claude Code's resume with its model is what every relaunch does today: the registry keeps a session's launch model
and passes it again, "the flags hold for one launch only" (`lib/registry.ts`, `lib/launchOverrides.ts`).

### Never changed

- An agent added without Auto is one session on its person's model, with no `--model` from Harness and no `/model`
  typed: as today. The rule that agents start as plain Claude Code or Codex holds for it. It never steps up. Its
  finished tasks still count in the record, under the model it ran.
- An attached agent, and a PM whose person chose its model: the same.
- On Auto, a session whose model its person changed by hand keeps that model: no step up replaces it.
- `/model` is typed only when a person changes a running agent's model themselves, never for a task.

## The step up

Evidence, and nothing else. Not a model's opinion of its own work, not a PM's guess, not a slow hour.

| Evidence | Read from |
|---|---|
| Two failed check rounds | Checks failed on two heads of its pull request. The merger says `checks failed:` once for a head |
| A second hold | A HOLD on a second head: held, fixed, held again. Two readers holding one head count once |
| Twice the expected time | Its minutes building reach twice the class's: the median of the class's finished tasks once there are three (`LEARN_MIN`), else the size's guess (`SIZES`: 30, 90 and 240 minutes) |

**Who decides: the builder's own person's daemon.** From its own record of the task (package 12's boundaries: taken,
pull request up, each fix and its cause), which GitHub's news already feeds. Not the server, not the PM, not the
agent.

What it does:

- It ends the session at its turn's end and writes the task's row for the model it leaves: finished, stepped up.
- It starts a new session one tier up, in the same worktree, on the same branch and pull request.
- The first message names the task, the branch, which evidence fired, and where to read it: the pull request. It
  quotes no reader's words. What another account's agent wrote stays data the session reads on GitHub.
- One tier at a time, and once for a task and a tier: the task's record says which tier it is on, so a restart or a
  piece of news that arrives twice steps nothing twice.
- **At the top tier there is no step.** The PM is told once, in the project's channel, with the evidence. It cuts
  the task smaller or gives it to another.
- A step needs room for the dearer tier in its person's window, their reserve kept (package 15). With none there is
  no step, and the PM is told the same way.

## What the top model does

The top model is the last tier of an engine in the table: `opus` for Claude Code and `gpt-6-astra` for Codex today.

1. **It cuts work.** The PM runs on it, as today (`opus` at xhigh, the server's default for a PM). A person's choice
   for their PM stands.
2. **It reads risky changes.** Risky is as [BUILD.md](BUILD.md) has it: a change that touches a hot file (one that
   more than a tenth of recent landings touch: package 8's list, from the scoreboard), or whose class has broken a
   train (package 9's record). The assigner knows both when it asks a reader. After today's rule that a read comes
   from another model family when one can, it asks a reader that can read on the top model: one on Auto, or one
   whose person's model is the top. Its ask says the change is risky. A reader on Auto reads it in a session of its
   own on the top model, then goes back to its task. Every other read is typed into the reader's live session, as
   today. A forged ask costs one top-model read of a real pull request, inside its person's reserve.
3. **It takes the last step up.**

## Data and design

- **Growth.** On the server, one yes or no for an agent, gone with the agent. This package adds no rows: it reads
  package 12's, which expire. On a daemon, one small record for each open task of an agent on Auto (its session,
  its tier, its failed rounds): at most four an agent (`CLAIM_LIMIT`), removed when the change lands or the task
  leaves the agent.
- **Concurrency.** One daemon decides for its own agent's task. No write is shared. A row is written once, by the
  task's own builder's daemon, under the task's id, so a second write is the same write.
- **Read cost.** The class's newest rows, at most 200, when a task of that class starts or a step is weighed; after
  the first read, only rows newer than the last one held. The table and the price list once a day: they change only
  with a backend release.
- **Scale.** At ten times today, a thousand agents starting ten tasks a day is about seven reads a minute, each by
  an index on the project, the class and the time, each bounded. The metric that warns first is that read's p95
  against the 100 ms limit.
- **Compatibility.** The backend ships first: the yes or no on an agent, and the read of rows by class. A Desktop of
  the last 30 days never sends the field, so its agents keep their person's model. A daemon from before does not
  say it can start a session for each task, so the row is not shown for its computer. `routing-policy` is read as
  it is served; a new row in it (Fable) is added, never a changed shape.
- **Migration and rollback.** No migration: an agent without the field is as today. Rolled back, the daemon ignores
  the field again; open task sessions go on as ordinary sessions on the model they have; nothing stored is
  rewritten.
- **Audience.** The choice is its person's alone: the server takes it only from the person who adds the agent, as
  it takes the add. The rows are seen by the project's members (package 12). A row is its builder's daemon's word
  about its own task. A false one can move a class's choice within the rule; it can start nothing on another
  person's computer.
- **Identity.** Every session is started by the agent's own person's daemon, under their login, on their
  subscription. The PM's daemon only asks: a task given, a read asked.
- **Failure.** Each has a name, a log line and someone told:
  - the class's rows cannot be read in five seconds: the table decides, and the log says so;
  - no table has ever been read: the engine's own model, and one line in the agent's chat;
  - the engine refuses the model: the session starts on the engine's own, and its join says so, as a refused launch
    model does today (`LAUNCH_MODEL_REFUSALS`);
  - the model's own limit is reached: the task waits or goes to another as an agent out of quota does today; no
    other model is put in its place;
  - a session cannot be reopened: a new one on the same model, told the fix, as the daemon falls back today;
  - a step cannot start: the PM is told.
- **Platforms.** The daemon on macOS, Linux and Windows (a session start and a pane swap exist on each; on Windows
  through `ownProcessGroup()`, with no window opened). The one row in Desktop on macOS, Windows and Linux. Not the
  phone or the web.

Measures, as counts only: choices by tier and by which line of the rule answered, steps up by evidence, sessions
started and reopened, sessions that could not be reopened.

## What is measured, what is modelled, what is assumed

**Measured**, on record in this repository:

- v3 in use: a PM overrode the hosted model's pick about half the time (22 October); with no ranking the top row was
  offered for small work 2,010 times against 67 and 2,356 against 127 (5 November, production).
- The price list, read on 29 October: Sonnet 5.5 $2 and $10 for a million input and output tokens, Opus 5.5 $4 and
  $20, Fable 5.1 $10 and $50. That is 1 : 2 : 5.
- The one public board the server's table records, Terminal-Bench 4.0 in Claude Code at max effort: Opus 5.5 64.85,
  Sonnet 5.5 61.82, Fable 5.1 57.88. Three points between the first two, and the dearest last. None of it is our
  code.
- The experiment's pool on 12 November: 29 closed tasks with a linked pull request, 21 with one merged pull request
  of their own, 17 of those changing code and unit tests.

**Modelled:**

- The rule's errors at 20, 30, 50 and 100 tasks (the table above).
- What fifty tasks can show, and the experiment's cost from the allocator's table of sizes
  ([the experiment](tiers-experiment.md)).

**Assumed:**

- That a hold measures the builder's model, not the reader's.
- That list prices stand for what a subscription's window charges.
- That a class is the right grain: alike enough inside, and busy enough to reach twenty.
- That a new session for each task spends no more tokens than one long session: it carries no old context, but it
  reads the repository's rules again, and a session reopened after a wait writes its cache again.
- That an alias names one model for as long as a record lasts.
- That the tokens in the examples are the right size. Nothing has counted a task's tokens (package 12).

**Not known:** whether a cheaper model lands the same work here. The experiment.

## What would make this design wrong

1. **The experiment shows the cheaper tiers far behind** on small and medium tasks. Then there is no cheaper start,
   and the function has nothing to choose.
2. **Classes never reach twenty** finished tasks on a model before their rows expire. Then the table decides for
   good and the function is dead code: ship the table and the step up alone.
3. **Holds follow the reader.** A weak reader passes weak work, and the share flatters the cheap model. Trains
   broken and changes reverted would show it (packages 1 and 9).
4. **Tokens for a landed change go up** for agents on Auto against agents on one session. Package 12's first week
   says.
5. **A window does not charge by list price.** Claude Code reports limits by model ("Opus limit", "Fable limit" in
   `superTabs/terminal.ts`). Then the cheapest by price is not the cheapest for a person, and package 15's measured
   spend must take the price list's place in the same function.
6. **A step up rarely rescues**: what fails on one tier fails on the next. Then steps spend tokens and time for
   nothing, and the answer to a failing task is the PM cutting it.
7. **People do not pick Auto**, or pick it and then choose models by hand. They may: a chosen model is never
   changed. If most do, the package is not worth its code.

## Not in it

- The solver. It plans a builder, as today; the model is chosen when the task starts. What a task spends by model
  is package 15's.
- A task's least model. The plan's rule 6 has the PM say it; no code reads it today (`floor: 0` in
  `assign/crew.ts`). It would be a floor under this function's answer: a proposal, not this package.
- Effort. It is the table row's.
- Any screen but the one row.

## When he says yes

1. The experiment, and the table it gives: which tier a small and a medium task start on, and whether Fable gets a
   row.
2. Codex's trial.
3. The server's part, first: the yes or no on an agent.
4. The daemon's part: a session for each task for Claude Code, `modelFor`, the step up. Specs with the six examples
   as their first cases, and each deciding line broken once to see its spec fail.
5. The row in Desktop, with its Flutter test, the design doc and the gallery in the same pull request.
6. Proof: a week of our own Swarm with tokens for a landed change by model, and holds by model.
