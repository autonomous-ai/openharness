# Roundtable — a harness that puts N agents in the room

Design date: September 20, 2026. Status: design only, nothing built. Engine CLIs and flags below were
checked on this machine; everything else is proposal.

**Recommendation: build `autonomous/roundtable` — a tier-2 harness whose agent is a moderator, not an
author. It seats N coding agents from different vendors around one question, runs them in sealed
parallel rounds so they cannot anchor on each other, and draws the room as a matrix in the pane:
one column per seat, one row per round. The artifact is the disagreement.**

## Why this one is unlike every harness on the shelf

Every package in `store/agents/` is one agent making a thing: a board, a part, a deck, a scene. The
value is the artifact and the pane that draws it.

Roundtable inverts that. The artifact **is the conversation**, and the thing worth looking at is
where four models that were trained differently stop agreeing. Nobody gets that today: you ask
Claude, then you ask Codex in another window, then you hold two answers in your head and lose the
comparison. Putting them in one room, on one motion, in one view, is the product.

It is also the first package where `engine` in `harness.json` is only the **moderator**. The
panelists are not Harness sessions and not tiles — they are headless subprocesses the moderator
spawns (`claude -p`, `codex exec`, …). That matters: **no app change, no daemon change, no spec
change.** The DSH contract already allows it, because a harness may run whatever it likes from its
toolchain.

## The room

| Role | Who | Can write |
|---|---|---|
| **Chair** | the user, in the tile's chat | sets the motion, presses a seat, adds a constraint, closes the debate |
| **Moderator** | the harness's own agent (Claude Code) | the only process that touches the workspace |
| **Seats** | N headless engines, one subprocess each | nothing — they speak to stdout |

**One writer, N speakers.** Four agents with write access to one folder is not a debate, it is a
merge conflict. Panelists run read-only; the moderator files every turn. This is the rule that keeps
the whole thing sane, and it is also what makes the transcript trustworthy — one hand wrote it.

The moderator never argues. It frames, calls rounds, enforces the word cap, files the turns, tags
the claims, and writes the decision. If it has an opinion it declares it as a seat like anyone else.

## The protocol, and the one idea that makes it work

Rounds, in order. Each is a phase in the verdict strip.

1. **Motion.** The moderator turns the user's question into a motion with the constraints and the
   stakes written down, and proposes the seating. One user confirmation, then it runs.
2. **Openings — sealed and parallel.** Every seat answers the motion cold. No seat sees another's
   answer. They run concurrently, so this costs one turn of wall-clock, not N.
3. **Cross-examination — parallel again.** Each seat now reads all the openings and answers: what is
   wrong in the others, what did they miss, what do you concede.
4. **Chair's turn.** The pane is full of positions; the user presses one, adds a constraint, seats
   another engine, or calls it.
5. **Convergence.** Each seat states what it now agrees with, what it still refuses, and — the
   question worth the whole exercise — **what evidence would change its mind**.
6. **Decision.** The moderator writes the call *and attaches the dissent under it by name*.

**Sealed parallel openings are the design.** Run these agents in a chat loop and they converge on
whoever spoke first, politely, within two turns — you get four voices agreeing and learn nothing.
Independence has to be enforced by the protocol, not asked for in a prompt. Everything else here is
plumbing; this is the part that decides whether the harness is interesting or a novelty.

Second rule, same spirit: **a decision never averages.** It picks, and the minority position stays on
the page with a name on it. A verdict that blends four answers into mush is worth less than any one
of them.

## On disk

The pane watches a folder, so the transcript is files.

```
motion.md                     the question, the constraints, what would settle it
room.json                     the seats: id, engine, model, stance, session id, state
rounds/1-opening/<seat>.md    one file per seat per round; front matter carries the facts
rounds/2-cross/<seat>.md
rounds/3-converge/<seat>.md
claims.json                   claim x seat -> agree | disagree | silent  (the moderator's tagging)
decision.md                   the call, and the dissents by name
dist/index.html               the rendered room (what the pane serves)
.harness/verdict.json
```

Each turn file:

```markdown
---
seat: codex-skeptic
engine: codex
model: gpt-5.1-codex
round: cross
stance: "the position that this is not worth the migration cost"
elapsed_ms: 41200
---
```

Markdown, one file per turn, is deliberate: diffable, quotable, greppable, and re-runnable. A room is
a folder you can commit, and a decision six months later can be re-opened with the original motion.

## The pane

Layout is where this harness lives or dies. A chat log destroys the comparison — you cannot see four
answers to one question by scrolling. So: **a matrix.**

