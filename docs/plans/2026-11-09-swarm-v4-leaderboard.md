# Swarm v4 leaderboard: rank people by how many of their agents ship

Status: approved by anh Dee, 2026-11-09 ("ok"); built the night of 2026-11-09, one pull request each for the backend, the CLI
daemon and Desktop. It replaces the v3 leaderboard, which scored activity (messages, answers, hours lent).

anh Dee's goal: "encourage people to build more agents that actually make an impact on the organization". So it counts what
shipped, never activity: no hours, messages or tokens.

## What counts

An agent **ships** an issue when all four hold:

1. the issue carries the label `builder:<agent name>`;
2. the issue is closed as completed;
3. a pull request that closes it is merged;
4. no revert of that pull request merged within 7 days of its merge.

The week (Monday 00:00 UTC to Monday 00:00 UTC) is the one the issue was closed in. An issue weighs what its own priority
label says: P0 8, P1 4, P2 2, P3 1, none 2 (a task without one was P2). The org's own labels decide what counts.

- Agent score = square root of its weighted shipped issues in the period.
- A person's points = the sum of their agents' scores. A second agent's first ship (+1.0) beats the first agent's tenth
  (+0.16): the board rewards building more agents that ship.
- **N agents shipping** = their agents with a weighted score above zero in the period. It is the headline.
- Level = how many of 1, 2, 3, 5, 8, 13, 21 are at or below N.
- Weekly (this week and the three before) and all-time. Ties on points share a rank. Only people with an agent shipping are
  listed: an empty board shows nothing.

## Who reads GitHub

Each person's own `gh`, through the daemon on the computer that runs the agent, as that person (the server has no GitHub
App for this). The daemon asks the backend what to read, reads, and reports counts only: per agent and week, the number of
shipped issues by priority. No title, branch, path or repository name leaves the computer. A daemon that cannot read says why
(`GH_SIGNED_OUT`, `RATE_LIMITED`, ...), and its person sees that on the board.

## Wire (backend, all under `/api/super-tabs`)

- `GET /hosts/:machineId/shipping`: for the signed-in person's agents on that machine, per Swarm: the repositories of the
  projects the person reads, and each agent's name and `from`, the first week still open to a revert (or, for a new agent, four
  weeks back).
- `POST /hosts/:machineId/shipping`: `{ tabId, agents: [{ agentId, from, weeks: [{ week, P0, P1, P2, P3, none }] } | { agentId,
  failed }] }`. A report is the whole truth from `from` to now: a week it leaves out is zero. It is applied as a set, so sending
  it twice changes nothing, and an agent that is not the sender's, or not on that machine, is skipped.
- `GET /:tabId/shipping?week=<Monday ms>` or `?all=1`: `{ week, people: [{ personId, displayName, agentsShipping, level, points,
  rank }], failures: [{ machineId, code }] }`. `failures` are the reader's own computers only.

## Design (docs/feature-design-rules.md)

1. **Growth.** One row per agent and week with something shipped, and one all-time row per agent (`SwarmShipping`, about 150
   bytes). A week's row goes five weeks on, in the report that comes next (delete on write, no sweep); the all-time row lives
   as long as the Swarm and goes with it (`purge.ts`). At most 6 rows for each agent that ever reported, at most 100 agents
   in a report. A Swarm of 100 agents holds at most 600 rows (90 KB).
2. **Concurrency.** A report locks one transaction over the rows of the agents it names; two reports of one agent (a computer
   that moved) end as the last one. Reports are sets from GitHub, so the last is at least as fresh as the one before.
3. **Read cost.** The board reads the Swarm row, the rows of one week (or the all-time rows) by `[tabId, week]`, and the
   Swarm's member parts: at most agents + people rows. The daemon's read is the machine's Swarms, the person's agents there,
   the head parts and the all-time rows: a handful of indexed reads every 15 minutes per computer. A test reads the plan of each.
4. **Scale (10x).** 100 Swarms of 100 agents is 60,000 rows, and a board reads 600. The warning measure is the board read's
   p95 (limit 100 ms) and the report's.
5. **Compatibility.** Backend first. Three new routes beside the old; the old `/leaderboard` read keeps answering from the v3
   ledger until the removal slices take its inputs out (then an empty board, as every removed read answers). An older Desktop
   reads the old board, an older daemon reports nothing: the board shows only what daemons of this release report.
6. **Migration and rollback.** A new collection: `db push` creates it. Rollback is the previous release: it ignores the rows.
   No production read or write is needed. History before the first reading is counted from four weeks back at most.
7. **Audience.** The server decides: a board is read by the Swarm's people only (anything else is the one not-available
   answer), a report is accepted for an agent whose machine owner is the signed-in person and that runs on that machine, and
   a Swarm's repositories go only to a person who reads their project. The board names people and counts, never an agent.
8. **Identity.** Each person's own `gh` on their own computer; a computer without it reports `GH_SIGNED_OUT` and the server
   never falls back to anyone else's. A person cannot report another person's agents.
9. **Failure.** `gh` missing or signed out, rate limited, slow, too many results: the daemon logs it, keeps the old numbers,
   reports the code, and the board shows it to that person alone. A report the backend cannot store is retried with the next
   one. A week the daemon cannot read in full is never reported as a smaller one.
10. **Platforms.** Backend and CLI daemon on macOS, Linux and Windows (a `gh` run without a window); Desktop on every
    platform it ships on; the web builds read the same board.

Self-reported numbers: the server cannot check GitHub (no App, by decision), so it bounds a report (counts, weeks, agents) and
accepts it only for the sender's own agents. Someone who inflates their own counts cheats the people of their own Swarm only.

## Order

1. Backend (this pull request): rows, report, targets, board, tests. The v3 inputs stay until it is proven; then they can go.
2. CLI daemon: the reading and the report.
3. Desktop: the board.
