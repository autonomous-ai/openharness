# The router: say what you want and it is done

Status: built on branch `auto-router-session`, 2026-10-10. Experimental.

## What a person does

⌘B opens one text box. Type what you want and press Return. It decides where the
task goes and does it, without a list and without a question:

- **A session it belongs to, on any of your machines:** that session's own pane
  comes forward — in whichever tab holds it; a session with no pane gets one in
  the current tab — and the words go into its prompt. The box shows who took it for
  a moment, then closes.
- **New work:** a new harness starts with the words as its task, set up as ⌘N then
  Return would make it (a fresh worktree from main in a Git project, in the
  permission mode last chosen for that agent), in the project and with the agent
  the router chose. A line says which. A project that cannot be read opens New
  Harness on the task instead of guessing.
- **Nothing decided** — Jev cannot be reached (no key, offline, no credit) or the
  router fails: the box says so and sends nothing.

There is no undo; the owner chose instant sends. Esc while the session's pane comes
forward still stops the words before they are typed. The safety is the bar: a session
is chosen only when Jev is sure, and everything else becomes new work, which costs
little and pollutes nobody's conversation.

The goal is for this one box to replace both ⌘P (go to a session) and ⌘N (make
one). Until it has proved itself, ⌘P and ⌘N are unchanged. ⌘B is the only place
Harness uses Jev.

## Where it lives

**The router is a subsystem of its own** (`cli/src/services/router.ts`), an
experiment in its own process that the master starts at its first request. It is
not part of the core and not part of the devices: the desktop is one client of it,
and the phone, the web, the TUI and the dial are meant to be the others.

It only **decides**. A client sends the task with the sessions it can see (live
sessions on connected machines, and stopped ones active in the last seven days that
can resume their own conversation; most recently active first, at most forty, each
with its last prompts and its last three turn summaries), the person's project
folders and the agents they use (`desktop/lib/state/task_route.dart`). The router
answers "this session" or "new work, in this project, with this agent". The client
acts through its own doors: the desktop types the task into the session's pane
(`deliverTask`), or creates the harness (`_createFromTask`). A stopped session is
resumed first and its pane comes forward once its terminal is up
(`resumeStoppedSession`, shared with ⌘P), so a resume that fails leaves no pane and
says why. So the router needs
nothing from the core, keeps no session list, and reaches no other machine.

Request (`ROUTER_REQUESTS` in `cli/src/core/api.ts`): `route_decide`. A daemon
without the router answers `UNSUPPORTED` and the box falls back to Boss mode's old
router; every other failure is nothing decided, never the old router, which sends on
its own when it is confident.

## How it decides

One request to **Jev 1.13** through OpenRouter's Decisions API
(`cli/src/lib/jev/jevClient.ts`, `cli/src/lib/routeDecide.ts`): "A person typed
this message to continue their work. Which of their ongoing sessions is it for?"
(or "none of them: new, unrelated work"), which project and which agent. A pick is
taken at 0.6 or more. A session is also taken below that when it leads clearly over
six options or more: 0.4 or more and at least twice the next option, "new" included.
Otherwise the task is new work, and a project or agent Jev is unsure of (under 0.6)
comes from the pane the person is in. A stopped session is described to Jev as
stopped, with how long ago it was last active.

Why the lead: a wrong send costs a conversation, a needless new harness costs a
harness, so the bar leans to new work. But Jev's probabilities are spread over every
session it is shown, and on the owner's desk every miss was Jev's right pick at 0.45
or 0.57. A pick that is twice anything else is Jev preferring it clearly; a pick
torn with new work, or with a session much like it, still becomes new work. Over
fewer than six options there is no spread to excuse a low pick (0.4 of four is 0.6
elsewhere), so the bar stands. The log
records the runner-up with every decision, to set these numbers from real use. The session the person last sent
to (within ten minutes) is told to Jev, so a short follow-up finds it.

The key is the person's OpenRouter key (`OPENROUTER_API_KEY`, `ori login`, or
`~/.config/typesafe/credentials`). The router logs OpenRouter's reported cost of
every answer.

## What was measured

- **Accuracy**, on 43 synthetic English prompts over four desks: Jev alone was
  right 91–95% of the time, depending on the bar, and sent nothing to a wrong
  session. A first version had a local model (julia-1) decide first; every wrong
  send in the tests and on the owner's desk was julia-1's, so it was dropped.
  Rewording Jev's question as the person continuing their work raised accuracy from
  85% to 95%.
- **On the owner's desk** (three machines, about thirty sessions), deciding only:
  15 of 18 English prompts went where they should; the misses were new work where
  Jev's top pick was right but under the bar.
- **Cost**: $0.000167 per decision on that desk (about 4,000 tokens), as OpenRouter
  reported it; about 6,000 decisions per dollar.
- **Time**: about 0.6 s per decision.

## Hill-climbed on the owner's desk (2026-10-10)

The first version was hit and miss on the owner's real desk, so it was measured there and climbed:
- **The desk:** 80 sessions on three machines, half of them stopped, with duplicates, QA panes and
  sessions left over from earlier wrong routes.
- **390 labelled English messages:**
  - 41 by hand, including every message the owner reported misrouted;
  - 60 written blind;
  - 116 from a red team whose job was to break it (typos, "merge it", pasted logs, "the one on tropic",
    same-kind traps);
  - 50 held out until the end.
- **Runs:** each message 2 or 3 times; deciding only, nothing sent (`cli/scripts/route-eval/`).

| Set | Before | After |
|---|---|---|
| By hand + blind (101) | 63% right, 25 wrong sends in 123 (by hand alone) | 90% right, 0 wrong sends in 202 |
| Red team (116) | 51% right, 66 wrong sends in 232 | 72% right, 6 in 232 |
| Held out (50) | 81% right, 7 wrong sends in 150 | 83% right, 4 in 100 |

What moved it, in order:
1. **What Jev is shown** (`offered`). Live sessions come first, then stopped ones:
   - A conversation listed twice is shown once.
   - A stopped session is dropped when a live one has its name, or when it has nothing to read.
   - Pasted-text tags, other agents' messages, and prompts that name nothing ("ok merge it", "cont") are
     left out of descriptions. Each session says its machine.

   On the owner's desk, the live "X Posts" shared Jev's vote with three stopped copies of itself, and
   stopped leftovers took live sessions' places among the forty.
2. **The question** asks for "the same kind of work on the same subject", not continuity or shared
   words. "Continue their work" let "merge it" follow the words "ok merge it"; "whose job is this kind of
   work" sent the lamp's retention to Harness's usage session.
3. **A message that names nothing of its own** ("merge it", "post it as is"; Jev is asked in the same
   call) goes where the last task went, or is new work. "A single word is enough" keeps "also check
   retention" from counting as one.
4. **Smaller rules:**
   - A message asking for a new session is new work.
   - A running pick is not held back by a stopped copy or a same-named twin (1.75× the rest).
   - No more stopped sessions than forty in all: at fifty, old leftovers took new work.

Every wrong send left in these runs is a judgement call a person could make either way:
- a job post about the lamp firmware went to the lamp firmware session;
- "rotate the leaked OpenRouter key" went to the session that checked it;
- "why is the dial showing the wrong pane" went to the ⌘B session.

Most misses split two right answers (two sessions that both flashed the round unit) or are stopped
sessions beyond the forty. They become new work, which costs a harness.

## Not done

- The other clients: the phone, the web, the TUI and the dial still use their own
  routing. Voice through the desktop already uses this box.
- The lead rule (0.4, twice the runner-up) is set from two misses and a benchmark;
  the runner-up in the log is how to tune it.