- **Columns are seats**, headed by the engine icon (`desktop/assets/engine-icons/` already has
  claude, codex, grok, opencode, pi, hermes, copilot, …) with the stance under the name.
- **Rows are rounds.** Read across a row to compare four minds on one beat. Read down a column to
  follow one mind changing (or not).
- **A seat still thinking** is a pulsing cell. Seats finish at different speeds and the room should
  show that honestly rather than wait for the slowest.
- **The claim map** under the matrix: rows are claims the moderator extracted, cells are agree /
  disagree / silent per seat. This is the one screen a busy chair actually reads — solid green rows
  are settled, striped rows are the argument.
- **Read mode** flattens it to a linear transcript for reading end to end, and to paste into a doc.

**Viewer, v1:** no new viewer package. A `render.mjs` in the toolchain rebuilds `dist/index.html`
from the folder on every turn, and the manifest says `"viewer": { "use": "autonomous/web-viewer" }`.
That is a day of work against a viewer that already exists and already reloads on change. If the
matrix earns it, graduate to `autonomous/debate-viewer` later — the folder format does not change.

## The verdict

The contract fits this harness almost suspiciously well.

| Field | Roundtable |
|---|---|
| `phases` | Motion · Openings · Cross · Converge · Decision — the rounds, exactly what the strip is for |
| `ready` | a decision is written and every seated engine answered every called round |
| `summary` | `4 seats · 3 rounds · agreed on 5, split on 2` |
| `findings` | `info` per agreement; `warning` `kind: split` per unresolved disagreement, `ref` the claim; `error` `kind: seat_unavailable` when an engine is missing or timed out |
| `artifact` | `dist/index.html` |

Writing the verdict after every turn is what makes the pane move, which the spec asks for and this
harness gets for free — there is a turn landing every few seconds.

## Seat plumbing

One script, `toolchain/seat.mjs`, dispatches per engine. Verified on this machine:

| Engine | First turn | Later turns | Read-only |
|---|---|---|---|
| `claude` | `claude -p --session-id <uuid> --model <m> --append-system-prompt <stance>` | `claude -p --resume <uuid>` | `--allowedTools Read Grep Glob` |
| `codex` | `codex exec -m <m> -s read-only -C <evidence>` | `codex exec resume <id>` | `-s read-only` |
| `opencode`, `grok`, `pi`, `hermes` | their own run/exec form | best effort | best effort |

Three things make this reliable:

- **Per-seat session memory.** Each seat keeps its own session across rounds (`--resume`,
  `exec resume`), so it remembers its own position instead of being re-fed the whole transcript every
  round. Cheaper, and it makes a seat behave like a person who has been in the room the whole time.
- **Timeouts, and absence is not failure.** A seat that misses its window is marked absent for that
  round and the room continues. Never block four agents on one slow vendor.
- **Seat what is installed.** `doctor.sh` reports which engine CLIs exist on this machine; the
  moderator seats from that list and says out loud who could not attend. A machine with only Claude
  still gets a room — same engine, different stances — it is just a weaker room, and the pane should
  say so rather than pretend.

## The feature that makes it more than a parlour trick: put the codebase in the room

An optional `evidence` path — a repo, a folder, a set of files — that every seat can **read
independently** before it speaks.

> "Should the daemon's Windows port be native or WSL2?" with `evidence: cli/`

Now four different models each read the actual process model, and disagree about the actual code
rather than about the abstract question. That is not something you can get from asking one model
twice, and it is exactly the shape of decision this repo's user keeps facing — the Windows port, the
Superterminal chrome, the Solid move. This is the use case I would lead the store page with.

## Preset rooms

| Room | Seats | For |
|---|---|---|
| **Panel** (default) | N engines, no stance | "what do the models actually think" — the purest multi-perspective read |
| **Red team** | one proposal, N attackers with no mandate to be fair | before you ship the decision |
| **Trial** | advocate · opponent · judge (judge is a seat, not the moderator) | a binary call with a real cost either way |
| **Bake-off** | each seat *builds* the small thing and they are compared | later; needs write sandboxes per seat, worth its own design |

Keep engine and stance on separate axes and show both on the chip, so you can always tell whether a
split came from a different model or a different assigned role. Conflating them would quietly wreck
the one thing the harness is for.

## Honest risks

