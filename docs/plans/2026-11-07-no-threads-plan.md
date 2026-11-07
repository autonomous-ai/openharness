# No threads: replies inline, quoting what they answer (backend and CLI) Plan

> Way of working: the project's Engineer role (plan first, each plan task test first, one pull request). No
> Execution Handoff.

**Goal:** anh Dee (11-07 18:56): every chat is one flat conversation, and each reply shows which message it answers. This
pull request is the server and CLI part of task #4555: the server never puts an agent's post in a thread, the
answer-in-thread setting is gone, and agents reply with `--answers`, except a Buddy session in its own thread (River, 11-07:
those become Member task sessions in the redesign). Desktop's part (no Thread panel, old thread replies inline with their
quote) is in #4529; the phone follows later.

**Architecture:** one rule in `commands.ts` (`placeAnswer`) decides where an agent's post goes, before anything routes it:
- any agent's post that names a message (`answers`, or an older host's `replyTo`) shows in the chat, quoting it: `answers`,
  no thread;
- the one exception is a Buddy's thread session (buddySessions.ts), whose replies must stay in its own thread, which its
  main Buddy never reads: it keeps `--reply-to` there, and only there.

The setting (`project.answers`, `answersInThread`) and the rule that threaded an answer to a thread reply are removed. Every
reply line says `--answers` but a Buddy session's, and the skills and the tools manual say `--reply-to` only for a Buddy
session. A delivered message that answers another quotes it, as a thread reply's did. The chat limits' refusals stop
pointing at threads.

**Tech Stack:** TypeScript (backend, CLI), vitest.

**Spec:** task #4555's brief (River, 11-07 18:57).

## Design

- growth: nothing new is stored. A project's stored `answersInThread` is no longer read or written.
- concurrency: unchanged: a post is one command in the Swarm's transaction.
- read cost: none added on the posting path. A delivery whose message answers another reads that one message by id, as it
  does for `replyTo` (one indexed point read).
- scale: unchanged.
- compatibility: backend first.
  - An older CLI host that still says `--reply-to` has its agent's post placed inline by the server.
  - An older Desktop or phone still posts thread replies, and still shows old threads, until it updates (#4529).
  - `project.answers` was only an agent command, shipped today. It is refused as an unknown command.
- migration and rollback: none needed. Rolling back brings the setting back, with every project off.
- audience: unchanged; the server decides where a post goes.
- identity: unchanged.
- failure: a refusal names what to do in a flat chat.
- platforms: backend (Linux), CLI (macOS, Linux, Windows).

## Global Constraints

- Backend and CLI only; Desktop is #4529.
- Old clients keep working: a person's thread reply from an older app still lands in its thread.
- A Buddy session's replies never reach its main Buddy.

## Review Focus

- `placeAnswer`: every agent post that names a message lands inline, except a Buddy session's in its own thread.
- The quote for `answers` on a delivery is marked when another account's agent wrote it, as for `replyTo`.

## Task 1: the server places no agent post in a thread

**Files:** `backend/src/superTabs/commands.ts`, `answers.ts`, `projects.ts`, `parts/touches.ts`; tests
`answers.test.ts`, `parts/touches.test.ts`, `buddySessions` tests.

**Interfaces:** `placeAnswer(command, context, state, actor)`.

- [ ] Test: the PM's answer to a reply in an old thread shows below it, quoting it (no replyTo, no thread), recorded with
  no thread.
- [ ] Test: an agent's `replyTo` becomes `answers`; a person's reply in a thread stays in it.
- [ ] Test: a project with a stored `answersInThread` answers below; `project.answers` is refused.
- [ ] Test: a Buddy session's `--reply-to` in its own thread still lands in that thread.
- [ ] Watch them fail; then change `placeAnswer`, remove the setting and the in-thread answer rule; watch them pass.

## Task 2: refusals point at what works in a flat chat

**Files:** `backend/src/superTabs/chatLimits.ts`, `answers.ts`, `commands.ts` (session refusal); their tests.

- [ ] Test: no refusal of an agent's post mentions a thread.
- [ ] Watch it fail; reword them; watch it pass.

## Task 3: a delivery quotes the message its message answers

**Files:** `backend/src/superTabs/store.ts` (`otherAccounts`), `cli/src/superTabs/host.ts`; `host.spec.ts`, store test.

- [ ] Test: a delivered message with `answers` comes with "Replying to …" as a `replyTo` one does; another account's agent's
  words in it are set off.
- [ ] Watch it fail; then quote `replyTo ?? answers`, and mark `answers` in `otherAccounts`; watch it pass.

## Task 4: every reply line and skill says `--answers`

**Files:** `cli/src/superTabs/host.ts`, `command.ts`, `cli/src/lib/swarmSkills.ts`, `swarmTools.ts`, `swarmToolSheets.ts`;
their specs.

- [ ] Test: the reply line says `--answers` for every message but a Buddy session's own; the reply rules say never to
  open a thread; the skills and the tools manual say `--reply-to` only for a Buddy session.
- [ ] Watch them fail; change the reply line, the rules, the usage and the skills; update the sheets' block hashes; watch
  them pass.
