# Swarm chat reads like iMessage: bubbles, cards for briefs, folded long messages (task #4529)

**Goal:** anh Dee's approved mockup (11-07): the chat reads like talking to a person. Bubbles, compact cards for
briefs and shipped notes, long agent messages folded, times only between pauses, a pill composer.

**Architecture:** The chat's look lives in four new widgets in `desktop/lib/super_tabs/chat/`: `SwarmBubble` (the
shape and colour), `SwarmFold` (folds a long body after about 6 lines, with More), `SwarmChatCard` (a label, one title
line and one blue action that reveals the details) and `SwarmChatTime` (a centered time). `SuperTabMessageRow` keeps
its API and behaviour (hover actions, keys, edit, reactions, thread line, receipts) and lays its parts out as a bubble
row: your own on the right, everyone else on the left. `view.dart` tells each row what it can't know alone: whether
the chat is one-on-one, whether the next row joins it, and where a pause puts a centered time. The composer keeps
`SuperTabReplyBox`/the chat composer and becomes one pill row.

**Tech Stack:** Flutter (Desktop), flutter_test widget tests, the Swarm elements gallery.

**Spec:** task #4529 brief (River, 11-07, anh Dee's mockup). Voice plays only, no transcript (anh Dee, 11-04 and
11-05; River confirmed 11-07). No decision card: the chat has no marker for a decision message (person
decisions show in the Decisions panel).

Way of working: the project's Engineer flow: this plan first, each task's failing test committed before its code, one
pull request, one independent review.

```
                        ╭──────────────────────╮
                        │ Can it auto-approve? │   yours: right, #0A84FF, white text
                        ╰──────────────────────╯
              4:12 PM                                  a time only after a pause over 5 min
  River
  ╭────────────────────────────────╮
  │ Yes, for fixes under 20 lines. │                   theirs: left, grey; name in a group chat
  ╰────────────────────────────────╯
● ╭─ Sent to Chatquiet ────────────╮                   face by the sender's last bubble (group)
  │ Swarm chat reads like iMessage │
  │ View brief                     │                   a brief is a card, never the whole text
  ╰────────────────────────────────╯
 📎 ( Message #Pilot              🎤 )                 pill; send replaces the mic once there is text
```

## Global Constraints

- Desktop only; phone layouts later. Copy by the design doc's rules (one idea a line, buttons verb first, no filler).
- Rule 1 and 2: grey everywhere, colour only on faces; blue for the main action and your own bubbles.
- Bubbles: radius 18, a 4-point corner where one sender's consecutive bubbles meet, at most three quarters of the row.
- One-on-one (a Buddy chat, an agent chat): no names, no faces. A group chat: a small name above the first bubble when
  the speaker changes, a 28 face beside that sender's last bubble.
- Offscreen tests, memory store, fake sign-in. Light and dark, at 1440 and 880.

## Review Focus

- A task line or proposal sent in your name is your own bubble, on the right.
- A grouped run broken by a reply, a thread or a day line: the corner joins only bubbles that touch.
- An outgoing (not yet sent) message is your bubble, dimmed, with its status under it.
- A long message being edited never folds; one tagged you still shows its bar.
- The hover actions stay reachable on your own (right-hand) bubbles.

## Task 1: bubbles

**Files:** `chat/bubble.dart` (new), `message_row.dart`, `view.dart`, `swarm_palette.dart` (own bubble role), tests
`test/super_tab_chat_bubbles_test.dart` (new) and the row tests the old layout pinned.

**Interfaces:** `SwarmBubble({required bool own, bool joinsAbove, bool joinsBelow, required Widget child})`, key
`swarm-bubble`; `SuperTabMessageRow` gains `oneOnOne` (no names, no faces) and `joinsBelow`.

- [ ] Test: your message is a blue (#0A84FF) bubble on the right with white text; another's is grey on the left; a
      bubble is at most 3/4 of the row; a run's touching corners are 4, the rest 18; a group chat names the first
      bubble of a speaker and puts the face beside the last; a Buddy chat shows neither.
- [ ] Watch it fail. Implement. Pass; update the row tests the old layout pinned.

## Task 2: centered times

**Files:** `chat/chat_time.dart` (new), `view.dart`, `message_row.dart`.

- [ ] Test: no time in a bubble's row; a centered time before a message more than 5 minutes after the one before it,
      none within 5 minutes; the exact time stays on the bubble's tooltip.
- [ ] Watch it fail. Implement. Pass.

## Task 3: cards and folding

**Files:** `chat/chat_card.dart`, `chat/fold.dart` (new), `view.dart`, `ship_row.dart`, `message_row.dart`.

**Interfaces:** `SwarmChatCard({required String label, required String title, required String action, required Widget
details})`; `SwarmFold({required int lines, required Widget child})`.

- [ ] Test: a task's brief shows "Sent to <agent>", the task's title and View brief, not its goal; View brief shows
      it. A shipped note shows Shipped, its title and What changed; What changed shows its pull requests and credits.
      An agent's message over 6 lines folds with More; More shows it all; a person's message never folds.
- [ ] Watch it fail. Implement. Pass.

## Task 4: pill composer and voice

**Files:** `view.dart` (composer row), `reply_box.dart`, `app_theme.dart`, tests.

- [ ] Test: both composers are one row in a pill (radius 20): paperclip, the text, the mic while empty; once there is
      text or a file, send in the mic's place. A voice message is your bubble's side and colour, with play, waveform
      and length, no transcript.
- [ ] Watch it fail. Implement. Pass.

## Task 5: design doc, gallery, screenshots

- [ ] Gallery: bubbles (yours, theirs, a joined run), a centered time, a brief card, a shipped card, a folded message,
      the pill composer empty and typed; fails before the images. Update, inspect, commit.
- [ ] Doc: Chat message and Chat composer rewritten; blue is for the main action and your own bubbles.
- [ ] Screenshots light and dark at 1440 and 880 in the PR.
