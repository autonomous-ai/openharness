# Harness Device guide page: design

Date: 2026-11-20. Status: approved mockup (`website/mockup/device-guide.html` in the main checkout, gitignored), owner
go on 2026-11-20.

## Goal

`https://harness.autonomous.ai/device` becomes the one link the owner sends to every Harness Device buyer: how to set
it up and use it, with the right download for the visitor's computer. Releases update the page by themselves: it reads
the live device manifest, so a new version, its notes and its files show up with no web change and no deploy.

`https://harness.autonomous.ai/desktop` redirects to `/device`.

## Decisions (owner and orchestrator, 2026-11-20)

1. The guide lives at `/device`; `website/src/app/device/page.tsx` replaces today's download card.
2. `/desktop` (that exact path) redirects to `/device` with a permanent redirect (308). Every other `/desktop/...`
   route stays as it is: `/desktop/download/*`, `/desktop/download-macos`, `/desktop/install.sh`.
3. `/device/download-macos` stays as it is.
4. "What's new" shows the manifest's `notes` bullet lines as published, without trailing PR numbers. The pull request
   proposes writing `notes` for users from the next release on.
5. The gesture copy includes "Scroll. Drag up or down to read back." (confirmed by the owner).
6. The mockup's yellow control strip is not part of the page.
7. The dark-mode dial image is the mockup's stand-in (the render's floor reflection darkened). A proper render on a
   dark background is a follow-up.
8. Test, CI green, merge with `make merge-pr`. No website deploy: the orchestrator asks the owner.

## What the page shows

Top to bottom, as in the mockup (copy verbatim from it):

- Top bar: the Pixel H icon and "Harness Device"; links Set up, Use it, Help (anchors; hidden at phone width) and
  "Product page ↗" (`https://www.autonomous.ai/harness-device`).
- Hero: "Quick start" eyebrow, "Plug it in. / Start talking.", "Three steps. The app sets up the rest.", the download
  block, and the dial render with its animated face (still under reduced motion).
- Set up: three cards. 01 Get the app (menu-bar mock with "Sign in…"), 02 Plug in (dial with the USB-C cable,
  "Device ready"), 03 Open your agents (dial face, Claude Code and Codex pills).
- Use it: Tap. Talk. / Send. / Swipe. / Scroll. / Hold.; then "Voice up to 10 minutes a message", "Free 30 minutes a
  day".
- Works with: Claude, ChatGPT, VS Code, Cursor with their real icons and modes; terminal chips (Orca, herdr, Terminal
  with icons; Ghostty, iTerm2, tmux, cmux, Warp, WezTerm, OpenCode; "More joining"); the line naming the Claude Code
  plugin, the VS Code and Cursor extension and the Orca plugin the app adds.
- What's new: version, date and notes; Downloads: every build of the latest version, the visitor's marked
  "This computer".
- Need help?: the five questions of the mockup, the first open; "Export logs" and `human@autonomous.ai`.
- Footer: "© Autonomous", Product page, support email.

Light and dark follow the system (`prefers-color-scheme`); no theme switch. Phone width: one column, no horizontal
scroll, the dial above the hero text.

## Architecture

### Release data: `website/src/lib/deviceRelease.ts` (new)

- `DEVICE_MANIFEST_URL` and `DEVICE_ASSET_PREFIXES`: moved here from `device/download-macos/route.ts`, which imports
  them, so the page and the route share one allowlist.
- `parseDeviceRelease(manifest: unknown): DeviceRelease | null`, pure:
  - `version` and `pubDate` from the manifest; `notes`: the lines of `notes` that start with `- `, without the `- ` and
    a trailing ` (#1234)`, at most 6.
  - `builds`: the person-facing installers, the keys `device-<os>[-<arch>]-<package>` (`os` macos, windows or linux;
    `arch` arm64, aarch64, x64 or x86_64; `package` dmg, msi, exe, deb, rpm or appimage). `platforms` and the bare
    `device-macos` are the updater's `.app.tar.gz` and never shown. A URL passes only `isReleaseAsset` (exported from
    `desktopManifest.ts`, the rule the redirect routes use) with the package's extension. Two keys with one URL are
    one build; a key without an arch makes it universal (today `device-macos-dmg` and `device-macos-arm64-dmg` are the
    same file: one "Mac · Apple silicon and Intel" build).
  - At most 12 builds, in a fixed order (macos, windows, linux).
  - Returns null when the manifest is not an object or has no `version`.
- `fetchDeviceRelease(): Promise<DeviceRelease | null>`: `fetch` with `next: { revalidate: 60 }` and a 10 s
  `AbortSignal.timeout`; any failure (network, status, JSON) returns null and logs one line naming the reason, no
  content. A new release shows within a minute; the page never waits more than 10 s on the bucket.

### Page: `website/src/app/device/`

