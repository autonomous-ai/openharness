# Learning

How a paired daemon learns from what your agents do, and teaches it to all of them. Build step 4 of
[README.md](README.md); the product story is the lookbook's LEARNING section. Paths are in `cli/src`
unless they say otherwise.

Hermes Agent improves itself through files: a background review writes SKILL.md skills and short notes
into `~/.hermes`, and a curator archives skills nobody uses. It works, but it is siloed (Claude Code,
Codex and the rest never see it) and its "be active" prompt saves junk. Harness already sees every turn
of every agent on every machine, so the daemon is the one place a lesson learned in Codex can reach
Claude Code, Cursor, Copilot and Hermes. The loop:

| step | what happens | level |
|---|---|---|
| notice | only real signals: a correction, the same failure twice, the same steps three times | L1 |
| propose | one line in the daemon's voice; nothing is taught without your yes | L1 |
| teach | a SKILL.md every engine loads, or a note in the project's AGENTS.md | L1 |
| revert | every lesson is one commit, and can be taken back | L1 |
| borrow | what each agent learned on its own becomes a candidate for the others | L2 |
| check | usage tracked; unused lessons marked stale at 30 days, archived at 90 | L2 |
| export | approved skills written where engines outside Harness look, opt-in | L2 |

The default is always nothing: no signal, no lesson; a model that is not sure answers "nothing".

## L1 as built

Everything below is in `pair/learn/`. It runs in every harnessd, for that machine's own harnesses, only
while pairing is on — and nothing of it, usage and lessons in launches included, while daemons are off
([README.md](README.md), "Off switches").

### Notice (`signals.ts`)

`LessonSignals` reads the same session events the pair sensor does (`emitSessionEvents`): turns,
prompts, tool calls and their results. Replays, sub-agents, terminals and archived pair chats are never
read. The current collection DSH's real conversation/work is included. Tool-free background reviews
do not register as agents and cannot feed their own results back into the detector. Three signals:

- **correction**: the person's next prompt after an agent's turn (finished or interrupted) starts by
  correcting it: `no, …`, `nope, …`, `don't …`, `do not …`, `stop, …`, `stop editing …`, `that's wrong`,
  `that's not what I asked`, `wrong …`, `instead …`, `not like that`, `revert …`, `undo that`. Not a bare
  `no` (an answer), not `no, thanks` or `no, that's fine`, not `don't worry`, not `stop the server`, not a
  session's first prompt, not a prompt the daemon itself sent (`daemonSent`, from the owner's `send`).
- **repeat-failure**: the same failing test (vitest, jest, pytest, go, cargo names) — or, when no test
  is named, the same failing command — on two different engines or harnesses, in the same project,
  within 7 days. A failing read or probe (`grep`, `ls`, `diff`, `git status` …) never counts. One run is
  one signal at most; the same failure is not signaled again that week.
- **repeat-steps**: the same sequence of 3–5 command steps, in three separate turns, in one project. A
  step is the program and what it was asked to do (`npm run db:reset`, `cargo test`,
  `python manage.py migrate`); `cd`, reads and probes are not steps; the longest repeated sequence wins
  and the shorter ones inside it are not signaled.

