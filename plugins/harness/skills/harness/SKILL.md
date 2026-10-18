---
name: harness
description: Harness runs coding agents (Claude Code, Codex and others) as harnesses, sessions the person can watch and join in the Harness app, on this computer or their other machines. Use it to start another agent on work that can run beside yours, needs another agent's view (a review, a second opinion from Codex), takes long, or belongs in its own folder; then wait for it, read its answer and close it. Do small, quick work yourself, and quick fan-out inside one task with your own sub-agents.
---

# Harness

Harness runs coding agents in sessions of their own, called harnesses, and shows each one to the person in its
desktop, web and phone apps. With the `harness` command (or Harness's MCP tools) you can start harnesses, read
them, wait for them and close them, and message your teammates: the harnesses in your tab, while Agent Messages are
on. Both are experiments of the person's Harness account, in Settings ▸ Experimental, off until the person turns
them on.

## Is it here?

Run `harness version`. If there is no such command, Harness is not installed. Ask the person before you install
it; it takes two commands and no account:

```
curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
harness start
```

`harness start` starts Harness on this computer. Harnesses the person starts here need no sign-in; `harness login`
is for their other machines and their phone, and for what they let agents do. You start harnesses only once the
person turns on "Agents can start other agents" (Settings ▸ Experimental, or `harness settings agents-start-agents
on`, signed in). Until then `harness new` refuses and says how: tell the person, and do the work yourself. If
`harness ps` is an unknown command, the CLI is older than these verbs: `harness update`. The agent you start must
be installed as well (`claude` for Claude Code, `codex` for Codex) and signed in to its own provider. On Linux the
installer installs tmux and curl with apt-get, which asks for the person's password; without one, ask the person to
run `sudo apt-get install -y tmux curl` first.

Once Harness runs on this computer, Claude Code and Codex run its commands (`ps`, `new`, `wait`, `show`, `send`,
`close`) and its MCP tools without asking: Harness adds them to their permission rules, and Codex runs them outside
its sandbox. What you may do with them is still Harness's to decide (below). Run each `harness` command by itself,
or join `harness` commands with `&&`: piped into another command, after `;`, or with a variable set in front, the
rule no longer matches, so it asks, and in Codex it runs in the sandbox, which cannot reach Harness's local daemon.
Where Harness has not set your agent up, run `harness` outside your sandbox, asking for escalated permissions. A
sandbox in the way is not a stopped Harness: do not run `harness start` unless a command run outside the sandbox says
Harness is not running.

## When to start a harness

Every harness you start spends the person's tokens. Start one only for work that:

1. **can run in parallel with yours**: tests in one folder while you work in another, several tasks at once;
2. **needs another model's view**: a review, a second opinion from Codex;
3. **takes long**: it keeps running after your turn or your context ends;
4. **belongs in its own folder**, or on another of the person's machines (`harness machines` lists them).

Do quick work yourself, and a quick parallel search or edit inside your own task with your own sub-agents:
cheaper and faster. Close each harness once you have its answer. Everything you start appears in Harness, where
the person can watch and step in.

## New harness or an existing one

1. Start with `harness whoami`: who you are, whether you may start harnesses now (and if not, who can change that),
   and how many of yours are open. Then list: `harness ps`. It shows the harnesses here: state, who started each
   (`you` for yours), and what each is about.
2. You may give work only to a harness **you started**, or to a teammate in your tab while Agent Messages are on
   (`harness send` alone lists them). Never give work to, or close, a harness you did not start: those are the
   person's. You may `show` and `wait` on them.
3. Put everything in the task when you start a harness: starting it does not let you message it. A follow-up
   for the same work goes to it with `harness send` only if it is your teammate in your tab while Agent Messages are
   on (Settings ▸ Experimental, off by default); otherwise start a new harness with the fuller task. Start a new one
   too for unrelated work, for work to run in parallel, or for another agent or machine.

## The verbs

```
harness whoami                                      # who and where you are, whether you may start harnesses, your limits
harness ps [--all] [--machine <name>]               # the harnesses here, or on another machine
harness new [agent] [--machine <name>] [folder | project] --name <name> -- <task>
harness wait <name>[,<name>…] [--any] [--timeout 30m]
harness show <name> [--chars N]                     # its state, the last ask and its answer
harness send <name> "text"                          # a teammate in this tab, while Agent Messages are on
harness close <name> [--now]                        # when you are done with one you started
```

- **Always `--name`** what you start (`--name reviewer`): an unnamed harness takes its session's title, which
  changes. Every verb also takes the start of an id.
- `agent` is `claude` (the default), `codex`, or another agent installed on that machine. The folder defaults
  to the current directory. `--machine <name>` starts it on another of the person's machines (`harness machines`
  lists them); `show`, `wait` and `close` then find it by its name.
