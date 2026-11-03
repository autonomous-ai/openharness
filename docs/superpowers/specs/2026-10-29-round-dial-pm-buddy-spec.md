# Round dial: the PM and the Buddy in each Swarm project

Status: spec · 2026-10-29 · requester: Diego · base: `origin/main` 5df861254
Mockup: `2026-10-29-round-dial-pm-buddy-mockup.html` (beside this file), approved option A.
Builds on: `docs/superpowers/specs/2026-10-28-round-dial-swarm-chat-design.md` (the chat on a project's face).

## Why

On the round dial each Swarm project is one face. A horizontal swipe moves to the next project (`ui_habitat.c`,
`swarm_show`). The face shows the chat the desktop has open (`cli/src/superTabs/cards.ts`, `faceOf`), so the only way to
see your Buddy on the dial is to open its chat in the app. With Buddies on (`docs/swarms.md` § Buddies), a person
cares about two places per project: the project chat, where the PM answers, and their own Buddy chat.

## Decisions (Diego, 2026-10-29)

1. **Two screens per project, stacked vertically.** Swipe up: the Buddy screen. Swipe down: back to the PM screen. The
   horizontal swipe still changes project.
2. **The PM screen is today's face, unchanged:** no "PM" label, the PM's engine pet, the recap. It adds only two page
   dots at the right edge.
3. **The Buddy screen** shows the Buddy's avatar in place of the pet, a lilac ring at the glass edge and the Buddy's
   last message as the recap. **No engine badge** on the avatar and no "Your Buddy" label.
4. **Voice is unchanged:** tap the face to start, tap again to send. While listening and sending, the screen shows the
   engine's pet as today (Claude, Codex), for the engine of the chat being spoken to. On the Buddy screen the ring stays
   lilac and the sending label reads "Sending to your Buddy".
5. Swiping on the dial does not require clicking in the app.

## Behaviour

### Screens
- **PM screen.** The chat on the face is today's rule: the conversation the desktop has open in this project, else the
  project's Lead conversation. One exception is new: while the Swarm has Buddies on, a Chat with PM is never the face,
  because it is read-only (`commands.ts` `PM_CHAT_READ_ONLY`). The face falls back to the Lead conversation.
- **Buddy screen.** The chat on the face is the signed-in person's own Buddy chat in this project (`kind: 'buddy'`, and
  `buddyOwnerId` is the reader). The backend only ever sends a Buddy chat to its owner (`read/views.ts` `groupView`), so
  another person's Buddy chat can never reach the dial.
  - **The Buddy exists** (its agent is in the Swarm): show its avatar and the recap, which is the Buddy's last message
    in that chat.
  - **No Buddy** in this project: show a dashed circle with "+", then "No Buddy here yet" and "Add one in the Harness
    app." The dial cannot add a Buddy.
- **Buddies off** in the Swarm: no dots, swiping up does nothing, and the face is exactly today's.

### Switching
- On the PM screen, swipe up opens the Buddy screen. Swipe down keeps today's meaning: it opens the inbox when there
  is an unread notice (Focus skin).
- On the Buddy screen, swipe down returns to the PM screen. Swipe up does nothing.
- The side (PM or Buddy) is kept per Swarm. Moving to another project keeps the side.
- **Who wins between the dial and the desktop:** the newest of the two. A swipe on the dial sets the side. A later change
  of the conversation the desktop has open clears the dial's choice, and the face follows the desktop again. Opening
  the Buddy chat on the desktop therefore shows the Buddy screen, as today.

### Avatar
- It is the Desktop agent pattern, ported exactly (`desktop/lib/super_tabs/avatar_art.dart`,
  `superTabAgentPattern`):
  - FNV-1a (32 bits) of the Buddy's display name, trimmed and lower-cased;
  - 15 bits form the left half of a 5×5 grid, mirrored;
  - the hue is `(hash >> 16) % 360`;
  - the colour is HSL(hue, 42 %, 72 %), the dark-mode tone.
