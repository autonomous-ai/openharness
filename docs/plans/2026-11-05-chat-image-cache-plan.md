# Chat images cached by file id Implementation Plan

> **For agentic workers:** this plan is carried out by its Engineer in this one session, task by task, test first
> (superpowers:test-driven-development), as the project's instructions say. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A chat picture is downloaded once per file, kept on disk under a size cap, decoded at the size the chat shows
it, and its placeholder already has its shape (task #3178, Huy's speed plan B1).

**Architecture:** `AttachmentImage` (attachment_viewer.dart) is keyed by the file's id and the pixel size it is decoded
at, not by its short-lived link, so a fresh link for the same file finds the picture Flutter already holds. Under it, a
new `SuperTabImageCache` keeps each file's bytes on disk (`~/.harness/desktop-app/image-cache/`), one file per picture
named by its id and its width and height, least recently shown out first above 200 MB; the web keeps them in memory.
The chat asks for a decode no larger than 360 points at the screen's pixel ratio; the full-screen viewer asks for the
original. Sign-out and a session that ends clear the cache (`AppState._clearAccountWorkspace`).

**Tech Stack:** Flutter 3.47.2 / Dart 3.13, `dart:io` files, `ImageDecoderCallback.getTargetSize`, flutter_test with a
memory shelf.

**Spec:** task #3178's brief (Goal, Changes, Constraints, Checks), copied into the pull request body. #3177 (server
thumbnails with width and height) is a separate task and is not built here.

## Global Constraints

