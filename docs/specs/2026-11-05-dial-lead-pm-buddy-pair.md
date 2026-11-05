# Round dial: PM | Buddy pair, bell-only notices, Personal | Team (Diego, 2026-11-05)

## What Diego asked

On the round dial's Lead face (a Swarm project's face), change only these, keep everything else:

1. Switch between the PM and the Buddy with a **PM | Buddy** pair at the bottom (as in his reference: the bell pill above a
   two-part pill), instead of swiping up and down.
2. Notices open **only by tapping the bell**; pulling down no longer opens them.
3. In a Swarm, tapping the **project name** opens a picker with two choices only, **Personal | Team** (mockup option B: one
   pill, the current half filled).
4. In a Swarm, the bell and its page hold **only what needs you**.
5. The "PM" line under the project name goes.

Mockup: `devices/harness-device/mockup/round-swarm-v2/lead-v4.html` (picker options in `swarm-picker-options.html`, B chosen).

Today the vertical swipe does three things on the Lead face (up: Buddy side, down: PM side or the inbox when something is
unread), so it often does the wrong one. After this change a vertical swipe on the Lead face does nothing.

## How it works today (main ff98d60f3)

- `ui_habitat.c:717` `swarm_side_swipe`: up opens the Buddy side, down the PM side; down on the PM side pulls the inbox
  (`:3850`, `view(INBOX)` when `notice_unread`). Only for a Lead with Buddies (`l->buddies`) and a connected daemon.
- `:1587` the bell (`focus_bell`, blue pill, `bell_y = 400`) shows while `notice_unread(l->id) > 0`; it is already a tap target
  (`:1630`, `A_INBOX`).
- `:1624` the name on the top arc is a tap target that opens PANES (`A_AGENTS`).
- `:1567` the line under the name is the chat label: `chat_name` for any chat but the Lead conversation and the Buddy chat,
  so the PM chat shows "PM".
- Notices: the cards service (`cli/src/superTabs/cards.ts`) makes a Lead's notice only from the reader's **waiting tags**
  in its project (#2965); the Buddy's own messages are a separate quiet notice (`buddyNotices`). Decisions asked of the
  reader do not reach the dial.
- A Swarm card does not say whether it is the reader's Personal Swarm. The backend knows (`deletion.ts isPersonalSwarm`), the
  list read does not send it.

## Behaviour

### The PM | Buddy pair (firmware)

- A Lead whose Swarm has Buddies (`l->buddies`) shows the pair centred at the bottom: a dark pill (`#141518`, 1 px `#2e3035`
  border, fully rounded) 180 × 44 px at y 388, two equal halves "PM" and "Buddy" in Inter 20, the current side's half filled
  `#2b2d33` with white text, the other `#9a9ca3`. Without Buddies, no pair.
- Tapping the other half switches the side exactly as the swipe did (`swarm_side_put`, `swarm_side_send`, `swarm_buddy_seen`).
  Tapping the current half does nothing.
- The bell moves up to y 346 whenever the pair is shown, on Focus and on the creature skins alike (it keeps its look and its
  tap target). Without the pair it stays where it is today.
- With the pair shown, the face draws no lower-arc hint ("Tap to talk", "Say the word") and no Buddy side dots. The working line
  ("Composing… 2:14") and "Your Buddy replied" move from the lower arc to one centred line at y 318 in the same colour.
- A thread face keeps its layout; the pair replaces its side dots too. With the pair and the bell both showing, its card
  holds two lines (the second ends in "…") so it stays clear of the bell.

### Notices (firmware + daemon)

- On a Swarm face, a vertical swipe does nothing: no side switch, no inbox. The inbox opens only from the bell (and from the
  alert bubble, as today).
- On a Swarm dial, the bell's count and the inbox list only what needs the reader:
  - the reader's waiting tags (today's Lead notice, unchanged);
  - **decisions asked of the reader** that are open: the cards service reads them like tags, from
    `GET /api/super-tabs/:tabId/decisions` when the Swarm read's `decisionsDigest` moves, baseline first (decisions open when the
    dial arrived never alert), and a new one becomes its project Lead's notice (text "<asker> asks you: <question>", the newest
    of a project wins over an older tag, as two tags do today);
  - a Lead waiting on the person on this Mac (today's local wait), unchanged.
- A decision's notice reaches only a dial that announces `swarmNeedsYou`. It keeps the tag notice it covered underneath; any
  other dial (the Pro, older round firmware) keeps seeing that tag, or nothing, and the tag returns when the decision closes.
  A paged decisions read (`more`) never takes a missing decision as closed.
- The Buddy's quiet notices never count on the bell and never list in the inbox of a dial that announces the capability
  `swarmNeedsYou`; "Your Buddy replied" still shows on the face as today.

### Personal | Team (backend + daemon + firmware)

- The Swarm list (`/api/super-tabs/list`) marks the reader's own Personal Swarm: `personal: true` on its row only.
- The cards service copies it to the card (`SwarmCard.personal`), and the `supertab` frame carries `"personal": true` for it.
- On a Swarm face, tapping the project name opens the picker **when the dial holds the reader's Personal card and at least one
  other card**; otherwise the name keeps today's behaviour (PANES).
- The picker is its own screen: black glass, the word "Swarm" on the top arc, and one pill centred (200 × 44 px at y 211,
  same style as the PM | Buddy pair) with "Personal" and "Team". The half of the Swarm on the face is filled.
- Tapping the other half switches Swarm: Personal opens the Personal card; Team opens the last non-Personal card that was on
  the face, else the first non-Personal card in the list order. The dial lands on that card's first Lead (as choosing a tab does
  today, `A_TAB`) and the desktop follows as it does for a tab pick.
- Tapping the filled half, or 5 s with no touch, returns to the face unchanged.

### The "PM" line

- The chat label under the name is not drawn for the PM chat (`HT_CHAT_PM`) either. A group chat keeps its name.

## Design

- **Growth:** none stored. The decision baseline is in memory per Swarm in the cards service, like the tag baseline.
- **Concurrency:** one cards service; a decision read runs only when `decisionsDigest` moved, at most one in flight per Swarm
  (as tags).
- **Read cost:** no new periodic reads; one `/decisions` read per digest change. The list row gains one boolean.
- **Scale:** at 10x Swarms, still one boolean per row and one read per changed digest; the `supertab` frame grows by one field
  per card, inside `fitFrame`.
- **Compatibility:** old firmware ignores `personal` and keeps swipes; new firmware with an old daemon shows no picker (no
  `personal`), keeps the pair and bell-only notices; an old backend sends no `personal`, so no picker. `swarmNeedsYou` gates the
  Buddy-notice change; the Pro is unaffected (it never announces it).
- **Migration + rollback:** none.
- **Audience:** `personal` is set only on the reader's own row; decisions are read with the reader's own account, as tags are.
- **Identity:** the signed-in person's reads and the dial's own side choice, as today.
- **Failure:** a failed decisions read is retried at the next digest change and alerts nothing; a missing `personal` hides the
  picker; nothing else changes.
- **Platforms:** round dial firmware (harness-device), the daemon (cli), the backend list read. Harness Pro: not in scope.
