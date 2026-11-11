# Swarm chat, quiet: round 28 faces, quiet message lines, a composer that matches Cmd-N (task #4467)

**Goal:** Redraw the Swarm chat by anh Dee's six rules (11-07 15:35): round faces at 28, the name in semibold, the
time in 12 tertiary, text at 14, and a composer that matches Cmd-N's field with a round send button that stays
neutral until there is something to send.

**Architecture:** The chat's sizes already live in one place each: the message face in `AppDesktop.messageAvatar*`,
the text in `SwarmType`, the composer's box in `AppDesktop.composerRadius`. Change those values and the two
composers (the main chat's in `view.dart`, the thread's `SuperTabReplyBox`) pick them up. The one new element, the
round send button, lives in `desktop/lib/super_tabs/chat/` and both composers use it, so there is one send button.

**Tech Stack:** Flutter (Desktop), flutter_test widget tests; the gallery from #4461 for light and dark.

**Spec:** task #4467 brief (River, 11-07, from anh Dee's 'sure' at 15:35).

Way of working: the project's Engineer flow: this plan first, each task's failing test committed before its code,
one pull request, one independent review.

```
 ●  River  4:12 PM                                  28 round face · 13 semibold · 12 tertiary
    New Project is in the sidebar now.               14 text
 ●  dee  4:13 PM
    Found it, thanks!
╭──────────────────────────────────────────────╮     radius 12, hairline, faint fill
│ Message River                                │
│ 📎  @  New session                    🎤  (↑) │     (↑) round: grey empty, blue with text
╰──────────────────────────────────────────────╯
```

## Global Constraints

- Desktop only; a phone layout (`workspaceIsCompact`) keeps the app's sizes, as today.
- Rule 1: grey everywhere, colour only on agent faces. Rule 2: blue only for the main action (send with text).
- Rule 3: 14 chat, 13 names, 12 details. Light and dark, at 880 and wide.
- Keep what the composer already holds: @ Tag and New session (Huy and Scholes, 11-04); only the attach glyph, the
  corners and the send button change.
- Every changed element goes into the design doc's Swarm elements section and the gallery test (#4461) in this PR.
- Windows: no process starts; nothing platform-specific.

## Review Focus

- The send button with only a file attached (no text) turns blue: a file is something to send.
- A queued message while busy (`canQueueText`) still enables send in the main chat, so it turns blue then too.
- A message row whose author left the Swarm still draws a round face (the fallback branch).
- The name line keeps the body's 20 px line, so a row's height doesn't jump between name and text.
- Dark mode: the neutral send button's fill and arrow stay readable on the field (no new colour: `field` step and
  `hint` ink).

## Task 1: round message faces at 28

**Files:** `desktop/lib/shared/theme/app_theme.dart` (`messageAvatarSize`, drop `messageAvatarRadius`),
`desktop/lib/super_tabs/message_row.dart` (`superTabMessageAvatar`), test `desktop/test/super_tab_chat_quiet_test.dart`.

- [ ] Test: a message row's face is 28 × 28 and round (`SuperTabAvatarFace.radius == null`), for an agent, a person
      and an author who left.
- [ ] Watch it fail (36, radius 8).
- [ ] `messageAvatarSize = 28`; `superTabMessageAvatar` passes no radius; remove `messageAvatarRadius`.
- [ ] Pass; run the message row tests.

## Task 2: quiet message lines

**Files:** `desktop/lib/super_tabs/swarm_type.dart`, `desktop/test/super_tab_typography_test.dart`.

- [ ] Test (typography test updated): body and composer 14 on 20; the sender 13 in semibold (w600) on 20; the time
      12 in `textFaint` (tertiary); markdown keeps 14; the thread header is a name, 13 semibold.
- [ ] Watch it fail.
- [ ] `bodySize = 14`, `bodyLine = 20`, `nameSize = 13`, `nameWeight = FontWeight.w600`; `time` in `DesktopChrome.hint`.
- [ ] Pass.

## Task 3: the composer matches Cmd-N

**Files:** `desktop/lib/super_tabs/chat/send_button.dart` (new), `desktop/lib/super_tabs/view.dart` (composer's
attach and send only), `desktop/lib/super_tabs/reply_box.dart`, `desktop/lib/shared/theme/app_theme.dart`
(`composerRadius`), tests `desktop/test/super_tab_chat_quiet_test.dart`, `super_tab_composer_row_test.dart`.

**Interfaces:** `SwarmSendButton({Key? key, required String tooltip, VoidCallback? onPressed})`: a 28 round button,
key `swarm-send-fill` on its circle; null `onPressed` draws it neutral (`DesktopChrome.rim` fill, `hint` arrow),
else blue (`AppPalette.accent` fill, white arrow).

- [ ] Test: both composers' boxes have radius 12 and a hairline; attach shows `AppIcons.paperclip`; send is a round
      28 button, neutral when empty, blue after typing and after attaching a file, neutral again when cleared.
- [ ] Watch it fail.
- [ ] Add `SwarmSendButton`; use it in both composers; paperclip in both; `composerRadius = 12`.
- [ ] Pass; run the composer tests.

## Task 4: design doc and gallery

**Files:** `desktop/design/desktop-design-system.md` (Swarm elements: Chat), the gallery test from #4461 and its
images.

- [ ] Gallery: a message row (agent and person), the composer empty and with text, in light and dark; fails before
      the images are updated.
- [ ] Update the images, inspect them, commit.
- [ ] Doc: the chat's face, name, time, text and composer numbers, and the send button's two states.
