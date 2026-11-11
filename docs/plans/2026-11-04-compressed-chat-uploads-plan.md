# Compressed chat uploads: implementation plan

> Implemented by its Engineer task by task, test first (project instructions, Engineer role). No per-task review: the
> review step on the pull request is the one independent review.

**Goal:** Importing an agent stops failing at "Sharing the files" when the gateway in front of the backend refuses a
handoff full of shell commands and file paths, and a refusal with no code says why in plain words (task #2737, asked
by Lê Lộc).

**Architecture:** Desktop gzips a file it sends by the multipart form (the 10 MB route that crosses the gateway) and
says so in a `contentEncoding: gzip` form field placed between `conversationId` and the file; the file part keeps its
real name and content type. The backend's form route accepts that one field, unpacks the file as it streams and hands
the store the original bytes, so what is stored, served, sized and checked is exactly what it is today. Files whose
bytes are already compressed (PNG, JPEG, GIF, WebP, zip, PDF) go as they are. A file over 10 MB still goes straight to
storage on a signed link, which never crosses the gateway. An older backend refuses the field with
`INVALID_ATTACHMENT`; Desktop then sends the file once more uncompressed, as today.

A refusal that carries no Harness code (the gateway's HTML 403, or an empty answer) gets a message by status:
4xx says the server's gateway refused the file and that sending it again won't help; 408, 429 and 5xx say the server
could not take it just now, try again in a minute. Its status is logged, as before.

**Tech Stack:** Dart/Flutter (Dio, package:archive GZipEncoder, `compute`), TypeScript/Fastify (@fastify/multipart,
node:zlib), vitest, flutter_test.

**Spec:** task #2737 brief (Goal, Changes 1–3).

## Global Constraints

- No access check changes: the route's preHandlers, `store.upload`'s actor and conversation checks and the hourly
  allowance stay as they are.
- No check is loosened: the multipart file limit still applies to what arrives (compressed), and the store's
  `MAX_FORM_ATTACHMENT_BYTES` cap applies to the unpacked bytes, so a gzip bomb stops at 10 MB + 1 like any other
  oversized form file (413).
- Never real transcripts in tests: fixtures are made-up shell lines.
- Desktop tests use a loopback fake gateway and a memory store; nothing signs the CLI out.
- The CLI proxy passes the body through untouched (cli/src/lib/superTabAttachmentProxy.ts), so it needs no change.

## Review Focus

- `contentEncoding` handling in the form route: field order, one value only, stream errors (corrupt gzip → 400,
  truncated form → 413/400, never a 500 or a hang), the unpacking stream destroyed when the store stops reading.
- The fallback to an uncompressed send happens once, only for `INVALID_ATTACHMENT` from a compressed form.
- The message text for a codeless refusal, and whether "Try again" is honest in each case.

## Answer to Change 3: does "Try again" help?

No, for this failure. A content filter judges the bytes, and Try again sends the same bytes, so it is refused the same
way every time. Only a codeless 408, 429 or 5xx (the gateway or backend busy or restarting) can pass on a second try,
and those keep a "try again in a minute" message.

## Design

- growth: N/A because nothing new is stored; the stored object and row are the same as today.
- concurrency: N/A because no new shared state; one request unpacks its own stream.
- read cost: N/A because reads are unchanged (the stored object is the original file).
- scale: unpacking costs backend CPU per form upload (≤ 10 MB each, already capped at 200 uploads per hour per actor);
  the first warning is backend CPU on the upload route.
- compatibility: a new Desktop against an older backend falls back to an uncompressed send; an older Desktop, the
  mobile app and `post --attach` send no field and are handled as today.
- migration + rollback: N/A because there is no data change; rolling back the backend makes new Desktops fall back.
- audience: the server enforces it: access checks are untouched and run before a byte is stored.
- identity: N/A because no new identity is used.
- failure: a corrupt or oversized packed file is refused with a code and words; a codeless refusal names the gateway.
- platforms: Desktop on macOS, Linux and Windows compress on a background isolate; the browser build compresses on its
  one thread with the same encoder.

## Task 1: Backend unpacks a gzip form file

**Files:** `backend/src/superTabs/attachments.ts`, `backend/src/routes/superTabs.ts`,
`backend/src/superTabs/attachments.test.ts`, `backend/integration/superTabs.test.ts`

**Interfaces:** `formFileBody(file: Readable, encoding: 'gzip' | null): Readable`; `unpackFailed(body): boolean`.

- [ ] Failing unit tests: `formFileBody` round-trips gzip, errors with a zlib code on corrupt input, passes the
  source's error on.
- [ ] Failing integration test: a gzip form stores the original bytes, type and size; corrupt gzip → 400
  `INVALID_ATTACHMENT`; an unknown encoding, a field after the file or twice → 400; a packed file over 10 MB unpacked
  → 413 `ATTACHMENT_TOO_LARGE`; a plain form still works.
- [ ] Implement; run the unit file and the attachment block of the integration file.

## Task 2: Desktop compresses form uploads

**Files:** `desktop/lib/super_tabs/attachment_upload.dart`, `desktop/test/super_tab_upload_test.dart`

- [ ] Failing test: against a fake gateway that answers 403 HTML to a body holding shell-like text, a transcript
  uploads, and the server's unpacked file equals the original, with `contentEncoding: gzip` before the file part.
- [ ] Failing test: a PNG goes uncompressed; an `INVALID_ATTACHMENT` answer to a compressed form is followed by one
  uncompressed send.
- [ ] Implement.

## Task 3: A codeless refusal says why

**Files:** `desktop/lib/super_tabs/attachment_upload.dart`, `desktop/test/super_tab_upload_test.dart`

- [ ] Failing test: a 403 HTML answer reads "the server's gateway refused" with no "Try again"; a codeless 503 says
  try again in a minute; both log their status.
- [ ] Implement; run the touched Desktop files, the import and attachment tests, and the Desktop guard tests.
