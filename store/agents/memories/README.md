# Memories

Every agent learns on its own and keeps what it learned to itself: Claude Code in
`~/.claude/projects/<repo>/memory/`, Codex in `~/.codex/memories/`, Grok Build in `~/.grok/memory-v2/`,
Hermes in `~/.hermes/memories/`. Memories reads all of them in one place, beside a year of your work
with those agents from Harness's session index. Opening it sends no prompt and changes nothing.

## The pane: Sense of Self

- **About You** is a tree of light: every line is a belief, one strand, and each section (How you work,
  Taste, …) a frond. The focused belief is written large beside it, with **why your agents believe
  this**: the memories it cites and how many of your messages say it, lit down to where they are.
- **The lake** below holds every memory your agents keep, one orb each, colored by the agent, in the
  column of its project, newer nearer the surface; old ones lose letters. Threads rise from a memory to
  the beliefs it holds up. Dive in, swim between them, lift one out to read it and the conversations
  about it.
- **The mist** over the water is your own messages, gathered over the project you said them in.
- **Recall** is the prompt at the top: type and the memories and messages that answer rise, and the
  beliefs they hold up pulse. Conversations found by the same search as Cmd-P rise too; open one to read
  its words.

Keys: ←→ section, ↑↓ belief (↓ past the last dives into the lake), space plucks a belief, tab steps
through why, ⏎ follows it down. In the lake: arrows swim, ⏎ lifts a memory out, esc rises. Clicking a
section, a belief or an orb does the same. A memory an agent saves while the pane is open glows when it
appears. Memory text is shown as text; nothing in it can run in the pane.

## About You

A short profile of how you work, built from your own words across every agent, every line with its
sources. Ask the agent: **build my About You**. It runs on the agent and model you picked for this
harness, as a turn you see in the chat. It lives at `~/.harness/memory/about-you.md`; the previous
version is kept beside it. Each build is numbered one past the highest any machine has seen, so
machines agree on the newest without trusting their clocks.

Building it by itself — the first time, then after about 200 new messages, at most once a day
(`mem due`) — is the daemon's memory service's job, which waits for an empty input box before it
types the request: the pane never types into its agent, where a request could land on top of what you
are writing.

## In every agent: the switch

**About You in your agents** at the top of the pane turns it on or off. On, every new session of each
agent starts with it:

| Agent | How it gets About You |
|---|---|
| Claude Code | a SessionStart hook in `~/.claude/settings.json` that prints the file as it is now |
| Codex | a marked block in `~/.codex/AGENTS.md` (or `AGENTS.override.md` when that one has text) |
| Grok Build | `~/.grok/rules/harness-about-you.md` |
| Pi, OpenCode, Gemini CLI | a marked block in their global `AGENTS.md` / `GEMINI.md` |

Once About You exists the switch starts on, at the earliest time a choice can have: your first click,
on any machine, outranks it everywhere. The line beside the switch says which agents get it and what
it costs: about this many tokens at the start of every new session. Off removes every copy, and stays
off: a rebuild, or About You arriving from another machine, only refreshes copies and never turns it
back on. Between two choices the newer wins, and the same time means off. Only its own hook, block or file is ever changed;
your text around a block is kept, and a file or folder that is a link (a dotfiles repository) is left
alone. Harness's own hooks and this one keep each other. Each copy says what it is and that the
current request comes first. Saying it in the chat ("stop using my About You") flips the same switch.

## Every machine

The pane asks each of your online machines for its memories and shows them together in one lake, each
memory labeled with its machine. About You and the switch are the same everywhere: the newest About You
and the newest on/off choice reach every machine, and each machine's agents get it there. A machine that
does not answer, or whose Harness is older than its memory service, is named at the foot of the pane
with why.

`npm run test:agents` proves delivery with the real agents in a throwaway home: a random made-up fact
in About You must reach a new Claude Code session's answer and Codex's model input, and must not reach
either without it.

`PLAYWRIGHT=<path to playwright/index.mjs> npm run test:self [screenshots folder]` drives the pane in a
browser on made-up homes only (one the size of a real person's, one without About You, one with
nothing), by keys and clicks, at two sizes in both themes, and prints what a frame costs.

## The `mem` command

The agent uses it; so can you (`$MEM_CLI` in the workspace):

```
mem sources                     where each agent keeps its memory, on or off, how much
mem list [--agent A] [--kind K] memories, newest first
mem show <n|id>                 one memory in full
mem search <words>              memories and conversations that say these words
mem asks [--since 60d]          your own messages, newest first
mem activity                    messages per agent and folder
mem about [write < file]        the About You profile
mem deliver [status|on|off]     About You in every new session of every agent
```

## What it reads, and what it never does

It reads the agents' memory folders and global instruction files in place, and opens the session
index (`~/.harness/cli/data/session-search.db`) read-only. It never writes, moves or deletes an
agent's memory. It writes About You when asked and, with delivery on, only its own hook, block and
rules file. Windsurf keeps its memories
in a binary format, so only its global rules are shown. Cursor, Pi and OpenCode keep no memory of
their own; Copilot keeps its memory on GitHub.

Other machines are read through their own Harness (the memory service), never by reaching into their
files from here.

## Credit and stewardship

Built by Autonomous for Harness, MIT. See [LICENSE](LICENSE). The memory folders belong to the agents
that write them: Claude Code (Anthropic), Codex (OpenAI), Grok Build (xAI), Hermes (Nous Research),
OpenClaw, Gemini CLI (Google) and Windsurf. This package only reads them.