- Owns `desktop/lib/super_tabs`; the only line outside it is the cache clear in `desktop/lib/state/app_state.dart`.
- The cache holds only what this person may read: a picture is drawn from it only once the app holds a link that opens
  now (the message's own, or a fresh one the server granted); it is cleared on sign-out.
- Desktop tests use a memory shelf and a fake sign-in; nothing signs the real CLI out. Temp folders only through
  `Directory.systemTemp.createTemp` (a `mktemp -d` equivalent).
- No setting or on/off switch (ENGINEERING.md §1). No new dependency.
- Network reads stay through `readAttachment` / `attachmentFetcher` (no redirect, 10 MB cap) and, once #3125 merges,
  through its timed `readPicture`, so task A's image marks count only real downloads.
- PR body first line: `Requested by phamngochuy.1989 through Harness.`

## Design (docs/feature-design-rules.md)

1. Growth: each picture file is deleted by eviction (least recently shown first, above
   `kSuperTabImageCacheBytes` = 200 MB on disk, 64 MB in memory on the web), by sign-out or a session that ends, and
   by the next open of the cache for a `.part` left by a crash. Limit: 200 MB per computer account.
2. Concurrency: no index file. A write goes to its own `<name>.<pid>.<micros>.part` and is renamed into place, so two
   windows never see half a picture; eviction lists the folder again before deleting, and a file another window
   already deleted is skipped. A download that finishes after a clear is not written (a generation counter).
3. Read cost: a chat image reads its bytes from disk once per launch, then from Flutter's memory cache; the network
   only on a miss. The folder is listed once per launch (names and sizes, no contents).
4. Scale: at 10x pictures the cap holds the disk; the first warning is the hit rate falling, seen in task A's
   image marks (downloads per chat open).
5. Compatibility: no wire change; older servers' unsigned links still load (same fetch path).
6. Migration and rollback: nothing to migrate. Rolling back leaves `image-cache/` unused on disk until the folder is
   removed by hand or by a later sign-out from a build that has it; it holds at most 200 MB.
7. Audience: the server enforces it: a picture is read from the cache only inside a load that began with a link the
   server signed for this reader in this session. Cleared on sign-out and session end. Folder 0700, files 0600.
8. Identity: N/A because nothing runs as anyone; it is a local cache of the signed-in person's own reads.
9. Failure: a disk read or write that fails logs `super-tabs image cache ...` (no id, no path) and the picture loads
   from the network as today; a failed download shows "can't be shown" as today, and is not cached.
10. Platforms: macOS, Linux and Windows keep a disk cache; the web keeps a memory one (no Harness home); iOS and
    Android builds of this code use the app's container through `HarnessFileStore.defaultDirectoryPath`.

## Review Focus

- A link that ended under a picture, then a fresh one: the picture must load, not stay broken because its file-id
  key holds the failed load (Task 2 test `a failed load is not kept`).
- A person who may no longer read a file (fresh link refused) with the file cached: it must say it can't be shown,
  not draw from disk (Task 3 test `no link, no picture, even when cached`).
- Two windows writing the same picture, and a crash mid-write: no half picture is ever drawn (Task 1 test
  `a write left half done is never read`).
- Sign-out while a picture is downloading: it is not written after the clear (Task 4 test).
- A tiny picture (smaller than 360 points): drawn at its own size, not blown up (Task 2 test `a small picture keeps
  its size`).

---

### Task 1: The cache: shelf, cap, last-shown order, shapes, clear

**Files:**
- Create: `desktop/lib/super_tabs/image_cache.dart`
- Test: `desktop/test/super_tab_image_cache_test.dart`

**Interfaces:**
- Produces:
  - `const kSuperTabImageCacheBytes = 200 * 1024 * 1024;`
  - `abstract interface class SuperTabImageShelf` with `Future<List<SuperTabShelfEntry>> list()`,
    `Future<Uint8List?> read(String name)`, `Future<void> write(String name, Uint8List bytes)`,
    `Future<void> touch(String name)`, `Future<void> delete(String name)`, `Future<void> clear()`;
    `SuperTabShelfEntry({required String name, required int bytes, required DateTime usedAt})`.
  - `class MemoryImageShelf implements SuperTabImageShelf` (tests, web) and
    `class DirectoryImageShelf implements SuperTabImageShelf` (`Directory`; private 0700/0600, temp-and-rename writes,
    `.part` files removed by `list`).
  - `class SuperTabImageCache` — `SuperTabImageCache(SuperTabImageShelf shelf, {int capBytes})`;
    `Future<Uint8List?> read(String fileId)`;
    `Future<void> keep(String fileId, Uint8List bytes, Size shape, {int? generation})`;
    `Future<void> drop(String fileId)` (a kept picture that does not decode);
    `Size? shapeOf(String fileId)` (synchronous, null until the folder is listed); `Future<void> get ready`;
    `Future<void> clear()`; `int get generation`.
  - `SuperTabImageCache superTabImageCache` (`@visibleForTesting` settable): disk shelf off the web, memory on it.
- File name: `<fileId>~<width>x<height>`; a file id outside `[A-Za-z0-9_-]{1,128}` is never kept.

- [ ] **Step 1: Write the failing tests** (`super_tab_image_cache_test.dart`), each on a `MemoryImageShelf` unless named:
  - `keeps a picture by its file id`: `keep('a1', bytes, Size(800, 600))` then `read('a1')` equals bytes and
    `shapeOf('a1') == Size(800, 600)`.
  - `stays under its cap, least recently shown out first`: cap 100; keep a1 (40), a2 (40), read a1, keep a3 (40) →
    `read('a2')` null, a1 and a3 kept, `list()` bytes sum ≤ 100.
  - `a picture larger than the cap is not kept`.
  - `clear empties it and forgets shapes`: after `clear()`, `read` null, `shapeOf` null, `generation` advanced.
  - `reads the shapes kept by an earlier launch`: a second cache over the same shelf answers `shapeOf` after `ready`.
  - `a file id that is not a plain id is never kept`: `keep('../x', …)` writes nothing.
  - `a write left half done is never read` (`DirectoryImageShelf` in a temp folder): a `.part` file in it is not
    listed, is deleted by `list()`, and the folder mode is 0700 where POSIX modes are supported.
- [ ] **Step 2: Run** `flutter test test/super_tab_image_cache_test.dart` — FAIL (no `image_cache.dart`).
- [ ] **Step 3: Implement** `image_cache.dart`. `keep` writes after the read it came from (no await by the caller),
  skipped when `generation` moved since the caller's load began (the caller passes the `generation` it read when the
  load began). Eviction lists the shelf again, sorts by `usedAt`, deletes oldest until ≤ cap.
  Failures log through `appLog.warn('super-tabs', 'image cache …')` with no id or path.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** test first (`test(desktop): chat image cache …` — failing), then code.

### Task 2: The picture keyed by file id and decoded at the size shown

**Files:**
- Modify: `desktop/lib/super_tabs/attachment_viewer.dart` (`AttachmentImage`, `attachmentImage`, `attachmentPicture`)
- Modify: the tests that set `attachmentImage` (`super_tab_message_media_test.dart`,
  `super_tab_message_rows_shots_test.dart`, `super_tab_image_viewer_shots_test.dart`, `super_tab_file_links_test.dart`,
  `super_tab_image_viewer_test.dart`) to the new hook type
- Test: `desktop/test/super_tab_attachment_image_test.dart`

**Interfaces:**
- Consumes: `superTabImageCache` (Task 1).
- Produces:
  - `AttachmentImage(Uri url, {required String fileId, double? side})` — `side` null decodes the original; a key of
    `(fileId, pixels)` where `pixels = (side * devicePixelRatio).round()` from `obtainKey`'s configuration.
  - `ImageProvider Function(AttachmentImage picture) attachmentImage` (`@visibleForTesting`, default returns
    `picture`); `ImageProvider attachmentPicture(AttachmentImage picture)`.

