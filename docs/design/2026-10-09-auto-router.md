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
  Return would make it (a fresh worktree from main in a Git project), in the
  project and with the agent the router chose. A line says which.
- **Jev cannot be reached** (no key, offline, no credit): the box says so and sends
  nothing.

There is no undo; the owner chose instant sends. The safety is the bar: a session
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
sessions on connected machines, most recently active first, at most forty, each
with its last prompts and its last three turn summaries), the person's project
folders and the agents they use (`desktop/lib/state/task_route.dart`). The router
answers "this session" or "new work, in this project, with this agent". The client
acts through its own doors: the desktop types the task into the session's pane
(`deliverTask`), or creates the harness (`_createFromTask`). So the router needs
nothing from the core, keeps no session list, and reaches no other machine.

Request (`ROUTER_REQUESTS` in `cli/src/core/api.ts`): `route_decide`. A daemon
without the router answers `UNSUPPORTED` and the box falls back to Boss mode's old
router.

## How it decides

One request to **Jev 1.13** through OpenRouter's Decisions API
(`cli/src/lib/jev/jevClient.ts`, `cli/src/lib/routeDecide.ts`): "A person typed
this message to continue their work. Which of their ongoing sessions is it for?"
(or "none of them: new, unrelated work"), which project and which agent. A pick is
taken at 0.6 or more; below that the task is new work, and a project or agent Jev
is unsure of comes from the pane the person is in. The session the person last sent
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

## Not done

- The other clients: the phone, the web, the TUI and the dial still use their own
  routing. Voice through the desktop already uses this box.
- Whether to take Jev's top session pick below 0.6 (it was right in both misses
  above) is open.
