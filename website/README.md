# harness.autonomous.ai

The Harness web app is the Flutter app in [`../desktop`](../desktop), built for the browser. This
package is the small Next.js host that serves it and adds the few routes the rest of Harness links to.

It replaced the React website that lived in `autonomous-ai/autonomous-code` (`apps/web`). That app is
retired; only the host routes below were kept.

## Routes

| Route | What |
|---|---|
| `/`, `/s/:id`, `/auth/callback`, `/callback` | The Flutter app (`public/harness-web/index.html`, via `rewrites()` in `next.config.js`) |
| `/download` (and `/install` → it) | Install page: CLI command and desktop downloads |
| `/pair` | Phone setup guidance — the mobile app and the desktop "add phone" dialog link here |
| `/desktop` | Desktop download page |
| `/pro` | Harness Pro product page with an interactive, local experience preview |
| `/desktop/download-macos`, `/desktop/download/linux-{x64,arm64}` | Redirect to the latest build in the desktop manifest |
| `/flash-circle.sh` | The dial firmware flasher script |
| `/install.sh`, `/cli/install.sh`, `/desktop/install.sh` | Redirect to the installers on `cdn.autonomous.ai` |
| `ac.autonomous.ai`, `fleet.autonomous.ai` | Redirect to `harness.autonomous.ai` |

The CLI installer is `cli/scripts/install.sh`. The desktop installer's source is
`scripts/desktop-install.sh` here, published with `scripts/upload-desktop-install-sh.sh`.

The Pro page lives in `src/app/pro/`. Its sample workspace never sends commands to
real agents or records microphone audio. The final enclosure renders and existing
Harness companion artwork are in `public/pro/`; `artwork-provenance.json` records
their sources. The Pro story unfolds vertically: voice, navigation, decisions, Carry,
Return, Goal/Loop, Today, companions, and hardware. Features are visible without selecting
tabs. Each inline example has its own state and reset; offscreen clocks pause,
mobile visitors can scroll over the device, and reduced-motion preferences are
respected. The paired app, voice, telemetry, and host receipts are fixtures.
Two-finger workspace switching is optional; all core paths have visible
single-touch controls. The separate Pro firmware branch now implements and replay-tests
the GT911 multi-contact path, spatial map, local questions, and Open/Return. Physical
touch and live app trials remain outstanding. Browser input is outside this iteration.
Carry review puts the instruction first, with a labeled passage preview below and
Send fixed at the bottom. The source and recipient freeze when recording starts;
only an unused tray expires. The full passage remains host-owned. Native Carry
retains the visible draft part and local preview after disconnect, read-only.
The existing app remains at `/`.

## Releasing

Push a `vX.Y.Z_web` tag — `make release-web` from the repo root cuts the next one.
`.github/workflows/release-web.yml` builds the Flutter bundle from `desktop/`, bakes it into
`Dockerfile.k8s` through `HARNESS_WEB_ARCHIVE`, and pushes
`gcr.io/autonomous-ecm/autonomous-code-website:<tag>` and `:latest`. ArgoCD rolls it out; verify
`https://harness.autonomous.ai/harness-web/release.json` afterward. Rollback is the previous image
tag, which carries its own bundle. The bundle is also published as a GitHub Release.

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