- [ ] **Step 1: Write the failing tests** in `super_tab_attachment_image_test.dart` (its local server, a memory cache):
  - `a new signed link for the same file id doesn't download again`: resolve `AttachmentImage(link('/a.png?sig=1'),
    fileId: 'a1', side: 360)`, then `…?sig=2` for `a1` → the server answered once; after `imageCache.clear()` a third
    link still makes no request (the disk cache answers).
  - `decodes no larger than the chat shows it`: a 2000×1000 PNG at `side: 360`, pixel ratio 2 → image width 720; the
    same file with `side: null` → width 2000; `shapeOf('a1') == Size(2000, 1000)`.
  - `a small picture keeps its size`: a 1×1 PNG at `side: 360` → width 1.
  - `a failed load is not kept`: first link answers 403, a second link for the same id answers the PNG → an image.
  - The redirect tests stay as they are (now with `fileId`).
- [ ] **Step 2: Run** `flutter test test/super_tab_attachment_image_test.dart` — FAIL (no `fileId`).
- [ ] **Step 3: Implement.** `loadImage`: `superTabImageCache.read(fileId)` → else `readAttachment(url, maxBytes:
  kSuperTabFormAttachmentMaxBytes)`; decode through `decode(buffer, getTargetSize: …)`, which records the intrinsic
  size and returns a `TargetImageSize` with only the longer side set when it is over `pixels`; then `keep` the bytes
  with that shape. On a failure, `PaintingBinding.instance.imageCache.evict(key)` before rethrowing, so a fresh link
  loads anew. `==`/`hashCode` on the key, not the link.
- [ ] **Step 4: Run** the test file and every test file changed in Files — PASS.
- [ ] **Step 5: Commit** test first, then code.

### Task 3: The chat shows the picture's shape before it arrives

**Files:**
- Modify: `desktop/lib/super_tabs/attachment_image.dart` (`SuperTabInlineImage`, `SuperTabImageViewer._picture`)
- Test: `desktop/test/super_tab_message_media_test.dart`

**Interfaces:**
- Consumes: `AttachmentImage(url, fileId:, side:)`, `superTabImageCache.shapeOf`, `.ready` (Tasks 1–2).

- [ ] **Step 1: Write the failing tests** in `super_tab_message_media_test.dart`:
  - `a picture whose shape is known holds its place at that shape`: cache knows `a1` is 1600×900; while its bytes
    have not arrived, the placeholder is 360×202.5 (fitted in 360×360, as the picture will be), and the same once
    drawn.
  - `an unknown shape keeps today's placeholder` (240×180).
  - `no link, no picture, even when cached`: `a1` cached, its link ended and a fresh one refused as gone → "can't be
    shown here", and nothing read from the cache.
  - `the chat asks for the picture at its size, the viewer for the original`: the hook sees `side: 360` from the chat
    and `side: null` from the full-screen viewer.
- [ ] **Step 2: Run** `flutter test test/super_tab_message_media_test.dart` — FAIL.
- [ ] **Step 3: Implement.** `_loading()` takes the fitted size when `shapeOf` knows it; when the cache is not
  `ready` yet, the state awaits it once and rebuilds. The inline `Image` gets `side: SuperTabInlineImage.maxSide`;
  the viewer's gets none.
- [ ] **Step 4: Run** it and `super_tab_image_viewer_test.dart`, `super_tab_file_links_test.dart` — PASS.
- [ ] **Step 5: Commit** test first, then code.

### Task 4: Sign-out clears it

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (`_clearAccountWorkspace`)
- Modify: `desktop/lib/super_tabs/image_cache.dart` (clear also evicts Flutter's memory copies it made)
- Test: `desktop/test/super_tab_image_cache_sign_out_test.dart`

- [ ] **Step 1: Write the failing tests** with `AppState` on a memory store and a fake sign-in (as the existing
  sign-out tests do), and a memory cache holding `a1`:
  - `signing out clears the picture cache`: after `logout()`, `read('a1')` null and Flutter's image cache holds no
    picture of `a1`.
  - `a session that ends clears it too` (`_signedOutAtRuntime` path, as its existing test triggers it).
  - `a picture arriving after sign-out is not kept` (cache level): a load misses, `clear()`, then its `keep` → nothing
    written.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: `unawaited(superTabImageCache.clear())` in `_clearAccountWorkspace`.
- [ ] **Step 4: Run** it and the sign-out tests of `app_state` that exercise `logout` — PASS.
- [ ] **Step 5: Commit** test first, then code.

### Task 5: Before and after numbers

**Files:**
- Test: `desktop/test/benchmarks/chat_image_benchmark.dart` (a measurement; not a `_test` file, so the suite skips
  it)

- [ ] **Step 1:** An image-heavy chat on a local server (30 screenshot-like pictures, 2400×1600, about 0.5 MB each): open it, scroll it,
  reopen it with fresh links, relaunch (new memory cache, same shelf). Record downloads, bytes downloaded, and decoded
  bytes held, on main (before) and on this branch (after), with task A's image marks (#3125) when it has merged.
- [ ] **Step 2:** Post the table in the task and the pull request; a run on a real Mac against production with task
  A's tool goes in the test step.
