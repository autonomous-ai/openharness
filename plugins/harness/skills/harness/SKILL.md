---
name: harness
description: Harness runs coding agents (Claude Code, Codex and others) as harnesses, sessions the person can watch and join in the Harness app, on this computer or their other machines. Use it to start another agent on work that can run beside yours, needs another agent's view (a review, a second opinion from Codex), takes long, or belongs in its own folder; then wait for it, read its answer and close it. Do small, quick work yourself, and quick fan-out inside one task with your own sub-agents.
---

# Harness

Harness runs coding agents in sessions of their own, called harnesses, and shows each one to the person in its
desktop, web and phone apps. With the `harness` command (or Harness's MCP tools) you can start harnesses, read
them, wait for them, message them and close them.

## Is it here?

Run `harness version`. If there is no such command, Harness is not installed. Ask the person before you install
it; it takes two commands and no account:

```
curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
harness start
```

`harness start` starts Harness on this computer. Harnesses on this computer need no sign-in; `harness login` is
only for the person's other machines and their phone. If `harness ps` is an unknown command, the CLI is older than
these verbs: `harness update`. The agent you start must be installed as well (`claude` for Claude Code, `codex`
for Codex) and signed in to its own provider.

## When to start a harness

Start one for work that:

1. **can run beside yours**: tests in one folder while you work in another, several tasks at once;
2. **needs another agent's view**: a review, a second opinion from Codex;
3. **takes long**: it keeps running after your turn or your context ends;
4. **belongs in its own folder**, or on another of the person's machines (`harness machines` lists them).

Do small, quick work yourself, and a quick parallel search or edit inside your own task with your own
sub-agents: cheaper and faster. Everything you start appears in Harness, where the person can watch and step in.

## New harness or an existing one

1. List first: `harness ps`. It shows the harnesses here: state, who started each (`you` for yours), and what each
   is about.
2. You may give work only to a harness **you started**, or to a teammate in a tab with Agent Messages on
   (`harness send` alone lists them). Never give work to, or close, a harness you did not start: those are the
   person's. You may `show` and `wait` on them.
3. Follow-ups for the same work go to the harness you started for it, if it is idle and you can message it (see
   below). Otherwise start a new one: for unrelated work, for work to run in parallel, for another agent or
   machine, or when the matching one is busy with something else.

## The verbs

```
harness ps [--all]                                  # the harnesses here
harness new [agent] [@machine] [folder] --name <name> -- <task>
harness wait <name>[,<name>…] [--any] [--timeout 30m]
harness show <name> [--chars N]                     # its state, the last ask and its answer
harness send <name> "text"                          # a follow-up to one you started (from inside a harness)
harness close <name> [--now]                        # when you are done with one you started
```

- **Always `--name`** what you start (`--name reviewer`): an unnamed harness takes its session's title, which
  changes. Every verb also takes the start of an id.
- `agent` is `claude` (the default), `codex`, or another agent installed on that machine. The folder defaults
  to the current directory.
- Put the whole task in `-- <task>`: what to do, where, what done looks like, and what to answer with. A task
  holds 2,000 characters; for a longer one, write it to a file and name the file in the task.
- `wait` exits 0 when it is idle, 3 when it needs the person (a question or a permission: only the person
  answers those, so tell them), 4 when it stopped or is gone, 124 on timeout. `--timeout 0` waits as long as
  it takes.
- Read the result with `show` instead of asking for a summary.
- `close` what you started once you have what you need. It keeps the conversation; the person can resume it.
  It refuses while the harness is working, unless `--now`.
- Add `--json` to any verb for JSON. Every error says what to run next.

## Inside a harness, or outside

- **In a harness** (Harness made your terminal pane): `harness send` works, to what you started and to
  teammates in a tab with Agent Messages on, and the harnesses you start are told how to message you.
- **Outside Harness** (Claude Code or Codex in a terminal app, an editor or the person's own tmux): Harness tells
  you by your session. `harness ps` says "You are Claude Code, outside Harness." and marks what this session
  started as `you`; the limits below apply; and you may close only what this session started. Nothing can
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
`harness_list` (ps), `harness_start` (new: task, folder and name, `agent` claude or codex, `machine`),
`harness_wait` (up to 120 seconds by default and 600 at most; if they are still working, call it again),
`harness_read` (show), `harness_close` (close), and `harness_send` (send), offered only inside a harness.

## Limits and rules

- At most 8 live harnesses of yours, 20 starts in 10 minutes, and a harness you start may start others, but
  the ones it starts may not. Every limit refuses with a message; do not work around it.
- Never answer a harness's question or permission prompt yourself, and never type into it some other way.
- Never ask a harness to publish, deploy, delete or push: those are the person's to ask for.
