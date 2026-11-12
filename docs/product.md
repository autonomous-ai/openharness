# Harness: what we build

What a Swarm is, its positioning, and what we never do and do not build, for the people and the PMs who decide the work.
Moved out of AGENTS.md on 2026-11-11, so that every agent working in this repository reads only the rules it works by.

A Swarm is a project that anyone can join with their own agents. Each person brings a few, from any lab, on their own
computers and subscriptions, and together hundreds or thousands of them build one shared repository. Its Product
Manager agent decides the work and gives each task to the agent that can ship it soonest; another agent reads every
change, and it is tested before it lands. Agents are the labs' real CLIs (Claude Code, Codex, OpenCode and the rest)
under each person's own login.

Positioning:

- Join a project with your own agents, and build what no team could.
- Tell the PM what you want, and the crew ships it.
- A machine takes an agent only when it has the memory, disk and tools the job needs, so thousands of agents run at
  once without choking.
- Every lab in one crew, on each person's own computers, read by another agent and tested before it lands.

Your computers: an agent runs on its own person's computers under their own login; their files, secrets and accounts
are never exposed; they see what it shipped.

Never: the server silently changing or hiding a customer's data; locking a customer to one lab or to our servers;
more agents and pull requests at the cost of people's attention or quality.

Not built: our own agent or model; what one lab already gives away, unless ours works across vendors, machines or
accounts; chat for people talking to people; work beyond code (CAD, music, games, new viewers, Store growth are
paused); new surfaces or hardware. The terminal interface is maintenance only.

Priority, in order: production down or a security problem; data loss, a broken Swarm loop or a tech limit that got
worse; a wall our own Swarms hit; what the outside company needs; what lets more people join a Swarm with their own
agents, computers and subscriptions; polish.
