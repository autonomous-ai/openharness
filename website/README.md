# harness.autonomous.ai

The Harness web app is the Flutter app in [`../desktop`](../desktop), built for the browser. This
package is the Next.js host that serves it, the public harness community, and the routes the rest of Harness links to.

It replaced the React website that lived in `autonomous-ai/autonomous-code` (`apps/web`). That app is
retired; only the host routes below were kept.

## Routes

| Route | What |
|---|---|
| `/`, `/s/:id`, `/auth/callback`, `/callback` | The Flutter app (`public/harness-web/index.html`, via `rewrites()` in `next.config.js`) |
| `/download` (and `/install` → it) | Install page: CLI command and desktop downloads |
| `/pair` | Phone setup guidance — the mobile app and the desktop "add phone" dialog link here |
| `/os` | The Harness operating system landing page: plain HTML/CSS, local fonts and screenshots in `public/os/` |
| `/os/latest` | Redirect to the newest complete published OS release; OS tags only, stable preferred, five-minute server lookup cache |
| `/desktop` | Desktop download page |
| `/hub`, `/hub/following`, `/hub/yours` | Public three-column gallery, followed creators, and your publications |
| `/hub/:id` | Full-page output viewer and published conversation, with likes and comments |
| `/hub/:id/fork`, `/hub/:id/download` | Desktop handoff fallback and an optional project ZIP |
| `/hub/:id/snapshot` | Public, bounded snapshot consumed by the desktop handoff |
| `/hub/import` | One-use desktop handoff into a private browser draft |
| `/hub/publish` | Review and explicitly publish one portable session snapshot |
| `/api/community/*` | Same-origin proxy for the backend's community API |
| `/desktop/download-macos`, `/desktop/download/linux-{x64,arm64}` | Redirect to the latest build in the desktop manifest |
| `/flash-circle.sh` | The dial firmware flasher script |
| `/install.sh`, `/cli/install.sh`, `/desktop/install.sh` | Redirect to the installers on `cdn.autonomous.ai` |
| `ac.autonomous.ai`, `fleet.autonomous.ai` | Redirect to `harness.autonomous.ai` |

The CLI installer is `cli/scripts/install.sh`. The desktop installer's source is
`scripts/desktop-install.sh` here, published with `scripts/upload-desktop-install-sh.sh`.

## Releasing

The community requires the corresponding backend release and its four `community_*` collections
and indexes in `backend/prisma/schema.prisma`. Deploy that backend before exposing the website's
social and publishing actions. Eighteen local examples remain browsable if
the API is unavailable. Their published briefs are labeled as examples; engagement starts at zero.

Push a `vX.Y.Z_web` tag — `make release-web` from the repo root cuts the next one.
`.github/workflows/release-web.yml` builds the Flutter bundle from `desktop/`, bakes it into
`Dockerfile.k8s` through `HARNESS_WEB_ARCHIVE`, and pushes
`gcr.io/autonomous-ecm/autonomous-code-website:<tag>` and `:latest`. ArgoCD rolls it out; verify
`https://harness.autonomous.ai/harness-web/release.json` afterward. Rollback is the previous image
tag, which carries its own bundle. The bundle is also published as a GitHub Release.

For a website-only change, first pin `harness-web-release.json` to the currently
deployed web release, then use `make release-web ARGS="--website-only"`. The helper
checks that pin against production before creating the tag. Its `Website-Only: true`
annotation tells CI to reuse that checksum-verified bundle instead of rebuilding
Flutter. The new image gets its own version; `/harness-web/release.json` continues
to identify the preserved app bundle. Verify the changed route after rollout.

## Local development

```bash
npm install
npm run prepare:web   # download and verify the bundle harness-web-release.json pins
npm run dev
npm test
```

`harness-web-release.json` pins the bundle local builds use: version, source commit and SHA-256.
CI replaces it with the manifest of the bundle it just built, so it only needs bumping for local
work. `HARNESS_WEB_ARCHIVE=/path/to/harness-web-X.Y.Z.tar.gz` supplies an archive instead of
downloading one, with the same checksum and metadata checks.

## Community MVP

`COMMUNITY_API_URL` selects the backend at runtime (default `https://harness-api.autonomous.ai`).
Only HTTPS and loopback HTTP are accepted. Set it to a disposable local backend for development.
The proxy forwards the existing Harness web access token and account environment; it does not
create another identity. Sign-in uses the existing Flutter login and returns to the same Hub page.
Access-token refresh uses the same Web Lock, storage, environment and SSO client as the web app.
An invalid session clears credentials; a temporary refresh failure preserves them. Public browsing
can fall back to anonymous access; writes, Following and Yours require sign-in.

