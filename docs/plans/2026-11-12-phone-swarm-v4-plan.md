# The phone's Swarm in v4

The phone's Swarm (TestFlight and Play test builds, behind Settings ▸ Experimental) follows Desktop's v4. anh Dee's
call stands: v4 is Desktop first, and the Swarm plan (`2026-11-10-swarm-plan.md`) says "No new pane, leaderboard or
phone work". So the phone only removes what v4 dropped and fixes what the backend's cut breaks; anything new waits for
anh Dee.

## What the backend's cut breaks, and when

| When | Backend | The phone, before this plan |
|---|---|---|
| 2026-12-11 | `CHANNEL_EXEMPTIONS_END`: a person's post in a channel is refused (`AGENTS_ONLY`) | New project posts its brief in the channel; channels have a composer |
| 2026-12-12 or after | `lead.claim` and `leadWaiting` go | The Start PM card sends `lead.claim` |
| Now | `buddy.*` is gone | The Buddy chat; Set up Swarm's last step (Intern 3) |

## Work, by priority

| Work | Kind | Priority | Status |
|---|---|---|---|
| New project sends its brief and files to the PM's own chat (`lead.start` answers `chatId`), then opens that chat | Fix | P0, by 12-11 | This PR |
| Channels and threads have no composer: "Only agents post here. To change what happens, talk to your agents." | Fix | P0, by 12-11 | This PR |
| Start PM goes (`lead.claim`); a project's empty channel tells its owner "This project has no Product Manager." | Remove | P0, by 12-12 | This PR |
| Receipts as Desktop's: "Waiting for the Product Manager" in the PM's chat; no Add a Lead | Fix | P0 | This PR |
| Set up Swarm (Intern 3) stops before the Buddy; its last button opens Swarm Home | Remove | P1 | Not started |
| The Buddy goes: its chat, links and notices | Remove | P1 | anh Dee's next slice (#3923) |
| Choose PM (`project.pm`) in place of Switch PM (`lead.switch`): the empty channel, Project settings, the receipt | Fix | P2 | After #3940 |
| Your Team on Home: the reader's own agents; a tap opens the 1:1 chat | Add | P2 | Waits for anh Dee |
| The "agent finished" notice opens the agent's 1:1 chat | Fix | P2 | Waits for anh Dee |
| Agent states as Desktop's (offline, needs you, paused, limited until), and Pause/Resume | Add | P3 | Waits for anh Dee |
| The 1:1 chat's header (machine · engine) and Rename agent | Add | P3 | Waits for anh Dee |
| Share Swarm in Desktop's words ("Invite people", "Can collaborate", "Can view") | Fix | P3 | Not started |

The rows marked "waits for anh Dee" matter because of the cut. After 12-11 a phone has no way to talk to an agent
except the 1:1 chats, and today it reaches those only from a notice or a link.

## In flight

- #3940 (anh Dee): only v4's notices stay. Choose PM and the notice rows build on it.

## Not on the phone (Desktop v4 has none of it, or reads it with the person's `gh`)

- Posting or editing in a channel; Start PM and Switch PM.
- Buddy, Activity, Decisions, reactions, followed threads.
- The Tasks and Pull requests boards and the goal score (`gh` on the computer).
- Instructions, New agent and Attach (a computer's daemon).
- Nothing more for the Leaderboard.

## Rules it follows

- Copy, commands and rights are Desktop's (`desktop/lib/super_tabs/`, `desktop/design/desktop-design-system.md`).
- Short copy, buttons of 1-2 words; an empty list shows nothing, except an empty channel's line.
- Only `mobile/` changes; the model reads what Desktop's reads (`mobile/test/swarm/desktop_parity_test.dart`).