| Risk | What it does to the product | Answer |
|---|---|---|
| Sycophantic convergence | four voices agreeing; the harness is pointless | sealed parallel openings; every round asks explicitly where you disagree |
| Verbosity | 4 × 5 essays nobody reads | hard word cap per turn, enforced by the moderator and truncated in the render |
| False balance | a decision that averages four answers into mush | the decision picks, and names the dissent |
| Cost and latency | N × R model calls per room | parallel fan-out keeps wall-clock at R turns; show elapsed and, where the CLI reports it, tokens per seat; ship a "quick room" of 3 seats × 2 rounds as the default |
| Theatre | a debate that entertains and decides nothing | every room ends in `decision.md` with a falsifier per open split; `ready` is false until it exists |

## MVP

Tier 2. `engine: claude`, `viewer.use: autonomous/web-viewer`, up to 3 seats from installed engines,
3 rounds, `decision.md`, verdict with phases. Folder layout as above.

Two prompts to prove it on, both live questions in this repo:

- *"Should OpenHarness support Windows natively or through WSL2? Evidence: `cli/`, and
  `docs/research/`'s port assessment."*
- *"Is a bottom command-line the right chrome for Superterminal, or is it nostalgia?"*

If the matrix on those two rooms tells the chair something they did not already know, build the
dedicated viewer. If it does not, the protocol is wrong and no viewer will save it.

## Name

**Roundtable**, `autonomous/roundtable`, category "Debate", author Autonomous. Alternate: **Quorum**,
which reads better against a verdict that has to reach a decision. Both are first-party names, like
Autonomous Circuit — there is no upstream project to credit here, because this harness is the
protocol and the pane, and both are ours.

---

## What changed when it was built (September 20, 2026)

The package is `store/agents/roundtable/`. It passes `harness dsh check`, the store shelf test, and
15 tests of its own. Four things came out different from the design above, all for the same reason —
the design trusted prompts where the build could enforce behaviour:

- **The seal is a working directory, not an instruction.** A seat never runs with the workspace as
  its cwd; it runs in the evidence directory or an empty scratch directory that is deleted after.
  Telling a seat not to peek at the other turn files is a request. Not giving it the path is a fact.
- **Seats are stateless per round, with the peers' turns replayed into the prompt** — not
  `--resume`. Session resume works on Claude Code and Codex and is guesswork on the other four, and
  a seat that carries a session also carries whatever it read last round. Replay is uniform across
  every vendor and keeps the seal exact: what a seat knows is what the prompt was told to include.
- **A turn starts at its position.** Several CLIs narrate their research before answering. Honest,
  but in a matrix cell it pushes the answer below the fold, so the runner trims to the first heading.
- **Shape is enforced in the system prompt**, identical for every seat — `**Position.** / **Why.** /
  **Strongest case against me.** / **What would change my mind.**` That is what makes a row of the
  matrix readable across: four cells that all open the same way.

Installed and seatable on this machine: Claude Code (read-only tools), Codex (`-s read-only`),
OpenCode and Grok Build (best effort — their CLIs cannot restrict tools). Pi and Hermes have
adapters but no credentials, so they show as absent with the reason, which is the behaviour the
design asked for.

### The first real room, and the bug it found

Motion: *"Should the Windows port be native, or WSL2?"*, four seats, evidence: this repository.

Claude Code and Grok Build both answered well and **disagreed on the load-bearing question** — is the
daemon genuinely tmux-shaped? Claude read `terminalBackend.ts`, found the tmux-only parts are three
*optional* methods of an 18-method interface, and argued the real cost is POSIX process identity
(`ps -axo`, `lsof`, `/proc`), which a native port does not get from ConPTY. Grok read
`restoreAgents.ts`, pointed out it exists precisely because a new tmux server reissues pane ids, and
that Herdr already implemented `TerminalBackend` without `respawn`/`openStream` and was retired.
Neither saw the other's answer. That is the product working.

Codex and OpenCode both hit the 900-second timeout with nothing. Not a vendor failure: asked the same
open question with the whole monorepo as evidence, they kept reading. Codex answers a narrow question
about the same file in 17 seconds. So:

- **Seats now get a research budget in the system prompt** — about 70% of the round's timeout, with
  an explicit instruction to read the three or four files that decide it and skip `node_modules`.
- **The moderator is told to scope `--evidence` to the folder the question turns on**, not the repo.
- **`room run <round> --only <seat>` refills one cell** without disturbing the turns already filed.

The general lesson is worth keeping: in a panel, an unbounded research task does not produce a slow
answer, it produces **no answer**, and the seats that fail that way are not the weakest models — they
are the most thorough. A room has to hand out a budget with the question.
