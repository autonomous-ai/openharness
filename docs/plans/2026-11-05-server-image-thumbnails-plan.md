# The server makes image thumbnails at upload: plan

> Written by the Engineer per the project instructions (writing-plans, then test-driven-development task by task). No
> Execution Handoff: the Engineer implements it.

**Goal:** A chat shows a picture from a small thumbnail (about 720 px on its long side) that the server made when the
picture was uploaded, not from the full file; the full-screen viewer still opens the original. Pictures sent before keep
working. Task #3177 (Huy's speed plan, part B2), requested by Huy.

**Architecture:** When an upload is a PNG, JPEG or WebP picture, the backend reads its size and, when a smaller copy is
worth it, writes a WebP thumbnail next to the original in the bucket (same Swarm folder, same random key, `.thumb.webp`
suffix: `thumbKeyOf(objectKey)`, so nothing needs the key stored). Its facts go on the upload's row
(`SuperTabAttachment.image`: width, height, and the thumbnail's public address, width, height, size). `message.send` copies them into the message's file (`Attachment.width`, `height`, `thumb`), as it copies a
voice clip's facts today. Every read signs the thumbnail's link in the same step that signs the original's
(`fileLinks.ts forRows`), so whoever gets one gets the other, and nobody else gets either. Desktop (and the web, which is the
Desktop build) and the phone draw `thumb` in the chat and the original in the viewer; a file without `thumb`, or whose
thumbnail cannot be fetched, is drawn from the original, as now.

**Tech Stack:** TypeScript backend (vitest), `sharp` (libvips, prebuilt for the backend's node:22-bookworm image and macOS),
Dart/Flutter (Desktop and phone widget tests with the in-memory server).

**Spec:** the task's brief (#3177).

## Design

- Which files: `image/png`, `image/jpeg`, `image/webp`. GIF is left alone (a thumbnail would stop its animation).
  Whatever the declared type, only bytes that decode as a picture get facts; anything else is stored as before.
- Size: long side 720 px (`fit: inside`, never enlarged), WebP quality 80, EXIF orientation applied and metadata dropped
  (no location in a thumbnail). A thumbnail is kept only when it is under 80% of the original's bytes; otherwise the row
  keeps width and height and the chat draws the original.
- Form uploads (up to 10 MB): the bytes stream to the bucket as now and are also kept in memory for the thumbnail (they
  are capped at 10 MB already). Direct uploads (over 10 MB, straight to the bucket): on completion, a picture up to 32 MB
  is read back from the bucket for its thumbnail; a bigger one gets none.
- growth: one extra object per picture, about 50 to 150 KB; one small embedded object per row and per message file.
- concurrency: at most 2 thumbnails at once per server process, libvips on one thread each; a decode past 64 megapixels or
  10 seconds is given up, and the upload succeeds without a thumbnail. A failure to make or store one never fails the
  upload.
- read cost: no new query or index. A read signs one more link per picture with a thumbnail, through the same per-window
  link cache (`FILE_LINK_WINDOW_MS`).
- scale: at 10x uploads, thumbnail CPU grows with picture uploads (about 50 to 300 ms each), off the event loop.
- compatibility: `width`, `height`, `thumb` are new optional fields. Older apps ignore them; newer apps read a file without
  them as before. Pictures sent before this have none and are drawn from the original.
- migration + rollback: none. Rolling back stops new thumbnails; files already sent keep theirs, which older code ignores.
- audience: a thumbnail's link is only ever made inside the read that links its original, for the same reader, and only for
  a key inside that Swarm's own folder (`FileLinks.keyOf`). There is no separate thumbnail route.
- identity: N/A, because nothing new is asked of who the reader is; the existing read decides it.
- failure: no thumbnail when the picture does not decode, is too big, or storing it fails; the chat draws the original.
- removal: every path that removes a stored file removes its thumbnail too: the unsent-file sweep, Delete Swarm's purge, and
  an upload whose row could not be written (the thumbnail goes at once). A row says it has a thumbnail (`image.thumb`), so
  a file without one costs no extra delete.
- platforms: backend (Linux container, macOS for development); Desktop on macOS, Windows, Linux and the web; phone on iOS
  and Android.

## Global Constraints

- Access to a thumbnail follows its original's exactly.
- No CDN work (a separate question for Dee and Ken).
- Swarm code stays out of `cli/src/core`. Desktop tests use a memory store and a fake sign-in.
- Phone: a picture over 10 MB stays a chip, thumbnail or not (a bigger fetch on opening is a separate decision).
- Task #3178 (B1, Tamarack) changes how Desktop caches and decodes inline pictures in the same files: this task only picks
  which link the inline picture draws (the thumbnail when there is one), keyed as its own picture (`<file id>:thumb`).

## Review Focus

- That a thumbnail's link is made only with its original's, for the same reader, inside the Swarm's folder (`fileLinks.ts`).
- Decoding untrusted pictures: the pixel and time limits, and that a failure never fails the upload.
- That every removal of a stored file removes its thumbnail.

## Tasks

### Task 1: Backend: make the thumbnail at upload

**Files:** `backend/src/superTabs/thumbnails.ts` (new), `thumbnails.test.ts` (new), `attachments.ts` (Attachment fields,
`DirectUploads.read`), `store.ts` (`keep`, `completeUpload`, `sendable`, `proposable`), `backend/prisma/schema.prisma`
(`SuperTabAttachment.image Json?`), `backend/package.json` (`sharp`).
**Interfaces:** `makeThumbnail(bytes): Promise<ImageFacts | null>`; `ImageFacts { width; height; thumb?: { bytes; width; height } }`;
`Attachment.width?`, `height?`, `thumb?: { url; width; height; size; link?; expiresAt?; unlinked? }`.

- [x] Failing tests: a 2000x1500 JPEG upload gets a thumbnail of 720x540 stored next to it, with sizes in the upload's answer
      and in the sent message; a small PNG gets width and height and no thumbnail; a GIF and a file that is not a picture
      get neither; a picture that fails to decode still uploads; a direct upload's picture gets one at completion.
- [x] Implement; run the new tests and `attachments.test.ts`.

### Task 2: Backend: the thumbnail's link follows the original's

**Files:** `backend/src/superTabs/fileLinks.ts`, its tests, the store's file-link tests.

- [x] Failing tests: a reader of the message gets both links; a person who cannot read the message gets neither (the page
      read and the fresh-link route); a `thumb` whose address is outside the Swarm's folder is dropped, never linked.
- [x] Implement.

### Task 3: Backend: removing a file removes its thumbnail

**Files:** `backend/src/lib/attachmentSweep.ts`, `backend/src/superTabs/purge.ts`, their tests.

- [x] Failing tests: the unsent-file sweep and Delete Swarm's purge remove the thumbnail object with the original.
- [x] Implement.

### Task 4: Desktop and web: the chat draws the thumbnail, the viewer the original

**Files:** `desktop/lib/super_tabs/model.dart`, `attachment_image.dart`, a test.

- [ ] Failing widget test: a file with a thumbnail is drawn in the chat from the thumbnail's link and opened in the viewer
      from the original's; a file without one is drawn from the original.
- [x] Implement.

### Task 5: Phone: the same

**Files:** `mobile/lib/swarm/model.dart`, `swarm_attachment.dart`, a test.

- [ ] Failing widget test, as Task 4.
- [x] Implement.

### Task 6: Before and after bytes

- [x] Measure original and thumbnail bytes over real pictures (the repo's screenshots and covers: 120 files, 47.8 MB to 3.0 MB, in the
      pull request), and give Huy the task #3176 steps to take the same numbers on his Mac after the release.