- The disc behind it is the same colour at 16 %. There is no uploaded or preset picture on the dial.
- Test vectors:
  - `"diego's Buddy"`: half bits 25513, hue 13, colour #d6a79a;
  - `"ken's Buddy"`: half bits 30735, hue 327, colour #d69abb.
- **Known consequence:** a person's Buddies in different projects share a name, so they share an avatar. This matches
  Desktop. Changing it is out of scope (see Open).

### Alerts
- A new message from the Buddy in its chat raises a **quiet** notice:
  - no beep and no inbox entry;
  - on the PM screen, a lilac badge on the lower dot, and "Your Buddy replied" on the lower arc;
  - opening the Buddy screen reads it.
- Lead and PM notices are unchanged (beep, bell, inbox).

### Voice
- Tapping the face starts listening, as today.
- On the PM screen, the words post into the face's chat (today's rule).
- On the Buddy screen, the words post into the Buddy chat as the person.
- The listening and sending pets are the engine's:
  - the PM's engine on the PM screen;
  - the Buddy's engine (`claude` or `codex`) on the Buddy screen.
- **A refused post never becomes a terminal turn.**
  - Today a failed Swarm post falls back to typing the words into the Lead's terminal (`cableSession.ts` voice path,
    `swarmSay(...).catch(() => false)`, then `sendTurn`). With Buddies on, that types words meant for a read-only Chat
    with PM into the PM's terminal.
  - From now on, a post the backend refused (any 4xx) shows the refusal as a voice error on the dial.
  - Only an unreachable backend (network, 5xx, timeout) may use the old fallback, and never from the Buddy screen.

## Wire (cable)

- **Capability:** the round dial's hello adds `swarmBuddy: 'v1'` next to `swarmChat: 'v1'`. A device without it gets
  byte-identical frames to today.
- **Lead entry** (in `supertab`), for a `swarmBuddy` device:
  - The chat on the face may now be `chat: 'buddy'` (with `chatId` and `chatName` = the Buddy's name).
  - New `buddies: true` when the Swarm has Buddies on.
  - New `buddy`, when the reader has a Buddy in that project:
    `{ chatId, name, engine, cells, color, live }`.
    - `cells` is the 15-bit half pattern.
    - `color` is `#rrggbb`.
    - `live` is false while the Buddy is down (its agent is in the Swarm but not running).
- **Device → daemon:** `supertab.side {tab, side: 'pm' | 'buddy'}` sets the side for that Swarm.
- **`supertab.notice`** may carry `chat: 'buddy'`.
- **Frame size:** the `supertab` frame must stay under `CABLE_MAX_PAYLOAD` (8192) with 12 Leads, names at their
  48-byte cut and a Buddy on every project.

## Out of scope
- The Harness Pro (it keeps its Swarm cards).
- Desktop changes, other than a parity test of the avatar vectors.
- Making the desktop follow a swipe on the dial.
- Adding, removing or restarting a Buddy from the dial.
- Proposals from the dial.

## Open
- Per-project Buddy avatars (hash the project id in). This would need the same change on Desktop. Default: no.

## Acceptance
1. With Buddies on and a Buddy in project P:
   - swipe up on P's face shows the Buddy avatar, the lilac ring and the Buddy's last message;
   - swipe down returns to the PM face;
   - the dots show which screen is open.
2. Moving to project Q keeps the side. Where Q has no Buddy, its Buddy screen shows "No Buddy here yet".
3. Tapping on the Buddy screen listens with the Buddy engine's pet, posts the words into the Buddy chat, and the
   Buddy's reply becomes the recap.
4. The Buddy's reply while the PM screen is open shows the lilac badge and "Your Buddy replied", without a beep or an
   inbox entry.
5. With Buddies off, every frame and face is as today. A device without `swarmBuddy` gets today's frames.
6. A voice post the backend refuses shows the error on the dial and types nothing into any terminal.
7. With Buddies on, a desktop open on a Chat with PM leaves the PM face on the Lead conversation.
8. Opening the Buddy chat on the desktop shows the Buddy screen. A later swipe on the dial wins until the desktop opens
   another conversation.
