# Harness: what we build

What we never do and do not build, for the people who decide the work. Moved out of AGENTS.md on 2026-11-11, so that
every agent working in this repository reads only the rules it works by.

Harness runs the labs' real coding agents (Claude Code, Codex, OpenCode and the rest) side by side, on every machine a
person links, under each person's own login.

Your computers: an agent runs on its own person's computers under their own login; their files, secrets and accounts
are never exposed; they see what it did.

Never: the server silently changing or hiding a customer's data; locking a customer to one lab or to our servers;
more agents and pull requests at the cost of people's attention or quality.

Not built: our own agent or model; what one lab already gives away, unless ours works across vendors, machines or
accounts; chat for people talking to people; work beyond code (CAD, music, games, new viewers, Store growth are
paused); new surfaces or hardware. The terminal interface is maintenance only.

Priority, in order: production down or a security problem; data loss or a tech limit that got worse; what the outside
company needs; polish.
