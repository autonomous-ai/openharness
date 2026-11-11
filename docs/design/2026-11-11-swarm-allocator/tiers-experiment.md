# Swarm: the tiers experiment, its plan and its cost

Status: **a plan, 12 November. Nothing has run.** It runs only on anh Dee's word: it spends his subscription. It is
the first step of package 14 ([a model for each task](model-for-each-task.md)), and it is how [the design](README.md)
says one of its unknowns is found: "Does a cheaper model land the same work? Fifty closed tasks run again on three
tiers, the project's tests the judge."

## In short

1. **Fifty closed tasks of our own public repository, run again on three Claude models**, each judged by the tests
   its own landed change brought.
2. **It can show a tier that is far behind**: a gap of 20 points, three or four times in five. **It cannot show
   five points**, the margin the choice rule turns on: that takes about 500 tasks. The live record does that work.
3. **By the allocator's own table of sizes it costs 13 five-hour windows** and 2.6 weekly windows: about three
   weeks of his subscription, with a fifth kept for him. That table is a guess. The first 15 runs measure it.
4. **The fifty do not exist today**: 17 tasks may qualify. Making the list spends nothing of his.

## What it gives

- **The first table**: the model a small and a medium task start on, and whether Fable gets a row at all.
- **The first measured tokens for a task**, by model. Nothing has counted them (package 12).
- **The first measured spend of a window**, by size and model. The allocator plans with a guess today.

## The tasks

**From `autonomous-ai/openharness`**, this repository, which is public. Why this one:

- Its tasks are GitHub issues, with `size:` and `part:` labels since 9 November: the classes the choice rule uses.
- Its rules ask every pull request for a test that fails without the change and passes with it (AGENTS.md,
  standard 3). So a fair judge exists.
- Its unit suites run on one computer with no network: `cli/`, `backend/`, `desktop/`.
- It is the project whose table the result fills first.
- Its tasks closed in the last weeks, so no model was trained on their answers (assumed, not checked).

**The pool** is every closed task with a merged pull request linked to it. This query lists it, with what the checks
below need:

```sh
gh api graphql --paginate -f query='
query($endCursor: String) {
  search(type: ISSUE, first: 50, after: $endCursor,
         query: "repo:autonomous-ai/openharness is:issue is:closed reason:completed linked:pr sort:updated-desc") {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue {
      number title body createdAt closedAt
      labels(first: 20) { nodes { name } }
      closedByPullRequestsReferences(first: 5) { nodes {
        number merged createdAt
        mergeCommit { oid parents(first: 2) { nodes { oid } } }
        files(first: 100) { nodes { path } }
      } }
    } }
  }
}'
```

Run on 12 November it gave **29** tasks. **21** have one merged pull request of their own. **17** of those change
both product code and unit tests. None of those carries a size yet. Checks 3 to 6 below have not been run.

**A task qualifies** when all of this holds. A script checks each, before any model runs:

1. **One pull request, landed as its own commit.** Its merge commit's first parent is "the commit before". A task
   that landed inside a batch shared with other changes is left out: it has no one commit before.
2. **Code and unit tests of one component.** The change touches product code and `cli/src/**/*.spec.ts`,
   `backend/src/**/*.test.ts` or `desktop/test/*_test.dart`. Not end-to-end, integration, VM or device tests: they
   need services.
3. **The judge's files load before the change.** A test file that needs a file or a name the change itself added is
   not a judge's file: no agent could guess that name. A task with no judge's file left is out.
4. **Red, then green, with no network.** With the judge's files copied onto the commit before, the judge's command
   fails, on an assertion. On the landed commit it passes, three times in a row.
5. **The text alone.** Its title and body, as written before its pull request opened, name no pull request or
   commit. No comments are used.
6. **Small or medium.** By its `size:` label. One without a label is sized by our project's PM from its text alone,
   before any run, as it sizes a new task.

**The fifty** are the newest 25 small and 25 medium that qualify. The run waits until the list holds them. Tasks
have been issues since 9 November, so the pool grows with the Swarm's own work. Whether a change that rides a train
still counts as landed in a commit of its own is package 4's trial on GitHub.

**Large tasks are left out.** Each is a quarter of a window by the table, and the five or ten one could afford show
nothing under a 60-point gap. They start where the table puts them until the live record says otherwise.

