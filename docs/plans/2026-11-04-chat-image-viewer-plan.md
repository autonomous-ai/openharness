# Chat image viewer Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent review step on the pull request.

**Goal:** A picture in a chat opens as Slack opens one: a see-through veil over the chat that leaves an open thread pane visible on the right, the sender, when and where at the top left, the picture centred with previous and next through the other pictures of that chat or thread, rotate and zoom at the bottom left, Download, Open in browser and More at the bottom right. Esc or a click outside closes it. Strengthens "Tell the PM what you want, and your crew ships it": the screenshots a crew posts read in place, without losing the thread beside them.

**Architecture:** The chat view holds one open viewer and draws it over the panes left of the right pane (`SuperTabPaneLayout.over`), or over the whole window when the thread is a drawer. The chat list and the thread pane each put a `SuperTabImageGallery` above their rows: the pictures of that scope, oldest first, each with its sender, time and place, built from the messages the view already holds. A picture in a row looks up its gallery and opens the viewer at itself. With no gallery or no stage above it (a row drawn anywhere else), the viewer opens over the whole window as before, with that one picture.

**Tech Stack:** Flutter/Dart Desktop (and its web build).

**Spec:** Task #2606 in Super Tab conversation 768e7d2d01a4ea5f3e142681 (Huy, 2026-11-04; brief from River the same day).

## Look

```
┌ sidebar ┬──────────────── chat (veil) ─────────────────────┬─ thread ─┐
│         │ (H) Huy                                       [×] │          │
│         │     14 days ago in # openharness · shot.png       │  replies │
│         │                                                   │  stay    │
│         │ [‹]          ┌─────────────────────┐          [›] │  visible │
│         │              │       picture       │              │  and     │
│         │              └─────────────────────┘              │  usable  │
│         │                                                   │          │
│         │ [⟳] [−] ───●────── [+] 100%  Download  Open in browser [⋯] │
└─────────┴───────────────────────────────────────────────────┴──────────┘
```

## Global Constraints

- Harness Design Language (desktop/design/desktop-design-system.md): tokens only, flat rows, colour never the only signal, no explanatory sentences.
- The veil is dark in both appearances (River, 11-04: a picture reads best on dark, as in Slack and Photos): one media veil token, `grid.AppDesktop.mediaVeil`, with the ink and control fill drawn on it (`mediaInk`, `mediaInkMuted`, `mediaControl`, `mediaControlHover`), the same in light and dark. The design system names it as the image viewer's exception to the one modal veil.
- Keeps today's Download (not in a browser) and Open in browser, each asking for a fresh link when the one at hand is about to end (`AttachmentViewerActions`).
- Previous and next: buttons at the picture's left and right, and the Left and Right keys, through the pictures shown in place in the same scope: the chat's pictures from the chat, the thread's from the thread. No previous button on the first, no next on the last.
- Zoom: a slider with minus and plus, 100% to 400% in 25% steps, its percentage shown beside it; pinch and scroll zoom move it too. Rotate turns a quarter clockwise each click. A new picture starts at 100%, unturned.
- Top left: the sender's avatar and name as their row shows them, then "14 days ago in # openharness · shot.png". Time in words: "just now", "1 minute ago", "5 minutes ago", "1 hour ago", "3 hours ago", "1 day ago", "14 days ago".
- More holds only Show in chat (closes the viewer and goes to the message) (River, 11-04).
- Esc closes; a click on the veil closes; a click on the picture or a control does not.
- Web: a browser still shows a picture as a chip that opens in a new tab (a browser cannot refuse a redirect off file storage, `attachment_viewer_web_test.dart`), so the overlay is drawn only by Desktop. Its code is shared and builds for the web. The PR names this as a known limit (River, 11-04).
- Desktop tests use a memory store and a fake sign-in (`ConversationServer`). Desktop guard tests (`check-ui-style`, `laid_out_list_test`) pass before Ready.

## Review Focus

- The conversation changes, or the thread closes, while the viewer is open: it closes rather than showing pictures of a chat no longer open.
- A picture further along whose link has ended or was never signed: the viewer asks for a fresh one, and says it can't be shown if none comes.
- A sender who has left the Swarm: their recorded name and the face it gives, as their row shows.
- A narrow window where the thread is a drawer: the viewer covers the window and Esc closes the viewer, not the drawer.
- Keys typed while the viewer is open never reach the composer under it.

---

### Task 1: The viewer overlay

**Files:**
- Modify: `desktop/lib/super_tabs/attachment_image.dart` (replace `SuperTabImageViewer`, add `SuperTabImageItem`, `SuperTabImageGallery`, `SuperTabImageStage`, `superTabPostedAgo`)
- Modify: `desktop/lib/super_tabs/attachment_viewer.dart` (`AttachmentViewerActions`: optional Close, trailing More)
- Modify: `desktop/lib/shared/theme/app_theme.dart` (the media tokens), `desktop/design/desktop-design-system.md` (the exception)
- Test: `desktop/test/super_tab_image_viewer_test.dart` (new)

