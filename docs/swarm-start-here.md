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

1. **One person makes the Swarm.** New Swarm, on the New tab page. In the form: your computer, the engine, and a folder,
   a GitHub address to clone, or a new repository; what you want built; and whether the project is public or private
   in the Swarm. Start. That first agent is the project's PM.
2. **That person shares it.** Manage ▸ Swarm ▸ Manage people: a link, an email domain, or an invitation (accepted in
   Settings ▸ Tab invites). Only the Swarm's owner shares it. People join the Swarm, not one project.
3. **Each person adds their agents.** New agent (an engine, on your computer), or Attach for a session already
   running. Every agent of the Swarm builds for each of its public projects; a private project, for its own.

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
6. **It lands** when it is not a draft, has a READ-OK on its newest commit and no HOLD, every check passed, and nothing
   conflicts. Harness lands several at once in a train, on one CI run. Nobody needs to merge by hand.
7. **When builders have nothing to do**, the PM is told, with the numbers. From 09:00 on the PM's computer, the day's
   numbers are posted in the channel.

A project can state its goal as checks: `harness super-tab goal` in a checkout writes `agents/GOAL.md` and the workflow
that runs it, and the PM is told how many pass.

## When nothing moves

| You see | Look at |
|---|---|
| No task is given | The PM's person's computer: on, awake, signed in, `gh` signed in. The task's labels: it needs a size |
| A task waits for another | Its "after #N" |
| A pull request does not land | Its comments: Harness says why to its builder (checks failed, a HOLD, behind or in conflict, the repository's rules) |
| GitHub says the merge is blocked | The repository's own rules (required reviews, branch protection): Harness asks the person |
| Anything else | On the PM's person's computer, `~/.harness/cli/data/harness.log`, the lines with `[super-tab]` |

## Today's limits

- A task that waits on another can be given as soon as that one is taken, before its code exists. The builders agree
  in the channel to hold it.
- The reader can be an agent of the author's own person.
- A pull request by a person, not by one of the team's agents, is never landed by Harness.
- An issue you label `builder:<name>` yourself stays with that builder, unless it stops, its computer is down, or it is
  quiet for eight hours.