## The tiers

Claude Code, on his subscription, at `--effort high`, as its CLI names its models today
(`cli/src/engines/claude/runtimeProfile.ts`), with the full names and list prices the server's price list has
(`backend/src/superTabs/costs/prices.ts`, read 29 October):

| Tier | Launched as | Full name | A million tokens, input and output |
|---|---|---|---|
| 1 | `sonnet` | `claude-sonnet-5-5` | $2 and $10 |
| 2 | `opus` | `claude-opus-5-5` | $4 and $20 |
| 3 | `fable` | `claude-fable-5-1` | $10 and $50 |

An alias moves when a lab ships. Each run records the full name its session reports.

Codex is not in it. Its launch takes no model for a session yet
([what the engines allow](model-for-each-task.md#what-the-engines-allow)), and one engine on one subscription keeps
the comparison clean. Its two priced models (`gpt-6.1-sol`, `gpt-6-astra`) are a second run, if he wants one.

## One run

1. **A fresh clone that ends at the commit before.** That commit is fetched into an empty repository, with no
   remote, no later commit and no tag. A worktree of the real repository would hold the answer.
2. **Set up, then closed.** Dependencies are installed. After that the run's only way out is a proxy that passes
   the model's own hosts (the ones one logged run shows) and nothing else, and the run has no GitHub login. The
   repository is public: without this the answer is one fetch away.
3. **Plain Claude Code.** `claude --model <tier> --effort high`, in the full mode
   (`--dangerously-skip-permissions`): a throwaway folder with no network is where that mode belongs, and nobody is
   there to answer a question. No Swarm text. The repository's own `AGENTS.md` is in the clone, as for any agent.
4. **One prompt: the task's title and body.** Nothing else is typed.
5. **It ends** when the session stops and waits, or at **twice its size's minutes**: 60 for a small task, 180 for a
   medium one. A model that stops to ask gets no answer.
6. **The judge.** The landed change's judge's files are copied over the run's tree, replacing whatever the run did
   to those files. Then, with no network: `npx vitest run <files>` in `cli/`, `npm test -- <files>` in `backend/`,
   or `flutter test <files>` in `desktop/`. **Pass means every judge's test passes.** Nothing else is judged.
7. **Kept:** the diff, the counts below and the judge's output. The clone goes.

Each task runs once on each tier, in a shuffled order, three runs at a time at most (the suites take cores). And
**the cheapest tier runs every task a second time**, to learn how often one model differs from itself. That is 200
runs.

## What is recorded for each run

- The task: its number, size and part. The model that built its landed change, where its pull request names one.
- The tier: the alias, the full name the session reported, the effort, the engine's version.
- Time: start, end, minutes, turns. Whether it hit the limit. Whether it ended on a question.
- Tokens, in the four kinds the daemon counts (`cli/src/lib/agentTokenUsage.ts`): uncached input, output, cache read,
  cache write.
- The five-hour and weekly windows' percent, before and after, as Claude Code reports them.
- The judge: pass or fail, and which tests failed. Lines changed.

Numbers and names only. The diff stays on that computer, for reading by hand.

## How many runs make a result one can trust

Two hundred: 150 for the pairs and 50 for the noise. Each task is its own control: the same fifty on every tier,
compared pair by pair (the exact paired test, McNemar's). What that can show, modelled:

- **The smallest gap fifty can show is 12 points**: six tasks one tier lands and the other does not, and none the
  other way. With one the other way it takes eight to one (14 points); with two, ten to two (16 points).
- **The chance a true gap shows:**

  | True gap | Fifty tasks | One size (25) |
  |---|---|---|
  | 30 points | 94 to 98% | 60 to 71% |
  | 20 points | 70 to 83% | 30 to 35% |
  | 10 points | 24 to 32% | 5 to 6% |
  | 5 points | 6 to 7% | 1% or less |

- **Five points would take about 500 tasks.** So the fifty answer one question: is a tier far behind? They do not
  tune the five-point rule. The live record does.
- **By size the answer is weak**: 25 tasks show only a gap of 24 points or more. The table's two rows rest on that.
- **A gap shown where there is none**: 1 to 2% for one comparison. There are three.
- **The second run of the cheapest tier is the noise.** If Sonnet differs from itself on six tasks of fifty, a gap
  of six tasks between two tiers is not believed.
- **One bias is known.** The landed change was written by some model, and its tests fit its own answer. The result
  is also read without the tasks each tier built.

## What it costs

From `SIZES` in `cli/src/superTabs/assign/crew.ts`: a small task is 30 minutes and 3% of a five-hour window, a
medium one 90 minutes and 10%, and a weekly window is spent a fifth as fast. **That table is the allocator's guess**,
one figure for any model, "until finished tasks teach better".

| | Runs | Five-hour windows | Of a weekly window | Agent hours |
|---|---|---|---|---|
| One tier: 25 small, 25 medium | 50 | 3.25 | 65% | 50 |
| Three tiers | 150 | 9.75 | 195% | 150 |
| **And the cheapest tier again** | **200** | **13** | **260%** | **200** |
| With a fifth of every window kept for him | 200 | 16.25 | 3.25 weeks | 200 |

- **The weekly window is what binds**: about three and a quarter weeks, with his fifth kept (`RESERVE`). While it
  runs it takes the room his Swarm's agents on that subscription would use.
- **Hours.** 200 agent hours is about 67 hours of running at three runs at once, spread over those weeks.
- **It can be up to twice this.** A run is cut at twice its size's minutes.
- **The table is blind to the model.** If a window charges as the price list does (1 : 2 : 5) and the table's
  figure is Opus's, 200 runs cost 14.6 windows, not 13. If the figure is Sonnet's, 29. Nobody knows. Claude Code
  also reports limits of their own for Opus and Fable.
- **So the first 15 runs measure it**: three small and two medium tasks on the three tiers, 0.9 of a window by the
  table. The rest is costed again from what those spent. Past the cap in the line below, it stops and he is told.
- **The list, the checks and the set-up spend nothing of his.**

Two smaller cuts, if he wants less:

| | Runs | Five-hour windows | Weeks, a fifth kept | What it can show |
|---|---|---|---|---|
| Small tasks only, fifty | 200 | 6 | 1.5 | Nothing about medium tasks, where most tokens go |
| Thirty tasks: 15 small, 15 medium | 120 | 7.8 | 2 | A gap of 20 points two times in five; 30 points, three in four |

## What he would decide

A gap "shows" when its split passes the paired test: six to none, eight to one, ten to two.

| What the runs show | What it means | He decides |
|---|---|---|
| No tier behind another, and little noise | As far as fifty can tell, Sonnet lands our small and medium tasks | Build package 14. Both sizes start on `sonnet`. The saving is what the token counts say; list prices alone say half of Opus |
| Sonnet level on small, behind on medium | The design as drawn | Build it: small starts on `sonnet`, medium on `opus` |
| Sonnet behind on both | The cheap tier is not for our work | Both sizes start on `opus`. Package 14 then saves nothing on them: set its code aside, or build only the step up. The saving must come from smaller tasks and fewer fix rounds |
| Fable ahead of Opus | The dearest model lands more here | Fable gets a row and is the top tier: the last step up, and the reader of risky changes |
| Fable level with Opus, or behind | The top tier is Opus | No Fable row. A step up ends at `opus` |
| Every tier fails most tasks (the best under one in three) | The judge or the task texts are at fault, not the models | Nothing about models. Fix the list, or learn that our tasks cannot be built from their text alone |
| Sonnet differs from itself on ten or more of fifty | One run for a task is noise | No gap under that is believed. A second run of every tier is another 6.5 windows: his call |
| A cheaper tier lands as much and spends as many dollars of tokens | A cheaper price is not a cheaper task | No cheaper start on that size |

Where the runs show no gap, the table leans cheap: a size starts on the cheapest tier not shown behind. A wrong
cheap start is mended by the step up and by the record; a wrong dear start by neither. Fifty tasks cannot tell a
10-point gap, so which way to lean is his to turn.

## The one line

**Run the tiers experiment on your Claude subscription, yes or no: 200 runs, spending at most 13 five-hour windows'
worth and never more than four-fifths of any one window, over about three weeks, starting when fifty tasks qualify,
and stopping to tell you if its first 15 runs show it will cost more?**
