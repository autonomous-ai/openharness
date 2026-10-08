# Harness Hub review · October 7

Scope: the Hub as shipped in `aff63539d` (#890) and unchanged on `origin/main` today: the web
pages (`website/src/app/hub/`, `website/src/lib/community/`), the API (`backend/src/routes/community.ts`,
the four `Community*` Prisma models, the Next proxy in `website/src/app/api/community/`), and the
desktop's **Share ▸ Publish to Hub** (`desktop/lib/community/publish_*.dart`). Forking from the Hub
into the desktop was not reviewed.

This is a source review plus one live read of https://harness.autonomous.ai/hub (signed in). No tests
were run for this report.

## What the live page shows

18 cards, all "Harness · Starter", all tagged Codex, all at 0 likes and 0 comments. No community
posts exist yet. The page is fast (DOM ready ~0.8 s). Card images use `alt=""` on purpose, because the
surrounding link carries `aria-label="Open {title}"`.

## How a publication travels

```
Desktop: Share ▸ Publish to Hub
  └ buildPublicationDraft: walk the agent's project folder + the last 60k chars of its session
  └ PublicationHandoff: one-use loopback page on 127.0.0.1 (random token, 5 min expiry)
      └ the browser auto-POSTs the draft to harness.autonomous.ai/hub/import
          └ Next stores it in IndexedDB, redirects to /hub/publish?draft=…
              └ the person reviews, ticks the MIT confirmation, presses Publish
                  └ POST /api/community/harnesses (Next proxy) → Fastify → MongoDB
```

## What is already right

- Nothing publishes itself. A draft stays in the browser until the person presses Publish.
- The loopback handoff is tight: random token, `Host` check, one use, `form-action` limited by CSP,
  5-minute expiry.
- The API validates with Zod in depth: relative paths, reserved names, cover magic bytes,
  file-vs-directory clashes, an included HTML viewer, idempotent `clientId`, rate limits on publish
  and comment.
- Published HTML runs in a sandbox without `allow-same-origin`, under a CSP with
  `connect-src 'none'`. Comments render as text. `/hub/import` uses a nonce CSP and escapes its payload.
- Likes and follows change only after the server answers.

## Findings

Severity is the reviewer's judgement: **High** breaks a main path or degrades with growth,
**Medium** is wrong in a real case, **Low** is polish.

### High

**H1. The feed carries every cover inline.** `GET /api/community/harnesses` selects `cover`, a data
URL of up to 350 KB (`community.ts:83`). One page of 30 posts can be ~10 MB of JSON, which the Next
proxy buffers whole with `response.json()` under a 12 s timeout. The feed gets slower with every
post that has a cover.
*Fix:* return a cover URL in the feed, and serve the image from its own cacheable route.

**H2. The detail page re-downloads the whole project on every focus.** `GET /harnesses/:id` returns
`files` (up to 6 MB) and the conversation with the social state (`community.ts:109`), and
`Detail.tsx:32` calls it on every window `focus`. Only `social` needs refreshing.
*Fix:* a social-only endpoint for refreshes. Render the harness itself on the server (see M1).

**H3. Publish to Hub fails on most real projects** (`publish_project.dart:96`):
- The 31st eligible file throws instead of being skipped. `.json`, `.md` and `.ts` all count, so an
  ordinary Vite or Next project is over 30 files.
- One file over 3 MB (a large PNG asset, a data CSV) fails the whole publication.
- `dist/` is skipped, so the source `index.html` is picked as the viewer. That file is not
  self-contained and previews blank.

*Fix:* choose the viewer first, then add files by priority until the limits, skipping (and listing)
what does not fit.

**H4. Remote machines cannot publish.** For an agent on another machine, or from the web build,
Publish to Hub opens an empty `/hub/publish` (`publish_native.dart:16`, `publish_web.dart`). The
dialog still says "Review your files and conversation in the Hub", as if a draft had been sent.
*Fix now:* say plainly that this machine's files cannot be read from here. *Later:* read the files
through the machine's CLI, the way `readSessionTail` already reads the session.

### Medium

**M1. Published harness pages have no server render or metadata.** `[id]/page.tsx` only loads
starters on the server. A user's harness renders "Loading harness…" with the title "Open harness"
and no description, so shared links have no preview. `getPublicHarness` in `server.ts` already does
the fetch.

**M2. Infinite scroll inserts posts above the starters** (`Feed.tsx:60`). The list is
`[...posts, ...starters]`. With more than 30 posts, reaching the starters loads the next page above
them and pushes them down.

**M3. A failed like breaks the feed** (`Feed.tsx:56`). It shares the feed's `error` state, so it
shows a Retry button that reloads the feed, and it stops infinite scroll (`Feed.tsx:43`).

**M4. Publishing can leak secrets.** Only dotfiles are skipped. `config.json`, `secrets.ts` or
`credentials.txt` are included, and the conversation can hold a token the agent printed. Nothing
scans for secrets, and the file list on the review page is a collapsed `<details>`.
*Fix:* scan for common secret patterns on the review page, name the files and turns, and require
them to be removed or acknowledged before Publish.

**M5. Long conversations lose their newest turns** (`publish_project.dart:146`). The tail is the end
of the session, but the loop keeps the first 80 turns of it. A session with many short turns drops
its last turns, usually the most relevant.

**M6. Search only filters what is loaded** (`Feed.tsx:60`). Posts on unloaded pages cannot be found.
A short filtered list keeps the load trigger in view, so it pages through everything one request
at a time.

**M7. A missing harness marker fails only at the last step.** The API requires a marker file per
`harnessId`, for example `scenes/hello.py` for Blender (`community.ts:52`). Neither the desktop nor
the web form checks it, so the person fills in everything before seeing "Include the harness project
source."

**M8. The detail comment count stops at 100.** The detail page shows the newest 100 comments
(`community.ts:105`) and counts them. The feed counts all of them, so the two numbers differ past 100.

**M9. Publish size limits are measured after base64.** On the web form (`publish/page.tsx:71`) and
on the desktop, a PNG of ~2.3 MB is refused with "under 6 MB". The real ceiling is ~4.2 MB of raw
data. The API's own limit is also base64, so the copy should say what is actually measured.

### Low

- **L1.** Non-UTF-8 text files (a Latin-1 `.csv`) make the desktop show a raw `FormatException`
  ("Unexpected extension byte").
- **L2.** Engines outside the four the Hub knows (for example Grok) are labelled Codex without a
  word.
- **L3.** Reply is shown to signed-out readers and does nothing (`Detail.tsx:63`).
- **L4.** The header renders "Sign in" first and then switches to "Yours" (`Header.tsx:10`).
- **L5.** `/hub/import` accepts a cross-site POST, so any site can open a prefilled publish draft.
  This is low risk, because the person must still confirm and press Publish, and it is open on
  purpose for the desktop handoff. It should be documented as such.
- **L6.** Rate limits count and then write, so parallel requests can exceed them. Likes and follows
  have no limit.

### Product risk

**P1. No report or moderation.** The feed publishes user-made HTML with no Report button and no way
for an admin to hide a post. A creator can delete comments on their own harness, and that is the
only control.

### Structure

**S1. The publication contract is copied by hand in about five places.** Nothing fails when the
copies drift:

| Rule | Copies |
|---|---|
| The nine harnesses | backend enum and marker map, `HarnessTags.tsx`, the publish `<select>`, desktop `communityHarnesses` |
| Categories, engines | backend enums, publish page |
| Extensions, reserved names, 30 files / 3 MB / 6 MB | backend, publish page, desktop |
| Starter ids | `communityAccess.ts`, `starters.ts` |

*Fix:* one shared contract module per language, plus a test that reads the backend's source the way
`desktop/test/e2ee/encrypted_down_types_test.dart` reads the CLI's.

**S2.** `Detail.tsx` and `publish/page.tsx` keep real logic in one-line inline handlers. The publish
page holds about 13 `useState`s. Split them into hooks (`useFeed`, `useHarnessSocial`,
`usePublishDraft`) and components (`CommentList`, `CommentForm`, `ConversationEditor`,
`FilesReview`).

## Plan

In order. Each step has its own tests.

1. **API payloads:** a cover route (H1) and a social-only endpoint (H2).
2. **Web:** server render and metadata for published harnesses (M1), feed order and like errors
   (M2, M3), size copy (M9), Reply and header polish (L3, L4).
3. **Desktop publish:** viewer-first file choice with skips listed (H3), honest remote and web
   messages (H4), newest turns kept (M5), non-UTF-8 and engine labels (L1, L2).
4. **Secret scan** on the review page (M4), and the marker checked before Publish (M7).
5. **Shared contract** and its drift test (S1), then the component split (S2).

Deferred (needs a product decision): report and moderation (P1), server-side search (M6), comment
pagination (M8), and remote-machine publishing through the CLI (H4, later part).

## Status

Steps 1–5 are done on `fix/hub-review`:

- **H1, H2:** the feed and the harness carry `/api/community/harnesses/:id/cover` instead of the image.
  The website serves it as a PNG, JPEG or WebP, cached for a day, so an unpublished cover can show
  for up to a day. A reader's page refreshes from `/social`.
- **M1, M2, M3, M9, L3, L4:** as planned. Server rendering asks as a production reader, so a
  staging publication still loads in the browser.
- **H3, H4 (now), M5, L1, L2:** the desktop picks the output, then the harness source, then the
  shallowest files that fit, and names the rest on the review page. A missing harness source
  publishes as a general harness, with a note.
- **M4, M7:** the review page lists what looks like a credential and holds Publish until it is
  removed or acknowledged. This runs in the browser only, so the API does not enforce it. A missing
  harness source also holds Publish.
- **S1:** `backend/src/lib/communityContract.ts` is the source. The website (`contract.ts`) and the
  desktop (`hub_contract.dart`) copies are tested against it, starter ids included, and
  `scripts/ci-plan.py` runs both suites when it changes.
- **S2:** `Detail`, `Feed` and the publish page are split into hooks (`useHarnessDetail`, `useFeed`,
  `usePublishDraft`, `useSignedIn`) and small components.

- **The output stays required.** The Hub (#890) publishes what a session made: the output at 70%
  beside its conversation, forking into the same viewer and agent workspace. A code review that made
  nothing to look at was given an app's `index.html` that showed blank and could not be removed.
  Instead of making the output optional (tried, then reverted), the desktop and the folder picker
  now choose only `preview.html`, or the page a fork was published with. Without one, the desktop
  asks for a preview.html that runs on its own (for a review, a page presenting it). The review page
  asks for one too, and names files or addresses an output loads that the sandbox cannot reach.
- **A fork's unchanged output is refused.** A featured starter's `preview.html` is only its poster:
  the real result (a Typst PDF, a Blender model) lives in the harness's own viewer. Republishing a
  fork would have shown the original's picture. Now the desktop and the review page refuse an
  output identical to the one the fork arrived with, and ask for a page showing the current result.
- **A native result reaches the Hub as a picture of its viewer.** When a project has no page of its
  own, or a fork's page is unchanged, the desktop asks the machine's daemon for a frame of the
  harness's viewer (the existing `viewer_surface`, headless Chrome) and publishes it as `preview.html`
  and the cover. Checked on a Typst fork: the current PDF, about 65 KB. Without Chrome on that machine
  it falls back to asking for a page.

Checks: backend typecheck and the full suite (1153 tests), website `tsc`, the full suite (103) and
lint (no new findings), desktop `flutter analyze` and the community, fork and share tests (89), and
the CI planner tests. `next build` was not run locally.
