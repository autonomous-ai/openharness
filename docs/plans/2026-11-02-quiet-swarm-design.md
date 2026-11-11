# Quiet Swarm: the Desktop Swarm screen, redesigned (Dee)

Requested by dee@autonomous.ai. Brainstormed 2026-11-02; direction A ("Quiet Slack") chosen, polished once, and approved by Dee on 2026-11-02 ("let's build it. make it super light and super clean. super fast to load the app and use too. no sluggish. try to reach zero latency.").

## Why

Dee: "it looks like a bad buffet rather than a carefully crafted product." Today's Swarm screen shows
everything at once: a 10-line Status card, a "While you were away" box and Shipped cards stacked over
the chat; an always-open right column of people with scores and 15+ agents with model, effort and task;
a sidebar with machines, models and red counts; 9 tabs across the top. Harness is a team chat where half
the team are agents, so it should feel like the team chats people already know (Slack, Discord,
Telegram): the conversation is the product, everything else is a way to reach a conversation.

## What the three apps taught us

- One column carries the day: the chat. Lists of people open only when asked.
- News is a place you visit (Slack's Activity, Discord's Inbox), never banners stacked over the chat.
- A row is one line. Bold means something new; one number means "this is for you".
- A bot's long job is one message that updates itself, not a new card per step.
- They open from what they already have and fill in the rest quietly.

## Goals

- Two columns at rest: sidebar and chat.
- Red numbers only mean "this is for you": Activity's count of what needs you, and on a project row the mentions of you that opening it will show.
- Every list row is one line.
- Each task is one chat message that keeps itself current until it merges; its thread holds the detail.
- People, agents, machines, models and devices are one click away, never on screen by default.
- It feels instant: opening the app, a project or a Swarm shows the last screen at once and fills in quietly; sending shows the message at once (see Speed).

## Non-goals

- No new features. Every function on today's screen keeps a home (table below).
- The terminal workspace and panes don't change; a project's panes stay behind its terminal button.
- The phone app follows in a second pass, after Desktop ships.

## Anti-goals

- A screen that is calmer but loses something a person relied on.
- More words. Headings, names and one status word; reasons go in tooltips.
- New colors, icons or controls outside the Harness design system.

## Rules

- Something new makes a row bold, with no dot. A project row's red number counts only messages that mention you that opening it shows (its chat and threads), Slack's way, chosen by Dee; opening it lands on the first one and reading clears it. Mentions inside task conversations go to Activity.
- Activity is the one place for everything new for you: Needs you, New replies (the old Threads view), Done today. No filter pills; every row one line.
- A task is one line in the chat: its name and one word (planned, working, in review, shipped), or Answer when it needs you.
- Members rows: name, then status word and mark. Role, model, effort and machine go on the agent's card.
- A Buddy's proposal shows as one line that opens; the PM's notices (stalled, idle, work changed) never show in the chat people read.
- People show as their username (the part of the email before @).
- Model, effort and machine appear only on an agent's card.
- Points: one number per person, rolling 7 days; the period is on hover. The crown follows the week's top name.
- Shortcuts show in menus, never on the screen at rest.

## Screens

The drawings show structure, not pixels. Bold can't be drawn in text; in the app a row with something new is bold.

