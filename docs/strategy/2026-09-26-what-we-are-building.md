# What we're building

Strategy proposal, September 26, 2026. An opinion to argue with, not a decision. It builds on the
[terminal tools market research](../research/2026-09-26-terminal-tools-market.md) and
[who we're building for](../ideal-users.md).

**Harness is the operating layer for working with AI agents.** Your agents run on your machines, and
you work with them from anywhere, as one continuous workspace. The job is to keep many agents moving
on as little of your attention as possible.

- **The unit of work is the agent session.** It isn't the file (the editor's unit), the chat (the
  chatbot's) or the shell (the terminal's).
- **The metric is agent wait time:** how long agents sit blocked on you. Every surface should shrink
  it.
- **Every surface has its own job.** hn, the desktop app, the phone and the dial share one desk but
  don't try to do the same things.
- **The moat is the system,** not any single app.

## The shape: tmux, stretched across your day

tmux got the shape right in 2007: a server keeps sessions alive, and clients attach from wherever
you are. Harness is that shape for agents, across machines and devices:

| tmux | Harness |
|---|---|
| The server keeps programs running | **The daemon** on each machine: agents run where the code and compute are |
| The session: windows and panes | **The desk:** one shared workspace (tabs, focus, what's unread, the creatures) |
| Clients attach and detach | **hn, the desktop app, mobile, the web client and the dial** |
| ssh gets you to the server | **The relay and your account:** attach from anywhere, end-to-end encrypted |

What tmux did for programs that outlive your terminal, Harness does for agents that outlive your
attention. You start work at the desk, check it from the car, answer by voice, and come back to find
it done, all in the same session.

## Why agent wait time is the metric

Agents are getting faster every few months; people aren't. With one agent, you wait on it. With five,
it waits on you: a question sits unanswered, a finished turn goes unreviewed, and a blocked agent
does no work.

**Agent wait time** is the time agents spend blocked on a person, per unit of work done. It captures
what the product is for:

- **More agents per person** is only worth it if their questions get answered.
- **Answering from anywhere** (the phone in the car, the dial at the desk) turns dead time into
  unblocked agents.
- **Knowing which agent needs you first** (the waiting list, `next-waiting`, the ranked inbox below)
  matters more than any single view.

Supporting measures:

- Agents running in parallel per person.
- Time from a question to its answer.
- The share of answers given away from the desk.
- How many turns end without the person having to look at them.

The daemon already sees every question and every end of a turn, so all of these can be measured
without asking anyone.

## Each surface has its own job

The surfaces share one state (the same desk, unread marks and focus) and differ in features on
purpose. Nobody wants the phone to be a small desktop.

| Surface | When | Its job | Must be excellent at |
|---|---|---|---|
| **hn** (terminal) | At the keyboard, in flow | Power and speed; credibility with the tmux crowd | tmux and fzf exactness; zero latency; no mouse needed |
| **Desktop app** | At the desk | The overview: many agents, many machines, the visual harnesses | Seeing everything at once; CAD, slides, video and other viewers |
| **Mobile** | Away: the car, the couch, between meetings | Triage and answering; the daily habit | Voice; one-tap answers; the right notification at the right time |
| **Dial** | At the desk, ambient | Glance, speak, nudge | Voice to the right agent; moving between panes without looking |
| **Web client** | Any browser | A way in when nothing is installed | Pairing and a quick answer |

Two rules follow:

1. **Share the state, not the features.** Anything that describes the work (tabs, panes, unread,
   focus, names) lives in the desk and shows up everywhere. Anything about how you interact stays
   native to the surface.
2. **Mobile is the habit loop.** The phone is the one surface people carry all day, and answering an
   agent from the car is the moment the product becomes hard to live without. It deserves
   first-class design effort, especially hands-free voice.

## Who it's for

**Today:** people who already run coding agents and have more than one going at once. Agent use at
work went from 31% to 59% of developers in a year, and about 1 in 3 agent users already run several
agents at once ([market research](../research/2026-09-26-terminal-tools-market.md)). They're
the people for whom wait time hurts.

**Credibility:** the tmux, fzf and Neovim crowd, about 5M people who write the dotfiles, blog posts
and Hacker News comments everyone else reads. hn earns them by being exact: tmux's keys,
`~/.tmux.conf`, commands, formats and fzf's behaviour, unchanged. Like Vim with vi, the rule is to
keep every key, add on top, and put any behavior change behind an option.

**Where it grows:** people who build across disciplines ([ideal users](../ideal-users.md)). Start with
code, then use the Store's domain harnesses for CAD, circuits, slides, video and music. The same
desk, the same inbox and the same devices work for all of it.

## What we don't build

- **An editor.** 78% of Vim and Neovim users also use VS Code or Cursor, and only about 2% of
  developers use terminal editors alone. Sit beside the editor and link into it.
- **A model, or a bet on one vendor.** Claude Code at work, Codex at home, Hermes in the cloud. Stay
  neutral: switching agents should cost nothing, and every engine should feel native.
- **A terminal emulator.** hn runs inside Ghostty, iTerm2, Alacritty, WezTerm and the rest.
- **A chat app.** A conversation is one view of an agent session, not the product.

## Roadmap

### 1. One desk, truly shared (now)

Every client shows the same tabs, panes, unread marks, focus and creatures, live. The dial follows
whichever window is in front. Voice reaches any agent from any surface.

**Done when:** moving between hn, the desktop app and the phone loses nothing, and people stop
noticing which one they're in.

### 2. The attention inbox (next)

One ranked queue of everything that needs a person: questions, permission requests, finished turns
to review and failures. It covers all machines and agents, and you answer from any surface by keys,
tap or voice.

- **Ranking:** how long something has waited, how much work it blocks, and what the person cares
  about.
- **Hands-free mode for the car:** read the question aloud, answer by voice, confirm, and move to the
  next one, without looking at the screen.
- **Notification policy:** interrupt only for what's worth it; batch the rest.

**Done when:** agent wait time falls week over week, and a real share of answers comes from away
from the desk.

### 3. Orchestration

Agents that run agents: swarms, the roundtable, and the Store's domain harnesses working together.
The person moves from operator (answering each agent) to manager (setting goals, reviewing results
and steering). The inbox becomes a review queue.

**Done when:** one person keeps ten or more agents productive for a day with less attention than two
take today.

### 4. Together

Shared desks for teams: watch a teammate's agents, hand an agent off, and pair on one (see the
together prototypes). The desk becomes a team workspace, and the inbox routes questions to whoever
can answer them.