**Interfaces:**
- Produces:
  - `class SuperTabImageItem { SuperTabImageItem({required SuperTabFileRef ref, required String sender, required Widget avatar, DateTime? postedAt, String? place, VoidCallback? onShowInChat}); }`
  - `class SuperTabImageViewer extends StatefulWidget { const SuperTabImageViewer({Key? key, required List<SuperTabImageItem> images, required int index, required VoidCallback onClose}); }` keyed `super-attachment-viewer`, its picture `super-attachment-image:<file id>`, its buttons `super-image-previous`, `super-image-next`, `super-image-rotate`, `super-image-zoom-out`, `super-image-zoom-in`, slider `super-image-zoom`, veil `super-image-veil`.
  - `String superTabPostedAgo(Duration age)`.
  - `AttachmentViewerActions({..., bool close = true, Widget? more})`.

- [ ] **Step 1: Write the failing tests** (pumping `SuperTabImageViewer` alone with three items): next and previous buttons and the Right/Left keys change the picture shown, the first has no previous and the last no next; plus moves the slider to 125% and the picture's scale to 1.25, minus back to 100%, the slider dragged to the end reads 400%; rotate sets the picture's quarter turns to 1, then 2; Esc and a tap on the veil call `onClose`, a tap on the picture does not; the header reads the sender, "14 days ago in # openharness · shot.png"; Download and Open in browser are there and there is no Close; More offers Show in chat, which calls it and closes; `superTabPostedAgo` reads the times in Global Constraints.
- [ ] **Step 2: Run them and watch them fail** — `flutter test test/super_tab_image_viewer_test.dart` (the new names do not exist).
- [ ] **Step 3: Implement** the overlay as a `Stack` over the veil: header row, `InteractiveViewer` with a `TransformationController` around a `RotatedBox`, the arrows at the sides, the control row at the bottom; a `Focus(autofocus)` handles Esc, Left and Right. Each item's link is `ref.current`, else asked for with `superTabOpenableLink`.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** the test first, then the code.

### Task 2: Open it over the chat, through that chat's or thread's pictures

**Files:**
- Modify: `desktop/lib/super_tabs/attachment_image.dart` (`SuperTabInlineImage` opens through the gallery and stage)
- Modify: `desktop/lib/super_tabs/attachment_chips.dart` (`superTabFileRef` and `superTabShowsInPlace`, shared with the gallery)
- Modify: `desktop/lib/super_tabs/message_row.dart` (`superTabMessageAvatar`, the row's own avatar, shared)
- Modify: `desktop/lib/super_tabs/pane_layout.dart` (`over`: drawn over the left and centre panes)
- Modify: `desktop/lib/super_tabs/view.dart` (the stage, a gallery for the chat and one for the thread, the place name)
- Test: `desktop/test/super_tab_message_media_test.dart` (the old full-screen test becomes the overlay's)

**Interfaces:**
- Consumes: Task 1's `SuperTabImageViewer`, `SuperTabImageItem`.
- Produces: `SuperTabImageGallery({required List<SuperTabImageItem> Function() images, required Widget child})`, `SuperTabImageStage({required void Function(List<SuperTabImageItem>, int) open})` (`maybeOf`); `SuperTabPaneLayout(over: Widget?)`.

- [ ] **Step 1: Write the failing tests** in the full chat view (`SuperTabView` over `ConversationServer`, 1400×900 so a thread sits beside the chat): a click on a picture opens the viewer whose right edge is at the thread pane's left, and the thread's reply is still hit-testable; its header names the sender and "in # …"; with two messages of pictures, next goes to the second; a picture in the thread pages only through the thread's pictures; Show in chat closes it; switching conversation closes it; at 900 wide (thread as a drawer) the viewer covers the window and Esc closes the viewer while the drawer stays.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** as in Architecture.
- [ ] **Step 4: Run** the tests of what changed: `super_tab_message_media_test.dart`, `super_tab_image_viewer_test.dart`, `super_tab_file_links_test.dart`, `super_tab_attachments_test.dart`, `super_tab_message_rows_shots_test.dart`, `super_tab_phone_targets_test.dart`, the pane layout's tests.
- [ ] **Step 5: Commit** the test first, then the code.

### Task 3: Screenshots and Ready

- [ ] `super_tab_image_viewer_shots_test.dart` (light and dark, a thread open beside the chat) writes the before shots on main and the after shots on the branch with `SUPER_TAB_IMAGE_SHOTS`; attach them to the PR.
- [ ] Run the changed tests, the guard tests (`check-ui-style`, `laid_out_list_test`), `flutter analyze`, and a web build compile. The whole Desktop suite runs in the PR's CI once it is ready; that green run is the suite evidence (instructions revision 56).
- [ ] Red/green evidence in a PR comment; mark Ready; add the review and test steps.