A publication is an immutable, explicit copy of self-contained HTML, source files, and a reviewed
conversation. It is separate from `/s/:id`, which remains a live encrypted observer stream from
the owner's computer. Public output runs in an opaque sandbox with network access blocked.
Source and chat render as text outside that sandbox. Uploaded covers accept PNG, JPEG, and WebP.

**Fork** opens `harness://fork/<public-id>?request=<uuid>` directly from the click. The macOS
and Linux desktop hosts queue the link through startup and sign-in. Once This computer connects,
the app imports a project under `~/harnesses/<project-name>/`, prepares the trusted Store
harness, and opens the normal 70% viewer / 30% agent workspace. Fork receipts and generated
viewer packages stay under `~/.harness/community/forks/`. Existing imports move into `~/harnesses/`
on reopening, with a compatibility link preserving running conversations. Repeated clicks reuse the receipt,
project and session; imported files are never overwritten on retry. There is no unsolicited task
or model prompt. The selected agent starts fresh with `SESSION.md` as published context, rather
than resuming a vendor's private native session. `[Blender] [Codex]` means the Blender harness
with Codex selected for continuing it, not a claim about the original recording's engine.

This requires a desktop build with the URL handler. If it is not installed, the inline fallback
links to Download and preserves the chosen project for **Open in Harness** afterward. Browsers
may require their standard confirmation before opening another app. Windows protocol registration
is not implemented. Local desktop builds can use
`--dart-define=HARNESS_COMMUNITY_ORIGIN=http://127.0.0.1:54880`; public links cannot choose a host,
file path, install command or external package. Public source is validated before an atomic import;
only allowlisted Store harnesses and the locally authored generic Web Viewer package can be installed.

An optional ZIP includes a spec-1 Web Viewer package, editable project, `SESSION.md`, MIT license
and `OPEN-HARNESS.json`. Native source and binary artifacts remain included, but use the desktop
handoff to open the named harness's tools. Publishing a fork retains its source and copyright chain.
In the desktop Share dialog, **Publish to Hub** gathers the current local project files and recent
conversation through existing app APIs. A short-lived loopback page transfers them into an IndexedDB
draft in the browser, then opens `/hub/publish` for review. No access token or native session ID is
transferred. Nothing becomes public until the creator reviews the output, source and conversation
and clicks Publish. A draft survives the existing sign-in flow; repeated submission uses one
publication ID. Remote projects and older apps can use the project-folder picker or import
`OPEN-HARNESS.json`. The first version requires a self-contained HTML preview, up to 30 files/6 MB;
hidden configuration, symlinks and installed dependencies are excluded. Conversation tails may be
incomplete and the review form says so. `/explore` links remain compatible with `/hub`.

Backend reads are public; likes, comments, following, publication, and unpublication require SSO.
Counts are persisted, like/follow writes are idempotent, comment retries have per-user request IDs,
replies retain their parent and display a Creator badge,
and authors can remove their publication and moderate its comments. Reads and writes are isolated
by account environment. The feed loads 30 publications per page as visitors scroll; comment views show the latest
100 comments. Search filters loaded projects. Public navigation and downloads use the production
account plane; staging API isolation is supported for backend testing.

The examples live in `public/open-harnesses/`: nine self-contained Codex projects, the eight
featured projects from `store/hands-on.json`, and the existing Harness Store Marp keynote. The
featured projects reuse the Store's posters and recordings from `docs/images/`, plus editable
source from its fixtures/templates (the Go2 trajectory comes from the existing MuJoCo project).
Their detail page plays the existing recording and labels the conversation as a published brief,
not the original session transcript. Forks carry the source and available native output (GLB,
PDF, molecules and trajectory data); recordings stay on the web. The Jev Sheets example remains
explicitly offline practice with fictional rows. Blender's portable `blender-design.json` restores
the viewer's Shape Lab controls when imported.

`source-files.json` lists each named harness's portable files. Binary artifacts use base64 in the
snapshot and decode back to their original bytes in desktop imports and ZIPs. The snapshot limit
is 6 MB, with 30 files and 3 MB per encoded file. Keep dependencies in the installed Store harness;
do not bundle credentials, model-session IDs, hooks or hidden configuration. Native tools are
prepared by the Store installation; Godogen reuses its installed dependencies in the fork.

Regenerate the original nine SVG covers with `python3 scripts/generate-community-covers.py`.
Add a starter to `src/lib/community/starters.ts` (or `featured.json`) and the backend's
`communityStarters` allowlist. Real account SSO and native platform checks remain distinct from
local fixture authentication used for development.
