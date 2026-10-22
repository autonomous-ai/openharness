# Super Tab chat attachments

Status: planned 2026-10-21. Owner direction: files live on a public GCS bucket served through a CDN
(`https://cdn.harness.autonomous.ai`); clients upload through the backend, which returns the CDN link.
Bucket, credentials and CDN base are all environment variables.

## Problem

The Super Tab chat (Lead and every group) takes text only. A person cannot paste a screenshot, drop a
file or pick one, and an agent never receives one. The launch dialog's attachments go through the
terminal stream, which only reaches machines the sender can drive, and they never enter the transcript.

## Decisions

- Clients upload the bytes to the backend, which streams them into GCS and answers with the CDN link.
  The message stores only metadata.
- Public read through the CDN. Anyone holding a link can open the file, so every object key carries a
  random 128-bit segment: `<prefix>/<tabId>/<random hex 32>/<sanitized name>`.
- Limits: 10 MB per file, 10 files per message. Any MIME type; images get a preview.
- The chat never loads a file by itself (Super Tab MVP rule, `docs/research/2026-10-17-one-human-many-agents/17-super-tab-mvp.md:229`):
  a row shows a chip (name, size); an image opens only when clicked.
- The agent receives local file paths. The host CLI on the agent's machine downloads each file into
  its paste-drops folder (`cli/src/lib/pasteDropFiles.ts`, 24 h retention) and lists the paths in the
  delivered prompt. This works for an agent on anyone's machine; no terminal access is needed.

## Contract

Attachment metadata, as stored on a message and returned by every read:

```ts
type Attachment = { id: string; name: string; mime: string; size: number; url: string }
```

Upload is one HTTP request to the backend, never through another machine or the relay:

- The browser build sends it straight to the backend with its own account token (the bearer `ApiClient` sends).
- The native desktop holds no backend token: its `ApiClient` talks to this computer's daemon. It posts the same
  request to the daemon's local HTTP API (`POST /api/super-tabs/:tabId/attachments`, with the local write header
  `x-adapter-local: 1`). The daemon streams it on to the backend over HTTPS with the account's token and hands back
  the backend's status and body unchanged (`cli/src/lib/superTabAttachmentProxy.ts`). It takes 11 MB at most and
  ends an upload after 30 s with no bytes moving, or after 15 minutes in all.
- `post --attach` posts each file to the same daemon route as the agent (`?asAgentId=`), on its own deadline rather
  than a service answer's 30 s.

`POST /super-tabs/:tabId/attachments`, `multipart/form-data` with a `conversationId` field followed by one `file`
part (its filename and content type are the attachment's name and mime). The actor must be allowed to post in
that conversation. The backend streams the part into GCS and stops at 10 MB. Answers:

- `200 { attachment: Attachment }` with `url` = `<SUPER_TAB_ATTACHMENTS_PUBLIC_BASE>/<object key>`.
- `413 ATTACHMENT_TOO_LARGE`, `403 FORBIDDEN`, `400 INVALID_ATTACHMENT`, `503 ATTACHMENTS_UNAVAILABLE` (no bucket,
  or GCS failed).

Then `message.send { ..., attachmentIds?: string[] }` on `POST /super-tabs/:tabId/commands` (at most 10). Each id
must have been uploaded by the same actor for the same tab and conversation and not used yet. `text` may be
empty when there is at least one attachment.

Old clients ignore `attachments`; old daemons deliver text only, which stays correct.

## Phases

### 1. Backend (`backend/`)

- Config: `SUPER_TAB_ATTACHMENTS_BUCKET`, `SUPER_TAB_ATTACHMENTS_PREFIX`, `SUPER_TAB_ATTACHMENTS_PUBLIC_BASE`
  (default `https://cdn.harness.autonomous.ai`; an `https://` address in production, refused at startup otherwise), `SUPER_TAB_ATTACHMENTS_CREDENTIALS` (base64 of the service account
  JSON; empty falls back to application default credentials). Missing bucket means uploads answer
  `ATTACHMENTS_UNAVAILABLE`; nothing else changes.
- `@google-cloud/storage`. A small `AttachmentStore` interface (`put` bytes) so tests and the local E2E run on a
  fake. Only inline-safe images keep their type; everything else is stored as `application/octet-stream` with
  `Content-Disposition: attachment`, so nothing runs as a page on the CDN's domain. The CDN should send
  `X-Content-Type-Options: nosniff`.
- Prisma: `attachments Json?` on `SuperTabMessage`; a `SuperTabAttachment` row per upload (id, tabId,
  conversationId, actor key, name, mime, size, objectKey, usedBy messageId, createdAt) to enforce single use. Rows that never get used can be swept later; not in v1.
- Validation in `commands.ts` beside `message.send`; tests in `commands.test.ts`.

### 2. CLI (`cli/src/superTabs/`)

- `host.ts` delivery: before `core.turns.deliver`, download each attachment (only from the configured public
  base, size capped, timeout), write it with `writePasteDropFile`, and add
  `Attached files:\n- <path> (<name>, <size>)` to `prompt()`. A failed download names the URL instead of a path.
- `messages` / `message` output includes attachment names and URLs.
- `post ... --attach PATH` (repeatable): the agent can send a screenshot or a log back. Uploads each file through
  the daemon's local upload route, then `message.send` with the ids.
- The daemon's local HTTP API passes `POST /api/super-tabs/:tabId/attachments` on to the backend (see Contract).

### 3. Desktop (`desktop/lib/super_tabs/`)

- Composer (`view.dart`): wrap the `TextField` in `NewHarnessPasteTarget` and `NewHarnessDropZone`, add
  `NewHarnessAttachButton`, keep a `HarnessAttachments` per conversation, show chips under the field.
  Same code serves the web build.
- `controller.dart` `send()`: upload each file (progress on the chip), then send with the ids. The browser posts
  to the backend with its token; the native desktop posts to the daemon's local upload route with
  `x-adapter-local: 1`, which passes it on. A failed upload keeps the draft and the files; a stalled upload can be
  cancelled.
- `message_row.dart`: file chips; an image chip opens a viewer that fetches the URL only on click; others open
  in the browser.

### 4. Validation

- Unit: backend command tests, CLI host prompt and download tests, desktop composer and row widget tests.
- Local E2E on the Super Tab rig (`supertab-local-e2e-rig`) with the fake store: paste a PNG on desktop, agent on
  another machine receives a path and reads it; agent posts `--attach`, desktop shows the chip.
- One run against the real bucket from staging before release.

## Open (ops)

- Bucket and CDN values for each environment, and an ingress body limit of at least 11 MB on the upload route.
- CDN CORS for GET, so the browser build can show images.
- Lifecycle: delete objects after N days? Default proposal: keep 90 days.