- For scratch or new work, give a project name (`harness new codex review -- …`, which makes `~/harnesses/review`)
  rather than a folder of your own: Claude Code and Codex ask the person to trust a folder Harness did not make.
- Put the whole task in `-- <task>`: what to do, where, what done looks like, and what to answer with. A task
  holds 2,000 characters; for a longer one, write it to a file and name the file in the task.
- `wait` exits 0 when it is idle (or you closed it), 3 when it needs the person (a question or a permission:
  only the person answers those, so tell them), 4 when it stopped or is gone, 124 on timeout. `--timeout 0`
  waits as long as it takes.
- Read the result with `show` instead of asking for a summary.
- `close` what you started once you have its answer. It keeps the conversation; the person can resume it.
  It refuses while the harness is working, unless `--now`. One closed while still starting may have no
  conversation to keep yet, and `close` says so, with how many of yours are still open.
- Every verb ends with `Next:`, the command to run next: follow it. `--json` gives it as `next`. Every error
  says what to run next.
- A harness waiting on a question or a permission is shown as `needs the person`: tell the person.
- Exit 5 means refused (your limits, the person's setting, or a harness you did not start): do not retry it;
  tell the person, or do the work yourself.
- `harness help agents` prints the commands, states, exit codes and rules on one screen.

## Inside a harness, or outside

- **In a harness** (Harness made your terminal pane): `harness send` works only to teammates in your tab, while
  Agent Messages are on (Settings ▸ Experimental, off by default). A harness you started, or the one that started
  you, is no exception: outside your tab, or with Agent Messages off, put everything in the task and read the answer
  with `show`.
- **Outside Harness** (Claude Code or Codex in a terminal app, an editor or the person's own tmux): Harness tells
  you by your session. `harness whoami` (and the top of `harness ps`) says "You: <agent>, outside Harness, on
  <machine>.", and `harness ps` marks what this session started as `you`; the limits below apply; and you may close only what this session started. Nothing can
  message you, and `harness send` is not available: put everything in the task, and for a follow-up start a new
  harness with the fuller task.

## Example: a second opinion from Codex

```
harness new codex --name reviewer -- "Review the changes on this branch against main for bugs. Do not edit files. Answer with the findings, most serious first, each with file and line."
harness wait reviewer --timeout 20m
harness show reviewer
harness close reviewer
```

To keep working meanwhile, start it, go on with your own work, and run `harness wait reviewer` when you need
the answer. For several at once, start each with its own name and wait on all of them:
`harness wait api-tests,ui-tests`.

## Harness's MCP tools

If Harness's MCP server (`harness mcp`) is connected, its tools are the same verbs under the same rules:
`harness_whoami` (whoami), `harness_list` (ps), `harness_start` (new: task, name, `folder` or `project`, `agent` claude or codex, `machine`),
`harness_wait` (up to 120 seconds by default and 600 at most; if they are still working, call it again),
`harness_read` (show), `harness_close` (close), and `harness_send` (send), offered only inside a harness.

## Limits and rules

- At most 4 live harnesses of yours, and 20 starts in 10 minutes. A harness another agent started may not start
  harnesses itself: if you were started by one, do the work yourself, or say in your answer what else is needed.
  Every limit refuses with a message; do not work around it.
- Harness cleans up after you: closing a harness closes the harnesses it started, and one another agent started
  is closed once it has sat idle 30 minutes after its last answer, unless the person typed into it. Its
  conversation is kept, and `show` still reads its answer.
- A harness you start runs in its agent's auto mode, with the agent's own checks on. `--mode full` (checks and
  sandbox off) is the person's to choose: from an agent it is refused.
- Never answer a harness's question or permission prompt yourself, and never type into it some other way.
- Never ask a harness to publish, deploy, delete or push: those are the person's to ask for.