- `page.tsx`: an async server component. It awaits `fetchDeviceRelease()` and renders the static sections and the
  release-driven ones (What's new, Downloads). Metadata: title "Harness Device", description "Set up and use your
  Harness Device.".
- `DeviceDownload.tsx`: a client component, the hero's download block. Props: the builds and the version. It uses
  `useVisitorPlatform()` (existing) and picks the visitor's build:
  - `macos`, `macos-arm64`: the macos build (universal or matching arch);
  - `windows`, `linux-x64`, `linux-arm64`, `linux`: that OS's build (matching arch, else universal, else none);
  - `mobile`: no button; "Open this page on your computer to download the app.";
  - `unknown` and the first render (null, also the server render): the Mac build as the button, so the page works
    without script.
  - A computer the manifest has no build for (owner, 2026-11-20): "Harness Device is macOS-only for now." while every
    build is a Mac build (today), else "Harness Device isn't on Linux yet."; the Mac download button still shows, and
    the other builds as links. No button ever points at a build the manifest does not list: Windows and Linux builds
    appear by themselves once the manifest carries their keys.
  - Button text "Download"; under it "For <build> · version <v>" (plus " · macOS 13 or later" for a Mac build), then
    links to the other builds.
  - With no release (manifest down): the button links `/device/download-macos`, "For Mac · macOS 13 or later", no
    version; the Downloads panel lists that one link and What's new is not shown.
- `DeviceFiles.tsx` (client): the Downloads panel list, marking the visitor's build "This computer" with the same
  pick. The pick is one function, `pickBuild(builds, platform)`, in `deviceRelease.ts`, tested there.
- `page.module.css`: the mockup's CSS as a CSS module, its tokens scoped to the page root (the site's global theme is
  dark-only; this page sets its own background and colors for light and dark).
- Fonts: Geist and Geist Mono through `next/font/google` (downloaded at build time and served from the site: no
  request to Google from a visitor's browser).
- Assets in `website/public/device/`: `icon.png` (Pixel H), `dial.png`, `dial-dark.png`, `face.webp` (60-frame
  sprite), `menubar.svg` (the tray template), `apps/{claude,chatgpt,vscode,cursor,orca,herdr,terminal}.png`. About
  700 KB in all, the face sprite 300 KB of it. Images are plain `<img>` with width and height (the sprite animation
  needs the raw file; the rule is a warning in this repo).

### Redirect: `website/next.config.js`

`{ source: '/desktop', destination: '/device', permanent: true }` in `redirects()`. Next matches the exact path, so
`/desktop/download/...` and `/desktop/install.sh` are untouched.

### Removed

- `website/src/app/desktop/page.tsx`, `DesktopDownload.tsx`, `DesktopDownload.spec.tsx`: the redirect replaces the
  page. `desktop/page.module.css` goes too: its only other user is today's `/device` page, which this replaces.
- `sitemap.xml`: `/desktop` becomes `/device`.

## Consequence to note

The phone's onboarding sends `autonomous.ai/go`, which the main site forwards to `harness.autonomous.ai/desktop`
(`mobile/lib/phone/welcome/onboarding_copy.dart`). After this change that link lands on the device guide, not the
Harness desktop download. This follows the owner's redirect decision and the direction to drop the desktop app; the
pull request says so. The `/desktop/download/*` routes keep working for anything that links them directly.

## Data

Nothing stored, synced or new exposed: the page reads a public manifest the app's updater already reads, server side,
with the same host allowlist as the existing redirect. No identifiers, no analytics added.

## Failure and limits

- Manifest unreachable, slow (> 10 s), not JSON, or no usable build: the page renders with the fallback download and
  no release sections; one log line names the reason.
- Every list bounded: notes ≤ 6, builds ≤ 12.
- A tampered manifest cannot point a link outside the release folders (`isReleaseAsset`).

## Testing

Vitest, jsdom, at the layer where the behavior lives:

- `deviceRelease.spec.ts`: parsing the live manifest's shape (one universal Mac build from the two dmg keys; tar.gz
  entries ignored), a Windows and a Linux key, an off-bucket URL refused, a wrong extension refused, notes cleaned and
  capped, null for a non-object; `pickBuild` for each platform; `fetchDeviceRelease` returns null on network error,
  non-200 and bad JSON.
- `device/page.spec.tsx`: renders the page from a stubbed release (the 3 steps, the 5 gestures, the voice limits, the
  apps, the help questions, "Export logs", the product page link, What's new with cleaned notes, the Downloads list);
  with no release: the fallback link to `/device/download-macos` and no What's new.
- `DeviceDownload.spec.tsx`: Mac, Windows (no build), phone, and the first render, clicking nothing but reading what a
  person sees: the button's name "Download" and its href, the line under it, the other links.
- `next.config` redirect: a spec that `/desktop` maps to `/device` permanently and that no rule matches
  `/desktop/download/...`.
- `download-macos/route.spec.ts` keeps passing with the moved constants.

Checks: website-checks on the PR (tsc, eslint, vitest, production build, route checks). Verification (plan): build and
start the standalone server locally, `curl -I /desktop` shows 308 to `/device`, `/device` returns 200 with the version
from the live manifest, `/device/download-macos` still 302s to the dmg; a headless render at 1280 and 390 px, light
and dark, compared against the mockup.

## Platforms

Website only. The page itself is for Mac, Windows and Linux browsers and phones; checked in Chromium headless at
desktop and phone widths.
