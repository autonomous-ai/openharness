# Swarm: start here

For a team that builds one GitHub repository together, each person with their own agents. This is what Harness does on
11 November 2026; [swarms.md](swarms.md) describes earlier versions too.

## On each person's computer

- **Harness Desktop**, signed in to your Harness account.
- **Claude Code or Codex**, installed and signed in on your own subscription. A Swarm agent runs one of the two.
- **`gh`**, signed in to GitHub (`gh auth login`), as a collaborator of the repository. Harness acts on GitHub with
  your own login, and counts a read only from the repository's own people.

One computer matters more than the others: the PM's person's. Its Harness gives out the tasks, asks for the reads and
lands the changes, with that person's `gh` login, which needs write access to the repository. Keep it on, awake and
signed in while the team works.

## Starting

1. **One person makes the Swarm.** ⌘S, or New Swarm in the Swarm's menu at the top of the left pane. In the form: your
   computer, the engine, and a folder, a GitHub address to clone, or a new repository; what you want built; and the
   project's visibility in the Swarm. Keep it public, the default: a private project's tasks reach only agents started
   for it. Press New Swarm. That first agent is the project's PM.
2. **That person shares it.** Manage ▸ Swarm ▸ Manage people: a link, an email domain, or an invitation (accepted in
   Settings ▸ Tab invites). Only the Swarm's owner shares it. People join the Swarm, not one project.
3. **Each person adds their agents.** In Your Team: + for a new agent, or Attach for a Claude Code or Codex session
   already running. These build for each public project of the Swarm.

## How the work goes

1. **The PM's person says what to build**, in their chat with the PM. Everyone else talks to their own agents. Agents
   post in the project's channel; people read it.
2. **The PM opens GitHub issues**, each one pull request's work, with labels: `size:s`, `size:m` or `size:l` (an issue
   with no size is never given out), `part:<area>`, `p0` to `p2`, `needs:<tool>`, and "after #N" in the text for one
   that waits.
3. **Harness gives each sized task to a builder**: the label `builder:<name>` and a comment saying why. The builder's
   own computer types it to the agent.
4. **The builder takes it** (`harness super-tab take`), builds on a branch, and opens a pull request.
5. **Harness asks another agent to read it**, of another model family before its own. The reader answers with
   `harness super-tab read ok` or `read hold`.
6. **It lands** when it is aimed at the default branch and is not a draft; another agent's READ-OK, made by command,
   is on its newest commit; it has no HOLD and no `hold` label; every check passed; and it is not behind, in conflict, or
   carrying another open pull request's commits. Harness lands several at once in a train, on one CI run. Nobody needs
   to merge by hand.
7. **When builders have nothing to do**, the PM is told, with the numbers. From 09:00 on the PM's computer, on a day
   something landed or a task closed, the day's numbers are posted in the channel.

A project can state its goal as checks: `harness super-tab goal` in a checkout writes `agents/GOAL.md` and the workflow
that runs it, and the PM is told how many pass.

A project in a private repository can list the suites its CI does not run in `agents/SUITES.md`, a row for each shard:
its name, what its computer needs, and its command. Whoever runs a shard says how it ended on that exact commit with
`harness super-tab suite passed|failed OWNER/REPO SHA SHARD`. It shows on GitHub as that person's check,
`suite: <shard>`, and a failed one holds what it is on. Harness does not run the shards yet
([the design](design/2026-11-11-swarm-allocator/suites-across-machines.md)).

## When nothing moves

| You see | Look at |
|---|---|
| No task is given | The PM's person's computer: on, awake, signed in, `gh` signed in. The task's labels: it needs a size |
| A task waits for another | Its "after #N" |
| A pull request does not land | Its comments: Harness says why to its builder (checks failed, a HOLD, behind or in conflict, the repository's rules) |
| GitHub says the merge is blocked | The repository's own rules (required reviews, branch protection): Harness tells the builder, on the pull request, to ask its person |
| Anything else | `~/.harness/cli/data/harness.log`, the lines with `[super-tab]`: on the PM's person's computer for giving and landing, on an agent's own computer for what is typed to it |

## Today's limits

- A task that waits on another can be given as soon as that one is taken, before its code exists.
- The reader can be an agent of the author's own person.
- Harness lands only the team's pull requests: those labelled `builder:<name>` or on a `<name>/` branch of one of the
  team's agents.
- An issue you label `builder:<name>` yourself stays with that builder, unless it stops, its computer is down, it is
  quiet for eight hours, it took it and an hour passed with no pull request, or, before taking it, its subscription ran
  out.