**Done when:** a team runs its agents from one shared desk, and handing off an agent is as easy as
handing off a pane.

## The moat

It's hard to copy because it's a system, not an app:

- **The daemon, the desk and the protocol** span machines, operating systems and devices. A vendor's
  own UI sees one agent family on one machine.
- **Neutrality.** Every major coding agent, side by side. Vendors won't build this for each other.
- **Hardware.** The dial is a physical presence on the desk that no software competitor has.
- **Open source, with end-to-end encryption.** The people who care most can read the code, trust
  the relay and extend it.
- **Exactness for the tmux crowd.** It takes real work to get right, and they're the loudest
  advocates once it is.

## Risks and open questions

- **Vendors build their own multi-agent views** (background agents, agent dashboards). The answer is
  neutrality, multiple machines and devices, but only if each engine feels native here.
- **Too many surfaces for the team.** Five clients can each become mediocre. The surface table above
  is the guard: each gets its one job done well before anything else.
- **Windows.** Mac and Linux first. The viewer app would take weeks, a WSL2 daemon more weeks, and a
  native daemon a quarter or more. Revisit when the demand shows.
- **Measuring wait time honestly** needs instrumentation in the daemon (question asked, question
  answered, turn reviewed) and a privacy stance on what leaves the machine.
- **How it makes money** (the device, team desks, a hosted relay or something else) isn't decided
  here. The roadmap above works with any of them, but the order of phases 3 and 4 may depend on it.