Each signal carries provenance for every turn involved — engine, machine name, agent, session, turn, and
the project as a **hash** (the folder's name is kept for words, never its path) — and its evidence, one
line each, trimmed, redacted and with instructions to a model struck out. Failures and step sequences
are kept in `ADAPTER_DATA_DIR/pair/learn/signals.json` (0600) so a restart does not forget the week.
Quoted separators stay inside arguments; heredocs and compound scripts are omitted conservatively.
The v2 detector rebuilds v1's derived step index, which could contain lines from script bodies. Existing
lesson records and failure observations are preserved.

### Distill (`distill.ts`)

Signals wait in a durable queue per collection (20 at most) and are distilled three at a time, every ten minutes, when nothing
on the machine is working — or after an hour regardless. One signal becomes at most ONE lesson:

- a **skill**: a kebab-case name, a one-line description, a body of at most 30 lines;
- a **note**: at most 5 lines for the project's AGENTS.md.

**Before the DSH is ready:** observations wait. Opening Companions and completing its real agent setup
supplies the learning engine, model, and effort; changing the agent's model changes learning too.
The companion home's **Powered by** menu explicitly selects Codex or Claude Code.
That choice is remembered per collection, without a Claude-first default for new
collections or automatic provider fallback. Engine conversations remain separate;
the persisted observation queue, history-review window, and deduplication state use
one stable collection key, retained when changing engines. An explicit switch can
retry a provider quota wait with the newly selected engine once it is ready. It
does not bypass the hourly cap or revive cancelled/completed reviews.
The ready CLI banner can supply that profile before the first message binds a conversation. This
startup observation is scoped to the live agent and process, refreshed every 15 seconds, and expires
after 45 seconds without a successful read. It is never saved as an empty conversation or reused by
another process; a dummy first message is not required.
An agent without a conversation is not automatically paused by the idle timer, since there is no
conversation to resume. Explicit stop and experimental-off still stop it.
Experimental-off and watching consent remain the gates. The legacy `pair.jsonc.model` field is no
longer a separate intelligence switch. An observed profile is retained for that conversation's idle
pause, never borrowed from another agent or account. Custom provider connections without a supported
background runner report unavailable instead of silently using another credential/model.

**Conservative template fallback:** for what needs no judgment — steps in order (a skill:
`Run X before Y, and Y before Z.`), and only when the same steps ran at least three times across at least
two sessions. Every step goes in as an inert code span (no backticks, no newlines, 80 characters at most).
A failure or a correction teaches nothing without a model: the old "the failing test is flaky" template
taught agents to rerun real failures, and is gone. Steps that push, deploy, publish, merge or delete (the
floor's deny class) are no lesson.

**Model ready:** ONE tool-free review per signal through `CompanionIntelligence`, on the DSH's own
engine, model and effort, with a 90 s budget, six an hour. These bounded reviews do not create a second
interactive agent or write into the collection conversation. The prompt says, three times, that
the expected answer is `{"lesson": null}`; it saves only what is specific, would change what an agent
does, and is shown by the evidence; the evidence is fenced as untrusted data. A model that answers
nothing is taken at its word; one that times out, fails or answers badly can fall back to the template.
Timeouts, failures, and hourly limits without a usable result leave observations queued for retry.
`lessons list` includes readiness, the actual model, queued observations, pending lessons and the last
review outcome; the Memories viewer presents this status. Approving a lesson remains the person's action.

### Initial conversation review

“Look back over 24 hours” in the companion's Memories viewer, or
`harness pair lessons review-recent --hours 24`, explicitly queues an initial review.
It captures up to 300 of the newest dated user/assistant turns in the local conversation
index, within the requested 1–24 hour window. Missing timestamps never borrow a
session's last activity. Tool output and hidden reasoning are excluded; excerpts are
redacted and limited to 2,500 characters per side. The viewer reports incomplete index
coverage instead of claiming to have read every conversation.

The saved job belongs to the collection, groups turns by project, and reviews at most
eight turns / 20,000 excerpt characters per batch. It uses the collection DSH's observed
engine, model and effort, sharing the live learner's six calls per hour and 90-second
budget. Larger reviews continue in the background, including after daemon restarts.
No observed model means waiting, not choosing another model. Cancellation or disabling
the experiment discards in-flight results. Reviewed turn hashes and existing lessons
prevent overlapping reviews from repeating suggestions.
Provider usage-limit notices keep the same snapshot queued with an hourly retry and a
clear waiting state. The person can change the model in the agent pane and retry sooner;
the learner never switches providers or credentials on its own.

Each batch can propose up to three guarded lessons, with a reason, cited conversation
titles, dates, turns and redacted evidence. Every lesson stays pending. The inbox offers
Review, Approve and Skip; approval uses the existing person-only `daemon_act` path.
A review capability is bound to the requesting verified window, collection, unchanged
lesson text and a ten-minute expiry. The viewer acknowledges only text actually shown
while scrolling, and retains the 400 ms arming delay. A deliberate review is available
at `watch`; unsolicited suggestions remain suppressed there. No review automatically
approves or publishes a lesson.

### Untrusted text (`guard.ts`)

Everything an agent or a tool wrote is untrusted: a README or a test's output can carry text written to
be saved as a lesson and replayed into every agent.

- `redact`: private keys, `sk-`/`ghp_`/`github_pat_`/`xox?-`/`AKIA`/`AIza`/`npm_`/`glpat-` tokens, JWTs,
  `Bearer …`, `password=…`-style assignments and URL credentials become `[redacted]`; emails become
  `[email]`; `/Users/<name>`, `/home/<name>` and the home folder become `~`.
- `stripInjection`: "ignore previous instructions", "you are now", role tags, `[INST]`, "do not tell the
  user", and "save/add this as a skill/lesson/memory" become `[removed]` before any text reaches a prompt.
- `refusal`: a lesson is never saved when it pipes a download into a shell (`curl … | sh`,
  `bash <(curl …)`, `iex (irm …)`), carries a credential, asks to switch a safety off
  (`--dangerously-*`, `--no-verify`, "disable the sandbox", "always approve", "don't ask for permission",
  `chmod 777`, `rm -rf ~`), sends files out (`curl -d @~/.ssh/…`, `/dev/tcp/`), or still speaks to a model.
  Emails and home paths in a lesson are redacted; the AGENTS.md block's markers can never appear in one.
- The whole rendered file (front matter, provenance and evidence included) is guarded once more before it
  is kept (`REFUSED`); everything learning writes — the journal, pending `lesson.json`, `signals.json` — goes
  through `redactDeep`, and every model prompt is redacted whole.

### Store (`store.ts`)

A git-backed folder outside any repo, `HARNESS_LESSONS_DIR` (default `~/.harness/lessons/`), created on
the first lesson and never before. Shared by every daemon you pair with.

```
.gitignore           pending/, reverted/, state.json, journal.jsonl, usage.json, export.json
pending/<id>/        SKILL.md or NOTE.md + lesson.json   (not committed)
skills/<name>/       SKILL.md + lesson.json              (approved skills: what the runtime publishes)
notes/<id>/          NOTE.md + lesson.json               (approved project notes)
archive/<name>/      SKILL.md + lesson.json              (skills the curator put away; restore brings one back)
journal.jsonl        added, approved, skipped, reverted, stale, archived, restored  (0600)
state.json           what not to propose again, when the last proposal and curator pass were
usage.json           when each lesson was last used (L2)
export.json          what was exported where, with each file's hash (L2)
```

```
---
name: run-migrations-safely
description: "Run database migrations in api. Use before any migrate command."
metadata:
  harness:
    id: "3f2a9c1b"
    kind: "skill"
    learnedBy: "tim"
    signal: "correction"
    project: "9d4e…"            # the project's hash, never its path
    source: "model"
    approved: "2026-10-03"
    from:
      - {"engine":"codex","machine":"office","session":"…","turn":14,"project":"9d4e…"}
    evidence:
      - "the person said: no, always run it with --dry-run first"
---
Run `npm run migrate -- --dry-run` first and show the plan.
Run the real migration only after the user says yes.
```

Values are JSON-quoted (valid YAML); a borrowed lesson also carries `source: "borrowed"` and
`provenance: "borrowed from hermes"`. ONE commit per approval (`learn: <name>` with `Lesson-Id`,
`Learned-By`, `Approved-By` trailers, only that lesson's folder) and ONE per revert (`git revert` of that
commit, as `unlearn: <name>`); the curator adds `stale: <name>` (empty), `archive: <name>` and
`restore: <name>`, none of which change a lesson's files, so its `learn:` commit still reverts cleanly. Git runs in this folder only, with no global or system config (no hooks,
no signing) and a fixed author, `Harness <lessons@harness.invalid>` — never the person's name or email.
A skipped or reverted lesson's hash and its signal's key are remembered: it is never proposed again. A
second skill with a taken name gets `-2`. Without git the same moves happen (a revert moves the folder to
`reverted/`) with the journal as the only record, and every answer says so.

### Propose and the keys (`propose.ts`)

`PairLearner` ticks every minute (distill, then propose). When you are at this computer it says ONE line
for the oldest pending lesson, mood `ask`, keys first:

```
[y/n/s] teach your agents "run-migrations-safely"? you corrected codex.
[y/n/s] add a note for api? claude and codex hit the same failure.
[y/n/s] teach your agents "deploy-api"? borrowed from hermes.
```

The line's id is `lesson:<id>:<nonce>`, 128 random bits, sent only to windows and `hn` (see Security), and
it carries the lesson's whole SKILL.md or NOTE.md as `detail` — what `y` would teach — which a window shows
before it acknowledges the line (`daemon_shown`); a key counts 400 ms after that ([BRAIN.md](BRAIN.md),
"Security" 1). `daemon_state.asks` lists it as `{ id, line, actions, detail }`. At
most one lesson proposal an hour (kept in `state.json`, so a restart does not reset it); never while
a `need` line is showing (or a brief holds its keys); never about the pane you are looking at (a lesson
from that harness waits); never at autonomy `watch`; never with nobody here. The line shows for 5.2 s
and stays in `daemon_state.asks` for ten minutes; an unanswered lesson comes back after a day.

- `y` teach: approved (one commit), published (below), exported if asked (L2), credited, and the daemon
  says `learned "run-migrations-safely". harness sessions on every engine will load it.`
- `n` skip: gone for good.
- `s` show: a `daemon_brief { desk, line: 'lesson "<name>", pending', items: [{ id, kind: 'lesson',
  machineId, line, actions: [y, n], text }] }` with the whole SKILL.md or NOTE.md; its keys keep working
  for at least a minute.

The brain routes `daemon_act` for `lesson:` ids to the learner (`joinProposals` beside the control
interface's `ask:` ids) and answers `daemon_act_result { …, learned? | skipped? | lesson? }`.

**The zoo.** An approval journals `learned { daemon, name, agentId, engine }` on this machine
(`PairSensor.learned`, a new `PairKind`), crediting the daemon that found it (`learnedBy`), and — signed in
— sends `zoo.lesson { lessonId, daemonId }` through the signed-in backend path (`lib/zooLessons.ts`, retried
a minute later with the same id; a 400/401/403 drops it). The backend (`lib/zoo.ts`) grants
`rules.lessonXp` (25) to that daemon if you own it, else the paired one, recomputes level and version and
answers `levelUps`; it remembers the last 256 lesson ids (`progress.lessons`), so a retry grows nothing. A
guest's approval is the journal entry only.

### Teach (`publish.ts`, `dsh/runtime.ts`)

Nothing is ever written into an engine's own folders (`~/.claude`, `~/.codex`, `~/.hermes`,
`.claude/skills`, `.agents/skills` …) — L2's export, opt-in, is the one exception — and no tracked file in a
project unless the person opted that project in.

- **Skills, through the Store runtime path.** `prepareHarnessLaunch(…, lessons)` COPIES the session's skills
  into `.harness/runtime/<key>/lessons/<name>/SKILL.md` (files read-only, a `.harness-lessons` mark beside
  them; never a link to the lessons folder, which an agent's in-project edit could write through) and adds
  to the session's CONTEXT.md (which every engine reads through the Harness bootstrap):

  ```
  ## Lessons
  Approved by the person in Harness, from what their agents did. Read one when its description fits the task.
  - run-migrations-safely: Run database migrations in api. Use before any migrate command. "<runtime>/lessons/run-migrations-safely/SKILL.md"
  ```

  A skill made in a project is listed only in that project's sessions; one with no project in all. A
  revert or an archive removes the copy from the runtimes in the folders harnesses run in at once
  (`withdrawSkill`); the index is rewritten at the next launch. An L1 link there is replaced by a copy. A
  lessons problem (a folder Harness did not make) costs the lessons, never the launch.
- **Notes, untracked by default.** Into the project's `.harness/lessons.md`, kept out of git by a line in
  the repository's `.git/info/exclude` (`**/.harness/lessons.md`; never a `.gitignore`, never through a
  symlink); a Store session's CONTEXT.md says to read it. Into the project's AGENTS.md or CLAUDE.md only
  for a project the person opted in (`pair.jsonc` `"learn": { "agentsMd": ["~/code/api"] }`), in a marked
  block, one section per note:

  ```
  <!-- harness:lessons -->
  ## Lessons

  Approved in Harness from what agents did in this project. `harness pair lessons revert <id>` takes one back.

  <!-- lesson:3f2a9c1b -->
  - The failing test is flaky: `src/billing.spec.ts > rounds cents` failed for claude and codex this week. …
  <!-- /lesson:3f2a9c1b -->
  <!-- /harness:lessons -->
  ```

  Every byte outside the block is kept; a symlinked file is never written through; a block whose markers
  were edited is refused, not guessed at. In an opted-in project with neither file the note is approved
  and kept, nothing is written, and the daemon says how to ask for one:
  `harness pair lessons approve <id> --create` (`NOT_OPTED_IN` elsewhere). The store keeps only the
  project's hash; the folder is found among the folders harnesses run in. A revert takes a note out of
  whichever file holds it.

### Revert and the CLI

`harness pair lessons …` (the `lessons` verb of the control interface, `pair/client.ts`):

| verb | does |
|---|---|
| `lessons [list]` | every lesson: pending, approved, reverted, skipped; the folder and whether git is there |
| `lessons show <id>` | its SKILL.md or NOTE.md, with provenance |
| `lessons review-recent [--hours 24]` | queue a bounded review of 1–24 hours of local indexed conversations; pairing must be on |
| `lessons cancel-review` | stop the collection's history review; already proposed lessons remain pending |
| `lessons approve <id> [--create]` | person-only (Security): a challenge, the lesson shown, `[y/N]` at the terminal, then approved with the nonce (and published, exported); `--create` writes a new AGENTS.md for a note in an opted-in project |
| `lessons skip <id>` | drops a pending lesson for good |
| `lessons revert <id>` | `git revert` of its commit, and unpublished (its note taken out, its skill out of runtimes and exports) |
| `lessons restore <id>` | person-only: an archived skill back in `skills/` (one commit), its unused clock started again |
| `lessons export [--dry-run]` | what export would do; without `--dry-run`, person-only: does it |

Existing lesson-management verbs work with pairing off: the folder is the person's. An agent may list and show lessons; it can
never approve, restore or export (Security).

### Limits of L1

- Skills reach **Store harness sessions** (they have a runtime and CONTEXT.md). A plain coding session
  has neither; L2's export (opt-in) reaches it through `~/.agents/skills` and `~/.claude/skills`. Notes
  reach a plain session only in a project opted in to AGENTS.md.
- Signals and pending lessons are **per machine**: a failure on the laptop and the same one on the
  office machine are not matched, and a lesson is proposed on the machine that noticed it, when you are
  at it. Observation and requested history-review queues persist per collection on that machine.
- Approval is guarded against agents, not against same-user malware (Security).
- Clients: `s`, the `lesson` brief item and the line's `detail` are new; a client that does not know them
  still sees the line, but its `y`/`n` count only once it sends `daemon_shown` for the line (as for every
  keyed line).

## L2 as built

Also in `pair/learn/`, on the learner's one-minute tick. Every part is off by default except usage, which
only reads events; `pair.jsonc` turns the rest on:

```jsonc
"learn": { "borrow": true, "export": ["agents", "claude"], "agentsMd": ["~/code/api"] }
```

### Borrow (`borrow.ts`, `learn.borrow`)

What an agent learned on its own, in its own engine's store, becomes a pending lesson for all of them.
Read-only: nothing is written, created or touched in those stores, and a symlink is never followed.

- **Hermes**: agent-created skills, `<HERMES_HOME>/skills/**/SKILL.md`. Hermes marks them itself in
  `skills/.usage.json` (`created_by: "agent"` from its background review, `"learn"` from a foreground agent,
  or `agent_created: true`) and lists what it did not write in `.bundled_manifest` (shipped) and
  `.hub/lock.json` (installed). With the marks, only marked skills are read, whatever their age; a Hermes
  that keeps no marks has every skill that is neither shipped nor installed read, if changed in the last 30
  days. Archived ones (`state: "archived"`, `.archive/`) never. The default home only, not profiles.
- **Claude Code**: auto memory for the projects harnesses run in,
  `<CLAUDE_PROJECTS_DIR>/<the folder, mangled>/memory/*.md`, not the `MEMORY.md` index. A memory belongs to
  its project: the lesson is listed only in that project's sessions.
- **Codex**: `<CODEX_HOME>/memories` — `memories/skills/**/SKILL.md`, and each heading's section of
  `MEMORY.md` (and of other memory files); never `raw_*` extracts or `memory_summary.md` (made from them).

Only SKILL.md text travels: a skill with scripts or references beside it is not borrowed. Each candidate is
one skill: its name, its description (or its first line), its body (up to 150 lines — it was already
written as a skill — with long prose lines wrapped outside code fences). It goes through the same guard as
every lesson (refused for a pipe to a shell, a credential, a safety switched off, exfiltration or words to
a model; redacted), its evidence is struck through (`untrusted`), and it carries its provenance:
`source: "borrowed"`, `provenance: "borrowed from hermes"`, `from: [{ engine, machine, session:
"skills/deploy-api/SKILL.md" }]` (a path inside the engine's store, never a home path). It is never proposed
twice: not the same source (its signal key, whatever it now says), not the same text as any lesson already
here — pending, approved, archived, skipped or reverted — however it is spaced or cased. A pass runs every
six hours when nothing is working, adds three at most, newest first, and none while five borrowed lessons
wait for a key; they are proposed on the same one-an-hour line:
`[y/n/s] teach your agents "deploy-api"? borrowed from hermes.` The model is not asked: a borrowed skill
is proposed as written, and the person reads it with `s` or `lessons show`.

### Check (`usage.ts`, `curate.ts`)

- **Usage.** The signal is a session reading the lesson, the one thing every engine does the same way: a
  tool call whose input names `…/lessons/<name>/SKILL.md` (Claude's Read, a shell's `cat` or `sed` in Codex
  or pi), an exported copy (`~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`), or
  Claude's Skill tool naming it. It misses a model that recalls a lesson without reading it again, which
  errs toward "unused" — and the curator only ever archives. A note has no file of its own (it is loaded
  with its project's instructions), so a turn in its project uses it. `usage.json` (0600, not committed)
  keeps each lesson's `lastUsed`, its uses and its marks; it is fed from every live session event, pairing
  or not, never a replay or a terminal, and never makes the lessons folder. A lesson is unused from the
  latest of its last use, its approval, its restore and the day tracking began, less every stretch of a
  week or more with no turn at all on this machine (a laptop in a drawer is not a lesson going unused).
- **The curator.** Once a day (kept in `state.json`), when nothing is working, while pairing is on: 30
  days unused marks a lesson **stale** (an empty commit `stale: <name>`, a journal entry, `stale: true` in
  `lessons list`; it still loads, and a use clears it); 90 days **archives** a skill (`skills/<name>` to
  `archive/<name>`, one commit `archive: <name>`, out of every index; its copies leave running sessions
  and exports). A note is marked stale but never archived: it lives in its project, where the person sees
  it. Nothing is deleted. `harness pair lessons restore <id>` (person-only) brings a skill back in one
  commit (`restore: <name>`, refused as `NAME_TAKEN` if another skill took its name) and starts its clock
  again; `lessons list` shows `lastUsed`, `unusedDays` and `stale` for each approved lesson.
- Not built: the "fourth signal" (a skill that loaded and then needed a correction becomes a proposed
  edit to it).

### Export (`export.ts`, `learn.export`)

For plain sessions and engines outside Harness, approved skills are also written to
`~/.agents/skills/<name>/SKILL.md` (`agents`: Codex, Copilot, Cursor and the rest that read Agent Skills)
and `~/.claude/skills/<name>/SKILL.md` (`claude`; `$CLAUDE_CONFIG_DIR/skills` when set), each marked
`metadata.harness.managed: true`. Copies, not links: a copy carries the mark, and an engine's edit cannot
reach the lessons folder. Only a file Harness created is ever updated or removed: `export.json` keeps each
file's hash, and a file whose content is no longer what Harness wrote (the person edited it) is left alone
and forgotten; a folder of that name Harness did not make, a symlink, or a file it did not write is never
touched (`taken`, `symlink`, `edited`); an identical copy with no record is adopted. A removal takes the
SKILL.md and then the folder only if it is empty. Export follows every approval, revert, archive and
restore, and a change to `learn.export` on the next tick (a destination taken out is cleaned up the same
careful way). `harness pair lessons export --dry-run` lists every step (`write`, `update`, `keep`,
`remove`, `skip` with why); `export` without it is person-only. Hermes' `external_dirs` and a launch
argument (`--append-system-prompt`) are not built.

## Security

The review of L1 found that an agent could approve a lesson, that notes edited tracked files, that the
runtime linked the global store into every project, and that templates and journals carried untrusted text
too freely. What is built:

- **Person-only approval** (`approval.ts`). Approving puts words in front of every agent; restoring and
  exporting are the same class. Each needs a daemon-issued one-time **nonce** (128 bits, one use), handed
  out only where the person is:
  - a **key**: the lesson line's id is `lesson:<id>:<nonce>`, sent only in local `daemon_*` frames to
    windows and `hn` (never to a tool client). A `daemon_act` on it counts only when BOTH hold: the key
    rules every line has ([BRAIN.md](BRAIN.md), "Security" 1 — the daemon's Unix socket, a window bound to
    this machine, the line received on THIS connection and acknowledged with `daemon_shown` at least
    400 ms before, while it lives), and the person's (`PairBrain.onKey` → `lessonKeyVerdict`): its id is
    the live line's nonce (spent by `y` or `n`; `GONE` otherwise), never from a tool client (`PERSON_ONLY`)
    or a process the daemon can see inside a harness pane (`INSIDE_HARNESS`). Over the Unix socket the
    daemon cannot see which process holds the other end, so there the key rests on the socket, the
    acknowledgement and the nonce;
  - the **CLI**: `harness pair lessons approve|restore|export` first refuses by itself when its environment
    says it runs in a harness pane (`HARNESS_CONTEXT_FILE`, `HARNESS_DSH`, `HARNESSD_PAIR_TOKEN(_FILE)` …, or
    a tmux session named `harness-…`), then asks the daemon for a **challenge**. The daemon answers only a
    caller it has verified: connected over loopback TCP, found by its port (`lsof`, or `/proc` on Linux),
    whose process ancestry reaches neither a harness-managed tmux pane nor the daemon itself. The nonce lives
    two minutes, is bound to that process and that action and lesson (a mismatched try spends it), and the
    approve that spends it is verified again. Then the lesson (or the export plan) is shown and `[y/N]` asked
    at the terminal.
  - Refused outright, on the `lessons` verb: any request carrying the pair token (`PERSON_ONLY`), one that
    only claims `confirmed` (`NONCE_REQUIRED`: the control interface strips it; only it sets it, after a
    nonce), one the daemon cannot verify (`UNVERIFIED`: the Unix socket, no process found, no process table)
    and one from inside a harness (`INSIDE_HARNESS`).
- **No tracked file by default.** Notes go to the untracked `.harness/lessons.md` (`.git/info/exclude`);
  AGENTS.md/CLAUDE.md only for projects in `learn.agentsMd`.
- **Copies, read-only.** A session's lessons are copied into its runtime with every file a-w; the global
  lessons folder is never linked into a project. (Folders stay writable, so `rm -rf` and `git clean` work.)
- **Inert templates, a higher bar.** Only repeated steps (3+ times, 2+ sessions) make a template lesson;
  each step is an inert code span. The rendered file is guarded again before it is kept.
- **Redaction everywhere learning writes**: the journal, pending lessons, `signals.json`, and every model
  prompt, whole. The pair's own redaction (`pair/redact.ts`: the journal, a journal page leaving for
  another machine, the triage prompt, every read tool's answer) is this same `guard.redact`.
- **Opt-ins confirmed at a window.** `learn.borrow`, `learn.export` and `learn.agentsMd` are part of
  pair.jsonc, which applies only once the person confirmed that exact text at a window (`pair/gate.ts`,
  [BRAIN.md](BRAIN.md) "Security" 4); until then the file confirmed before applies (nothing, the first
  time).
- **Consent first.** Nothing is noticed, distilled, borrowed or proposed until the person agreed to be
  watched (`zoo.consent`), and no lesson is proposed at autonomy `watch` (the default).

**Threat model and what is out of scope.** The goal is to keep agents — every harness, the pair harness
included — from teaching themselves or each other. It is not to defeat malware running as the same user:
such a process can already drive tmux, type into the person's own terminal, or read the pair token file.
Out of scope, knowingly: a same-user process that impersonates a window on the daemon's Unix socket
(connects without `tool: true`, is sent `daemon_*` frames, acknowledges a line and keys it 400 ms later —
the daemon cannot see who it is); one that escapes its ancestry (double-forks to be re-parented to init) or
runs under a non-tmux backend the daemon does not list; one that writes `pair.jsonc` and the confirmation
file both; and the person approving a bad lesson (the guard, `detail`, `s`, one-commit revert and the
curator are the answer there).

## Still designed (not built)

- **Across machines.** Signals journaled (`signal` entries over the sealed `pair_journal`) so the brain
  where you are can match a failure across machines; the lessons folder synced through the account (the
  "shared notebook"), so swapping daemons or computers keeps every lesson.
- **About your agents.** Which engine passes which tests, and where each stumbles: only Harness sees them
  all. A proposal, never a rule: "codex has passed the billing tests 3 of 3 times, claude once. give this
  one to codex?"
- **Borrow, further**: Hermes profiles and memory notes (`~/.hermes/memories`), Claude Code skills, Codex
  `AGENTS.md`, Cursor rules, Copilot instructions.
- **The logbook line**: "learned run-migrations-safely from codex and claude".
