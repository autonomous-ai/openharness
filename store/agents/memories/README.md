# Memories

Every agent learns on its own and keeps what it learned to itself: Claude Code in
`~/.claude/projects/<repo>/memory/`, Codex in `~/.codex/memories/`, Grok Build in `~/.grok/memory-v2/`,
Hermes in `~/.hermes/memories/`. Memories reads all of them in one place, beside a year of your work
with those agents from Harness's session index. Opening it sends no prompt and changes nothing.

## The pane

- **The band** at the top: your messages per day over the past year, each day tinted with the agent you
  talked to most, with totals and each agent's share.
- **About you**: the profile the agent on the right builds from your own words (below), then everything
  your agents saved about you — Claude Code's user and feedback notes, Hermes and OpenClaw profiles,
  Grok Build's global topics, what you asked Codex to remember.
- **Projects**: what each agent knows about each repository, with how much you worked there.
- **Notes and summaries**, **What you told them** (your global CLAUDE.md, AGENTS.md and rules), and
  **Agents**: where each one keeps its memory, whether it is on, and how to turn it on.
- **Search** filters memories as you type, fzf-style, and searches your past conversations too.

Keys: ↑↓ move, → or ⏎ open, ← back, esc clear. A memory an agent saves while the pane is open glows
for a moment. Memory files are shown as text; nothing in them can run in the pane.

## About You

Ask the agent: **build my About You**. It reads your own messages across every agent and what your
agents saved about you, keeps only what recurs or what you stated as a rule, and writes a short
profile to `~/.harness/memory/about-you.md`, every line with its sources. It runs only when you ask,
with the agent in this pane. The previous version is kept as `about-you.prev.md`.

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
```

## What it reads, and what it never does

It reads the agents' memory folders and global instruction files in place, and opens the session
index (`~/.harness/cli/data/session-search.db`) read-only. It never writes, moves or deletes an
agent's files; the only file it writes is About You, and only when asked. Windsurf keeps its memories
in a binary format, so only its global rules are shown. Cursor, Pi and OpenCode keep no memory of
their own; Copilot keeps its memory on GitHub.

This computer only, for now. Memories on your other machines appear when you open Memories there.

## Credit and stewardship

Built by Autonomous for Harness, MIT. See [LICENSE](LICENSE). The memory folders belong to the agents
that write them: Claude Code (Anthropic), Codex (OpenAI), Grok Build (xAI), Hermes (Nous Research),
OpenClaw, Gemini CLI (Google) and Windsurf. This package only reads them.