Top bar: tabs stay, as Dee asked on 10-31, with names only (a tab's ⌘ number shows while you hold ⌘) and no count; a tab's name is bold when something there needs you. The right side keeps Search, Notifications and your avatar; Add Phone, Devices and the Store move into the avatar menu.

**0 · Top bar**
```
┌───────────────────────────────────────────────────────────────────────┐
│ lampOS  strategies  autonomous.ai  hardware  growth  …  +     ⌕  ♢  D │
└───────────────────────────────────────────────────────────────────────┘
```

**1 · A project, at rest**
```
┌────────────────────┬──────────────────────────────────────────────────┐
│ autonomous.ai    ▾ │ # openharness ▾                      Members  >_ │
│                    │                                                  │
│ Activity         3 │ ken15  6:50 PM                                   │
│ Buddy              │ Prod DB profile: five slow reads to fix.         │
│                    │ 4 replies                                        │
│ Projects         + │                                                  │
│ # computer         │ ✓ Closed agents leave the list           shipped │
│ # lamp           2 │                                                  │
│ # openharness      │ ◐ Windows credential fix               in review │
│ # physical-router  │                                                  │
│ # spaceship        │ ▸ Proposal from diego: Activity read fix         │
│                    │                                                  │
│                    │ River  8:09 PM                                   │
│                    │ Three fixes are on main.                         │
│                    │                                                  │
│                    │ ──────────────────── New ────────────────────    │
│                    │ dee  8:41 PM                                     │
│                    │ ok i like a. let's make it perfect.              │
│                    │                                                  │
│                    │ ╭─────────────────────────────────────────────╮  │
│                    │ │ Message #openharness                   +  ↑ │  │
│ Manage             │ ╰─────────────────────────────────────────────╯  │
└────────────────────┴──────────────────────────────────────────────────┘
```

**2 · A task's message, through its life**
```
┌────────────────────────────────────────────────────────┐
│ ◌ Phone Activity opens the right message       planned │
├────────────────────────────────────────────────────────┤
│ ◐ Phone Activity opens the right message       working │
├────────────────────────────────────────────────────────┤
│ ◐ Phone Activity opens the right message        Answer │
├────────────────────────────────────────────────────────┤
│ ◐ Phone Activity opens the right message     in review │
├────────────────────────────────────────────────────────┤
│ ✓ Phone Activity opens the right message       shipped │
└────────────────────────────────────────────────────────┘
```

**3 · Clicking a task opens its conversation**
```
┌────────────────────┬──────────────────────────────────────────┬──────────────────────────────┐
│ autonomous.ai    ▾ │ # openharness ▾              Members  >_ │ Thread                     ✕ │
│                    │                                          │                              │
│ Activity         3 │ ✓ Closed agents leave the list   shipped │ ◐ Windows credential fix     │
│ Buddy              │                                          │   Theo · in review           │
│                    │ ◐ Windows credential fix       in review │                              │
│ Projects         + │ 3 replies                                │ Theo  8:12 PM                │
│ # computer         │                                          │ Ready: PR #2605.             │
│ # lamp           2 │ River  8:09 PM                           │                              │
│ # openharness      │ Three fixes are on main.                 │ Reed  8:20 PM                │
│ # physical-router  │                                          │ With fixes: one Important.   │
│ # spaceship        │ ╭─────────────────────────────────────╮  │                              │
│                    │ │ Message #openharness           +  ↑ │  │ Theo  8:31 PM                │
│                    │ ╰─────────────────────────────────────╯  │ Fixed at 98bcfd21c.          │
│                    │                                          │                              │
│                    │                                          │ ╭─────────────────────────╮  │
│                    │                                          │ │ Reply                 ↑ │  │
│ Manage             │                                          │ ╰─────────────────────────╯  │
└────────────────────┴──────────────────────────────────────────┴──────────────────────────────┘
```

**4 · Members**
```
┌────────────────────┬──────────────────────────────────────────┬──────────────────────────────┐
│ autonomous.ai    ▾ │ # openharness ▾              Members  >_ │ This project ▾             ✕ │
│                    │                                          │                              │
│ Activity         3 │ ken15  6:50 PM                           │ People                       │
│ Buddy              │ Prod DB profile: five slow reads to fix. │ ken15 ♛                  424 │
│                    │ 4 replies                                │ diego                    394 │
│ Projects         + │                                          │ dee                      339 │
│ # computer         │ ✓ Closed agents leave the list   shipped │ tony                     239 │
│ # lamp           2 │                                          │ scholes                  210 │
│ # openharness      │ ╭─────────────────────────────────────╮  │ phamngochuy.1989          48 │
│ # physical-router  │ │ Message #openharness           +  ↑ │  │                              │
│ # spaceship        │ ╰─────────────────────────────────────╯  │ Agents                       │
│                    │                                          │ Nico               waiting ◐ │
│                    │                                          │ River              working ● │
│                    │                                          │ Theo               working ● │
│                    │                                          │ Iris               working ● │
│ Manage             │                                          │ Idle (10)                  ▸ │
└────────────────────┴──────────────────────────────────────────┴──────────────────────────────┘
```

**5 · A member's card**
```
┌──────────────────────────────────────────┐
│ Theo                                 Dev │
│ Windows credential fix                   │
│ Opus · high · MacBooks-MacBook-Pro-9     │
│                                          │
│ Open terminal                   Details… │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ ken15 ♛                       424 points │
│ 111 shipped · 40 unblocked · 411 hours   │
│                                          │
│ Manage people                            │
└──────────────────────────────────────────┘
```

**6 · Activity: everything new for you, in one place**
```
┌────────────────────┬──────────────────────────────────────────────────┐
│ autonomous.ai    ▾ │ Activity                                         │
│                    │                                                  │
│ Activity         3 │ Needs you                                        │
│ Buddy              │ ◐ W1 ships alone or waits?                Answer │
│                    │ ◐ Nico is waiting on you                    Open │
│ Projects         + │ @ River mentioned you in # openharness   8:09 PM │
│ # computer         │                                                  │
│ # lamp           2 │ New replies                                      │
│ # openharness      │ Windows credential fix                     3 new │
│ # physical-router  │ Prod DB profile                            1 new │
│ # spaceship        │                                                  │
│                    │ Done today                                       │
│                    │ ✓ Closed agents leave the list           8:08 PM │
│ Manage             │ ✓ Commits read Harness by Autonomous     8:28 PM │
└────────────────────┴──────────────────────────────────────────────────┘
```

**7 · Your Buddy**
```
┌────────────────────┬──────────────────────────────────────────────────┐
│ autonomous.ai    ▾ │ Buddy                                            │
│                    │                                                  │
│ Activity         3 │ dee  8:02 PM                                     │
│ Buddy              │ Draft a note to the team about the new look.     │
│                    │                                                  │
│ Projects         + │ Buddy  8:03 PM                                   │
│ # computer         │ Here's a draft: …                                │
│ # lamp           2 │                                                  │
│ # openharness      │ ╭─────────────────────────────────────────────╮  │
│ # physical-router  │ │ Message Buddy             New session  +  ↑ │  │
│ # spaceship        │ ╰─────────────────────────────────────────────╯  │
│ Manage             │                                                  │
└────────────────────┴──────────────────────────────────────────────────┘
```

**8 · Swarm switcher**
```
┌────────────────────────────────┐
│ Personal                       │
│ autonomous.ai                ✓ │
├────────────────────────────────┤
│ New Swarm                      │
└────────────────────────────────┘
```

**9 · Project menu**
```
┌──────────────────────────────────┐
│ Status                         ▸ │
│ Pull requests                    │
│ Instructions                     │
│ Sharing                          │
│ Notifications                  ▸ │
├──────────────────────────────────┤
│ Project settings…                │
└──────────────────────────────────┘
```

**9b · Status**
```
┌────────────────────────────────────────────────────┐
│ Status · updated 8:33 PM                         ✕ │
│                                                    │
│ Three fixes are on main tonight. Windows           │
│ credential fix: last real Windows run going.       │
│ Ken's five database fixes: one ready, four in      │
│ review. Dee's calmer app: design out for review.   │
└────────────────────────────────────────────────────┘
```

**10 · Manage › Machines**
```
┌────────────────────┬──────────────────────────────────────────────────┐
│ autonomous.ai    ▾ │ Manage                                           │
│                    │ Machines   Models   Devices   Swarm              │
│ Activity         3 │                                                  │
│ Buddy              │ ~ Diego's Mac                      diego  online │
│                    │ ~ Mac 1                              dee  online │
│ Projects         + │ ~ MacBookPro2021        phamngochuy.1989  online │
│ # computer         │ ~ MacBooks-MacBook-Pro-9         scholes  online │
│ # lamp           2 │ ~ MacBooks-MacBook-Pro-10          diego  online │
│ # openharness      │ ~ MacBooks-MacBook-Pro-19           tony  online │
│ # physical-router  │ ~ MACs-Mac-Studio                  ken15  online │
│ # spaceship        │ ~ Mac 3                             dee  offline │
│                    │   Teammates' agents paused                       │
│                    │ ~ MacbookPro                      ken15  offline │
│                    │                                                  │
│ Manage             │                                      Add machine │
└────────────────────┴──────────────────────────────────────────────────┘
```

**10b · Manage › Models**
```
┌────────────────────┬──────────────────────────────────────────────────┐
│ autonomous.ai    ▾ │ Manage                                           │
│                    │ Machines   Models   Devices   Swarm              │
│ Activity         3 │                                                  │
│ Buddy              │ Opus                                         62% │
│                    │ Sonnet                                       21% │
│ Projects         + │ GPT-6.1 Sol                                  11% │
│ # computer         │ DeepSeek v4.1                                 6% │
│ # lamp           2 │                                                  │
│ # openharness      │                                     Your models… │
│ # physical-router  │                                                  │
│ # spaceship        │                                                  │
│ Manage             │                                                  │
└────────────────────┴──────────────────────────────────────────────────┘
```

**10c · Manage › Swarm**
```
┌────────────────────┬──────────────────────────────────────────────────┐
│ autonomous.ai    ▾ │ Manage                                           │
│                    │ Machines   Models   Devices   Swarm              │
│ Activity         3 │                                                  │
│ Buddy              │ Name                               autonomous.ai │
│                    │ Owner                                      ken15 │
│ Projects         + │ People                         6   Manage people │
│ # computer         │                                                  │
│ # lamp           2 │                                     Leave Swarm… │
│ # openharness      │                                                  │
│ # physical-router  │                                                  │
│ # spaceship        │                                                  │
│ Manage             │                                                  │
└────────────────────┴──────────────────────────────────────────────────┘
```

**11 · A new project**
```
┌────────────────────┬──────────────────────────────────────────────────┐
│ autonomous.ai    ▾ │ # design ▾                           Members  >_ │
│                    │                                                  │
│ Activity         3 │                                                  │
│ Buddy              │                                                  │
│                    │                                                  │
│ Projects         + │ Discuss the plan with Product Manager.           │
│ # computer         │                                                  │
│ # lamp           2 │                                                  │
│ # openharness      │                                                  │
│ # physical-router  │                                                  │
│ # spaceship        │ ╭─────────────────────────────────────────────╮  │
│                    │ │ Message #design                        +  ↑ │  │
│ Manage             │ ╰─────────────────────────────────────────────╯  │
└────────────────────┴──────────────────────────────────────────────────┘
```

**11b · Activity, all caught up**
```
┌────────────────────┬──────────────────────────────────────────────────┐
│ autonomous.ai    ▾ │ Activity                                         │
│                    │ All   Decisions   Mentions   Replies   Reactions │
│ Activity           │                                                  │
│ Buddy              │                                                  │
│                    │                                                  │
│ Projects         + │ You're all caught up.                            │
│ # computer         │                                                  │
│ # lamp           2 │                                                  │
│ # openharness      │                                                  │
│ # physical-router  │                                                  │
│ # spaceship        │                                                  │
│ Manage             │                                                  │
└────────────────────┴──────────────────────────────────────────────────┘
```

**12 · A narrow window**
```
┌──────────────────────────────────────────────┐
│ ☰  # openharness ▾                        >_ │
│                                              │
│ ken15  6:50 PM                               │
│ Prod DB profile: five slow reads to fix.     │
│                                              │
│ ✓ Closed agents leave the list               │
│   shipped by Atlas for phamngochuy.1989      │
│                                              │
│ ╭─────────────────────────────────────────╮  │
│ │ Message #openharness               +  ↑ │  │
│ ╰─────────────────────────────────────────╯  │
└──────────────────────────────────────────────┘
```
## What moves where

Nothing is removed without a home.

| Today | New home |
| --- | --- |
| 9 tabs across the top, with ⌘ numbers and counts | Stay, as Dee asked on 10-31: names only, the ⌘ number while ⌘ is held, no count (a tab's name is bold when something there needs you) |
| Search, Notifications, Add Phone, Devices, Store, avatar (top right) | Search, Notifications and the avatar stay; Add Phone, Devices and the Store move into the avatar menu |
| New project row | The **+** beside Projects (the same action, once) |
| Your devices | Manage › Devices |
| Your models, and Models with its usage % | Manage › Models |
| Activity with 36, and the Threads view | Activity: Needs you, New replies, Done today; its number counts only what needs you |
| Project rows with counts and chevrons | One line: bold when new, a red number only for mentions that opening it shows (it clears as you read), the lock for private; a second click on the open project still shows its workgroups |
| Machines section | Manage › Machines, with Add machine |
| Chat header: chat, terminal, pull requests, ⋮ | `# name ▾` opens the project menu (Status, Pull requests, Instructions, Sharing, Notifications, then Project settings… for rename, switch PM, archived and delete); Members and the terminal stay as buttons |
| Status card above the chat | Project menu › Status opens the PM's report as today; its Needs you rows go to Activity; finished work also shows in Activity › Done today |
| "While you were away" box | Activity (Needs you, Replies, Done today); the chat keeps its "New" line |
| Shipped cards | The task's own message, in its merged state |
| Humans column (points, period picker, project scope, shipped, unblocked, hours lent) | Members › People with points (rolling 7 days, period on hover); the project-or-Swarm choice Dee added today becomes Members' heading; the rest on the person's card |
| Agents column (role, model, effort, task, status) | Members › Agents with role and status; task, model, effort and machine on the agent's card |
| Invite (+ by Humans) | Members' **+**, and Manage › Swarm › Invite |
| Delete Swarm (bottom of the switcher, owner only) | Manage › Swarm; Leave Swarm for members |

## Calls made by the PM (check these while reading)

- **A task's message is posted by the server**, one per task that has an Engineer, so Desktop, the phone and agents see the
  same thing. It is edited in place as the task moves (planned, working, waiting on a person, in review, shipped), and it
  replaces today's live task card and Shipped line. Review and test steps get no message of their own; a private task's
  message shows only to its audience. Its thread is the task's own conversation, opened on the right, with "Open in full" to
  give it the main column. This needs backend and phone work, included in the build plan.
- **Tabs stay** where they are, quieter (above). The switcher holds only Swarms.
- **Members keeps the project-or-Swarm choice** as its heading. Agents are grouped: waiting on a person first, then working;
  idle agents fold under "Idle (N)".
- **The PM keeps writing its status report**; it moves from above the chat to the project menu's Status.

## Speed: aim for zero felt latency

Dee: "super fast to load the app and use too. no sluggish. try to reach zero latency." Every surface:
- Opens from what it already has (the last state and messages kept on the device for the signed-in account) and corrects quietly when the server answers.
- Shows a sent message at once, with a quiet sending mark, never a spinner.
- Decodes server answers off the UI thread, and builds only the rows on screen.
- Redraws only what changed; nothing redraws on a timer while it's off screen.

What the code shows today and what fixes it:
- Every machine's 15-second check-in rereads and redraws the whole Swarm screen, even one you aren't
  looking at. Being fixed tonight: a check-in updates only what shows machines.
- Opening the app runs six steps one after another and waits for your profile. Being fixed tonight:
  independent steps run together and the last screen shows at once.
- Panels redraw on timers (machines every second, the people list every 30 seconds, points every
  minute, pull request checks every minute). This design removes those panels from the screen at rest;
  their timers run only while they are open.
- The app already logs how long opening a Swarm takes; the release is measured before and after.

## Approaches considered

- **A. Quiet Slack** (chosen): two columns, news as messages and in Activity, Members on demand,
  Manage for machines, models, devices and the Swarm.
- **B. Telegram list**: one list of every chat, newest first. Simplest, but projects lose their place
  and agents' chatter mixes with people's.
- **C. Trim today's screen**: keep three columns, shrink each. Least change, but three columns still
  compete.

## Left to the builder

Exact spacing, type and colors come from the Harness design system (desktop-design-system.md); the
drawings show structure, not pixels. Section collapse, keyboard order, hover cards and the narrow-window
breakpoint follow the existing components. The naming system's Swarm section is updated to match.

## Build plan once approved

In parallel, each with a review and a browser-build test; each Engineer commits this design with its plan:
1. Sidebar, top bar and Manage (Machines, Models, Devices, Swarm).
2. The server posts and edits one message per task (backend).
3. The chat: one-line task messages, one-line proposals, no Status card / "While you were away" / Shipped cards, PM notices hidden, the project menu.
4. Activity takes in Threads: three sections, one-line rows, no filters.
5. Members panel and member cards.
6. Zero felt latency: open from cache, send at once, decode off the UI thread, build only visible rows.
Already in flight: the heartbeat fix, opening at once, and the project-row red number (Slack's way).

The phone follows the same design in a second pass.
