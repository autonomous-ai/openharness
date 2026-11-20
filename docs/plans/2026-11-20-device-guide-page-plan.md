# Harness Device guide page Implementation Plan

> **For agentic workers:** REQUIRED: execute with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** `harness.autonomous.ai/device` becomes the Harness Device guide (set up, use, works with, what's new, downloads,
help), its release sections read from the live device manifest, and `/desktop` 308-redirects to it.

**Architecture:** A pure release module (`website/src/lib/deviceRelease.ts`) parses the public device manifest into
builds and notes and picks the visitor's build; the `/device` page is an async server component that fetches it
(revalidate 60 s, 10 s timeout) and renders the mockup's sections, with two small client components for the parts that
depend on the visitor's computer. `next.config.js` gains one exact-path redirect; the old `/desktop` page goes.

**Tech Stack:** Next.js 16 (App Router, standalone output), React 19, CSS modules, `next/font/google` (Geist, Geist
Mono), Vitest 4 + jsdom + Testing Library.

**Spec:** `docs/plans/2026-11-20-device-guide-page-design.md`. Visual and copy source:
`/Users/duynguyen/go/src/github.com/autonomous-ai/autonomous-harness/website/mockup/device-guide.template.html`
(below: "the template"; gitignored in the main checkout, read it by absolute path). All work is in `website/`; run
commands from `/Users/duynguyen/orca/workspaces/autonomous-harness/desktop-guide-mockup/website`.

## Global Constraints

- Copy, layout and CSS come verbatim from the template. The yellow `.mock` strip, its CSS and the template's `<script>`
  are not part of the page; nothing reads or sets `data-theme` (no theme switch, light and dark follow
  `prefers-color-scheme`).
- Manifest: `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json`, fixed, no
  environment override. Allowed asset prefixes: `https://cdn.autonomous.ai/harness/device/` and
  `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/`.
- Fallback download (manifest unusable): `/device/download-macos`, line "For Mac · macOS 13 or later".
- Bounds: notes at most 6, builds at most 12. Fetch: `next: { revalidate: 60 }`, `AbortSignal.timeout(10_000)`.
- Failures log one line naming the reason (`device manifest: <reason>`), never manifest content.
- Tests never touch the network: stub `fetch` (`vi.stubGlobal`) or mock `fetchDeviceRelease`.
- Product page link: `https://www.autonomous.ai/harness-device`. Support: `human@autonomous.ai`.
- Page metadata: title "Harness Device", description "Set up and use your Harness Device.".
- Images are plain `<img>` with `width` and `height` (the `no-img-element` lint rule is a warning here).
- Website only; no deploy. Website CI gates: `npm ci`, `npx tsc --noEmit`, `npx eslint .`, `npx vitest run`,
  `npm run build`, route checks.

## Review Focus

1. A Mac with per-CPU builds only (an `arm64` and an `x64` dmg, no universal one): `macos-arm64` gets the Apple silicon
   build, `macos` (CPU unknown) gets the Intel build (the repo's rule in `desktopPlatform.ts`: an unknown-CPU Mac gets
   the build every Mac runs), and the labels read "Mac · Apple silicon" / "Mac · Intel", never the template's
   "Linux · Apple silicon" (its arch names ignore the OS). Pinned in Task 1.
2. Notes with no `- ` lines (today's first line is "Harness Device 0.1.10"), or no `notes` at all: What's new shows the
   version and date with no list, not an empty `<ul>`. Pinned in Tasks 1 and 4.
3. `pub_date` missing or not a date: the date line is empty, never "Invalid Date". Pinned in Task 1.
4. `size` missing, zero or not a number: the file row shows the package alone (".dmg"), never "NaN MB". Pinned in
   Task 1.
5. A manifest with a `version` but no build that passes the allowlist: the page falls back exactly as when the manifest
   is down (spec, Failure and limits), not a hero with no button. Pinned in Task 1 (parse returns null) and Task 4.

---

### Task 1: Release data module

**Effort:** high. **Depends on:** none.

**Files:**
- Create: `website/src/lib/deviceRelease.ts`
- Create: `website/src/lib/deviceRelease.spec.ts`
- Modify: `website/src/lib/desktopManifest.ts` (export `isReleaseAsset`, no other change)
- Modify: `website/src/app/device/download-macos/route.ts` (import the two constants, drop its own copies)
- Test (unchanged, must stay green): `website/src/app/device/download-macos/route.spec.ts`

**Interfaces:**
- Consumes: `isReleaseAsset(url: string, allowedPrefixes: readonly string[], extension: string): boolean` from
  `@/lib/desktopManifest`; `VisitorPlatform` from `@/lib/desktopPlatform`.
- Produces (all exported from `@/lib/deviceRelease`):

```ts
export const DEVICE_MANIFEST_URL: string;
export const DEVICE_ASSET_PREFIXES: readonly string[];
export const DEVICE_FALLBACK_URL = "/device/download-macos";
export type DeviceOs = "macos" | "windows" | "linux";
export type DeviceArch = "arm64" | "x64";            // aarch64 -> arm64, x86_64 -> x64
export type DevicePackage = "dmg" | "msi" | "exe" | "deb" | "rpm" | "appimage";
export type DeviceBuild = {
  os: DeviceOs; arch: DeviceArch | null;            // null = universal
  pkg: DevicePackage; url: string;
  label: string;                                    // "Mac · Apple silicon and Intel"
  detail: string;                                   // ".dmg · 11.1 MB" or ".dmg"
};
export type DeviceRelease = { version: string; date: string; notes: string[]; builds: DeviceBuild[] };
export const OS_NAME: Record<DeviceOs, string>;     // { macos: "Mac", windows: "Windows", linux: "Linux" }
export function parseDeviceRelease(manifest: unknown): DeviceRelease | null;
export function pickBuild(builds: readonly DeviceBuild[], platform: VisitorPlatform | null): DeviceBuild | null;
export function fetchDeviceRelease(): Promise<DeviceRelease | null>;
```

Rules the code must hold (from the spec and the template's script):
- Build keys: `/^device-(macos|windows|linux)(?:-(arm64|aarch64|x64|x86_64))?-(dmg|msi|exe|deb|rpm|appimage)$/`.
  Extension per package for `isReleaseAsset`: `.dmg .msi .exe .deb .rpm .AppImage`. `platforms` and keys without a
  package (`device-macos`, `device-macos-arm64`) never match.
- One URL under two keys is one build; if any of its keys has no arch, the build is universal.
- Order: os macos, windows, linux; within an os universal, arm64, x64; then package in the list order above. Cap 12.
- Labels: Mac universal "Mac · Apple silicon and Intel", Mac arm64 "Mac · Apple silicon", Mac x64 "Mac · Intel";
  other OS: the OS name, plus " · ARM64" / " · x64" when it has an arch. Detail: package name (`.dmg`, `.msi`, `.exe`,
  `.deb`, `.rpm`, `AppImage`), plus ` · <bytes/1048576 to 1 decimal> MB` when `size` is a positive number.
- `date`: `pub_date` as `toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })`,
  `""` when missing or invalid.
- `notes`: lines of `notes` trimmed, those starting `- `, without `- ` and a trailing `\s*\(#\d+\)`, empty ones
  dropped, at most 6.
- Returns null when the manifest is not an object, `version` is not a non-empty string, or no build is usable.
- `pickBuild`: `macos-arm64` → Mac arm64, else Mac universal; `macos`, `unknown` and `null` → Mac universal, else Mac
  x64, else the first Mac build; `windows` (the browser never gives the CPU) → Windows universal, else Windows x64
  (open question 2 default); `linux-x64`/`linux-arm64` → Linux of that arch, else Linux universal; `linux` (CPU
  unknown) → Linux universal, else null; `mobile` → null. Anything not found → null.
- `fetchDeviceRelease`: `fetch(DEVICE_MANIFEST_URL, { next: { revalidate: 60 }, signal: AbortSignal.timeout(10_000) })`;
  null and one `console.warn` line on: thrown fetch (`unreachable`), `!res.ok` (`HTTP <status>`), JSON error
  (`unreadable`), parse null (`no usable release`).

- [ ] **Step 1: Write the failing tests** in `deviceRelease.spec.ts`, with a `LIVE` fixture copied from today's
  manifest shape (`version: "0.1.10"`, `pub_date: "2026-11-19T15:19:46Z"`, `platforms` with two `.app.tar.gz`
  entries, `device-macos` and `device-macos-arm64` as `.app.tar.gz`, `device-macos-dmg` and `device-macos-arm64-dmg`
  both `{ url: "https://cdn.autonomous.ai/harness/device/0.1.10/Harness-Device.dmg", size: 11650555 }`, `notes:
  "Harness Device 0.1.10\n\n- Harness Device: the Orca plugin is set up by default; the Connect Orca row is gone (#4498)\n- Linux: Harness follows the XDG Base Directory paths, and moves ~/.harness there once (#4469)"`).

```ts
it("reads today's manifest as one universal Mac build", () => {
  const r = parseDeviceRelease(LIVE)!;
  expect(r.version).toBe("0.1.10");
  expect(r.date).toBe("Nov 19, 2026");
  expect(r.builds).toEqual([{ os: "macos", arch: null, pkg: "dmg",
    url: "https://cdn.autonomous.ai/harness/device/0.1.10/Harness-Device.dmg",
    label: "Mac · Apple silicon and Intel", detail: ".dmg · 11.1 MB" }]);
  expect(r.notes).toEqual([
    "Harness Device: the Orca plugin is set up by default; the Connect Orca row is gone",
    "Linux: Harness follows the XDG Base Directory paths, and moves ~/.harness there once"]);
});
```

  Further cases, each its own `it`:
  - `device-windows-x64-msi` and `device-linux-aarch64-appimage` (`.../0.1.10/Harness-Device.AppImage`) added: three
    builds in order Mac, Windows, Linux; labels "Windows · x64", "Linux · ARM64"; Linux detail starts "AppImage".
  - Refused URLs (each alone as `device-macos-dmg`, so parse returns null): `https://evil.example/a.dmg`,
    `https://cdn.autonomous.ai/harness/desktop/1.2.3/Harness-macos.dmg`, `.../device/0.1.10/Harness-Device.app.tar.gz`,
    `.../device/%2e%2e/desktop/1.0.81/x.dmg`, a `.msi` URL under `device-macos-dmg`.
  - Per-arch Mac builds (`device-macos-arm64-dmg` → `A.dmg`, `device-macos-x64-dmg` → `B.dmg`): labels
    "Mac · Apple silicon", "Mac · Intel"; `pickBuild(builds, "macos-arm64")` is A; `pickBuild(builds, "macos")` and
    `pickBuild(builds, null)` are B.
  - `pickBuild` on today's builds: `macos`, `macos-arm64`, `unknown`, `null` → the Mac build; `windows`, `linux-x64`,
    `linux`, `mobile` → null. With a `device-linux-x64-deb` added: `linux-x64` → it, `linux-arm64` and `linux` → null.
    With a `device-windows-x64-msi` added: `windows` → it.
  - Notes: 8 bullet lines → 6; `notes` absent or with no `- ` line → `[]`.
  - `pub_date` absent or `"soon"` → `date` is `""`. `size` absent, `0` or `"12"` → detail `.dmg`.
  - 20 distinct valid build keys/URLs → 12 builds.
  - Null for `null`, `"x"`, `[]`, `{}` , `{ version: "" , ... }`, and a manifest with a version but only tar.gz entries.
  - `fetchDeviceRelease` with `vi.stubGlobal("fetch", ...)`: resolves LIVE → release, and the call was
    `(DEVICE_MANIFEST_URL, expect.objectContaining({ next: { revalidate: 60 } }))`; rejected fetch, `status: 503`,
    body `"<html>"` → null, and `console.warn` (spied) called once per case with a string matching
    `/^device manifest: (unreachable|HTTP 503|unreadable)$/` that does not contain the body.

- [ ] **Step 2: Run to see it fail.** `npx vitest run src/lib/deviceRelease.spec.ts` → FAIL, cannot resolve
  `./deviceRelease`.
- [ ] **Step 3: Implement** `deviceRelease.ts` per the Interfaces and rules above; add `export` to `isReleaseAsset` in
  `desktopManifest.ts`; in `device/download-macos/route.ts` replace `MANIFEST_URL` and `ALLOWED_PREFIXES` with
  `DEVICE_MANIFEST_URL` and `DEVICE_ASSET_PREFIXES` (keep the "fixed, no environment override" comment on the constant
  in its new home).
- [ ] **Step 4: Run to see it pass.** `npx vitest run src/lib/deviceRelease.spec.ts src/app/device/download-macos`
  → PASS; `npx tsc --noEmit` → no errors.
- [ ] **Step 5: Commit** (red test first, then the code, as devcrew phase 3 does):
  `Website: device release data from the live manifest, one allowlist with /device/download-macos`.

---

### Task 2: Guide assets

**Effort:** medium. **Depends on:** none. **No red test** (static files, no behavior); one commit.

**Files:** create in `website/public/device/`: `icon.png`, `dial.png`, `dial-dark.png`, `face.webp`, `menubar.svg`,
`apps/claude.png`, `apps/chatgpt.png`, `apps/vscode.png`, `apps/cursor.png`, `apps/orca.png`, `apps/herdr.png`,
`apps/terminal.png`.

- [ ] **Step 1: Copy** (`M=/Users/duynguyen/go/src/github.com/autonomous-ai/autonomous-harness`,
  `L=$M/devices/harness-device/mockup/landing-connect`):
  `$L/harness-device-icon.png → icon.png`, `$L/dial.png → dial.png`, `$M/website/mockup/dial-dark.png → dial-dark.png`,
  `$L/face-sprite.webp → face.webp`, `$M/devices/harness-device/mockup/pixel-h/menubar/dial-connected-18ptTemplate@2x.svg
  → menubar.svg`, `$L/apps/<name>.png → apps/<name>.png` for the seven names.
- [ ] **Step 2: Check.** `du -ch public/device/*.* public/device/apps/*.png | tail -1` about 650-700 KB; `cat
  public/device/menubar.svg` is plain SVG with no `<script>` and no external reference.
- [ ] **Step 3: Commit:** `Website: Harness Device guide images`.

---

### Task 3: `/desktop` redirects to `/device`; the old page goes

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `website/next.config.js` (one entry in `redirects()`, beside the other site redirects)
- Create: `website/scripts/desktop-redirect.spec.ts`
- Modify: `website/scripts/check-harness-web.mjs` (route checks CI runs on the standalone server)
- Modify: `website/public/sitemap.xml` (`/desktop` → `/device`)
- Delete: `website/src/app/desktop/page.tsx`, `website/src/app/desktop/DesktopDownload.tsx`,
  `website/src/app/desktop/DesktopDownload.spec.tsx`
- Modify (comments only, they name the `/desktop` page): `website/src/proxy.ts` (the "/desktop is prerendered" note:
  name `/download` instead), `website/src/lib/desktopPlatform.ts` (header: "the download buttons on `/download` and
  `/device`")
- Modify, per open question 1 (default: retarget): `website/src/app/hub/components/ExploreIntro.tsx` and
  `website/src/app/hub/components/HubFooter.tsx` (`href="/desktop"` → `"/download"`, labels unchanged), with
  `website/src/app/hub/components/community.spec.tsx` (one new `it`: `render(<HubFooter />)` → link "Harness desktop
  app" has `href` `/download`; red before the change)

Leave `website/src/app/desktop/page.module.css`: today's `/device` page still imports it; Task 4 deletes it.

- [ ] **Step 1: Write the failing test** `scripts/desktop-redirect.spec.ts`, importing `nextConfig from
  "../next.config.js"` as `scripts/agents-site.spec.ts` does:

```ts
it("sends /desktop, and only that path, to the device guide for good", async () => {
  const site = (await nextConfig.redirects()).filter((r) => !r.has);
  expect(site).toContainEqual({ source: "/desktop", destination: "/device", permanent: true });
  // Next matches a source exactly, so only a /desktop/... source could catch the download routes.
  expect(site.filter((r) => r.source.startsWith("/desktop/")).map((r) => r.source)).toEqual(["/desktop/install.sh"]);
});
it("lists /device in the sitemap, not /desktop", () => {
  const sitemap = readFileSync(join(process.cwd(), "public", "sitemap.xml"), "utf8");
  expect(sitemap).toContain("<loc>https://harness.autonomous.ai/device</loc>");
  expect(sitemap).not.toContain("harness.autonomous.ai/desktop<");
});
```

- [ ] **Step 2: Run to see it fail.** `npx vitest run scripts/desktop-redirect.spec.ts` → FAIL, no `/desktop` entry.
- [ ] **Step 3: Implement.** Add `{ source: '/desktop', destination: '/device', permanent: true }` with a one-line why
  comment (the device guide replaced the desktop download page, owner 2026-11-20; `/desktop/download/*` stays); edit
  the sitemap; delete the three files; edit the two comments. In `check-harness-web.mjs` change the 200 loop to
  `['/download', '/device', '/pair']` and add a check that `/desktop` (fetch with `redirect: 'manual'`) answers 308
  with `location` `/device`; update its final `console.log` wording if it names the pages.
- [ ] **Step 4: Run to see it pass.** `npx vitest run` (whole suite: nothing else imported `DesktopDownload`) → PASS;
  `npx tsc --noEmit`, `npx eslint .` → clean.
- [ ] **Step 5: Commit:** `Website: /desktop redirects to the Harness Device guide`.

---

### Task 4: The `/device` guide page

**Effort:** high. **Depends on:** Task 1 (`deviceRelease` API), Task 3 (deleting `desktop/page.module.css` needs
`desktop/page.tsx` gone).

**Files:**
- Rewrite: `website/src/app/device/page.tsx`, `website/src/app/device/page.spec.tsx`
- Create: `website/src/app/device/page.module.css`, `website/src/app/device/DeviceDownload.tsx`,
  `website/src/app/device/DeviceDownload.spec.tsx`, `website/src/app/device/DeviceFiles.tsx`
- Delete: `website/src/app/desktop/page.module.css`

**Interfaces:**
- Consumes: Task 1's `DeviceBuild`, `DeviceRelease`, `OS_NAME`, `DEVICE_FALLBACK_URL`, `pickBuild`,
  `fetchDeviceRelease`; `useVisitorPlatform()` from `@/lib/useVisitorPlatform`. Asset paths from Task 2
  (`/device/icon.png`, ..., `/device/apps/<name>.png`); tests do not load them.
- Produces: `export function DeviceDownload(props: { builds: readonly DeviceBuild[]; version: string | null })`,
  `export function DeviceFiles(props: { builds: readonly DeviceBuild[] })` (both `"use client"`), and the default
  export `async function DevicePage()` plus `metadata` and `viewport`.

Decisions for the code:
- `page.tsx` awaits `fetchDeviceRelease()` and renders the template's `<header class="top">`, `<main>` sections and
  `<footer>` in order, inside one root `<div className={styles.page}>`. Template classes map to module classes
  (`class="step"` → `styles.step`); the brand link's `href` is `/device`. Hero `.dl` is `<DeviceDownload builds
  version />` (`[]`/`null` when no release). What's new: the notes panel (`<h3>Version {version}</h3>`, sub = `date`,
  `<ul>` only when `notes.length`) renders only with a release; without it the `.news` grid is one column (a modifier
  class, not an inline style). The Downloads panel's sub is `Version {version}` (empty without a release) over
  `<DeviceFiles builds />`.
- `DeviceDownload`: `pick = pickBuild(builds, useVisitorPlatform())`. No builds → button to `DEVICE_FALLBACK_URL`,
  meta "For Mac · macOS 13 or later", no others. Pick → `<a className={btn} href={pick.url}>` with the template's
  download SVG (`aria-hidden`) and "Download"; meta `For <b>{label}</b> · version {version}` plus ` · macOS 13 or later`
  for a Mac build; then the other builds as links (`label` text). Platform `mobile` → `<p>` "Open this page on your
  computer to download the app." and every build as a link. Otherwise, when the visitor's OS has no build at all →
  `<p>` "Not on {OS_NAME of the visitor's OS} yet. Harness Device runs on {OS names of the builds, joined " and "}."
  and every build as a link (visitor OS: `windows` → Windows, `linux*` → Linux); when it has builds but none fits
  (Linux, CPU unknown, per-CPU builds only) → no button and no sentence, every build as a link (open question 2
  default).
- `DeviceFiles`: each build is `<li>` with `<a className={k} href={url}>{label}</a><span className={s}>{detail}</span>`;
  the picked one's link is followed by `<span className={here}>This computer</span>`, real text in place of the
  template's `li.here .k::after` (same CSS on the span), so screen readers and tests read it; no builds → the single fallback row "Mac · Apple silicon and Intel" / ".dmg"
  linking `DEVICE_FALLBACK_URL`.
- `page.module.css`: the template's CSS minus `.mock`. The `:root` tokens and the dark `@media` block move onto
  `.page` (drop every `[data-theme]` rule and duplicate); every element selector is scoped under `.page` (CSS modules
  need a local class: `h1` → `.page h1`); `.page` sets `background`, `color`, `font-family: var(--font-geist), ...`,
  `min-height: 100dvh`, `font-size: 16px`, `line-height: 1.5`; mono uses `var(--font-geist-mono)`. The site's globals
  are dark-only with a `*{margin:0;padding:0}` reset: set `:global(body):has(> .page){ background: #fff }` and its dark
  counterpart so overscroll matches, and restore any margin the template relied on browser defaults for (compare in
  Verification).
- Fonts in `page.tsx`: `Geist({ subsets: ["latin"], weight: ["400","500","600"], variable: "--font-geist" })` and
  `Geist_Mono({ subsets: ["latin"], weight: ["400","500"], variable: "--font-geist-mono" })`; both `variable`
  classes on the root div.
- `export const metadata = { title: "Harness Device", description: "Set up and use your Harness Device." }` and
  `export const viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#ffffff" },
  { media: "(prefers-color-scheme: dark)", color: "#111111" }] }`.

- [ ] **Step 1: Write the failing tests.**

  `DeviceDownload.spec.tsx` mocks `@/lib/useVisitorPlatform` as `DesktopDownload.spec.tsx` did (`let platform`;
  `vi.mock(..., () => ({ useVisitorPlatform: () => platform }))`), with builds from `parseDeviceRelease` of the LIVE
  fixture (copy the fixture; do not import a spec file). One `it` each:
  - platform `macos`: link named "Download" with `href` the dmg URL; text "For Mac · Apple silicon and Intel ·
    version 0.1.10 · macOS 13 or later" (`toHaveTextContent` on the block); no other link.
  - platform `null` (first render, server render): the same button and line.
  - platform `windows`: no "Download" link; text "Not on Windows yet. Harness Device runs on Mac."; one link
    "Mac · Apple silicon and Intel" to the dmg.
  - platform `mobile`: no "Download" link; "Open this page on your computer to download the app."; the Mac link.
  - platform `linux-x64` with a `device-linux-x64-deb` build added: "Download" goes to the deb; line "For Linux · x64 ·
    version 0.1.10" without "macOS 13"; a link "Mac · Apple silicon and Intel".
  - no builds, version null: "Download" → `/device/download-macos`; "For Mac · macOS 13 or later"; no "version".

  `page.spec.tsx` replaces today's: `vi.mock("next/font/google", () => ({ Geist: () => ({ variable: "geist" }),
  Geist_Mono: () => ({ variable: "geist-mono" }) }))`; `vi.mock("@/lib/useVisitorPlatform", ...)` returning `"macos"`;
  `vi.mock("@/lib/deviceRelease", async (orig) => ({ ...(await orig()), fetchDeviceRelease: vi.fn() }))`, the mock
  resolving `parseDeviceRelease(LIVE)` or `null`; render with `render(await DevicePage())`.
  - With the release: headings "Get the app.", "Plug in.", "Open your agents."; "Tap. Talk.", "Send.", "Swipe.",
    "Scroll.", "Hold."; text "Drag up or down to read back."; "up to 10 minutes a message", "30 minutes a day";
    "Claude", "ChatGPT", "VS Code", "Cursor", "Orca", "herdr", "Terminal", "More joining"; the five summaries from the
    template; text "Export logs"; a link `mailto:human@autonomous.ai`; a link named "Product page ↗" to
    `https://www.autonomous.ai/harness-device`; heading "Version 0.1.10", "Nov 19, 2026", list items equal to the two
    cleaned notes (no "#4498"); in the Downloads list a link "Mac · Apple silicon and Intel", the text ".dmg · 11.1 MB"
    and that row's text includes "This computer" (exactly one "This computer" on the page).
  - With no release: a link named "Download" to `/device/download-macos`; no heading "Version 0.1.10" or any
    `/^Version /`; the Downloads list has exactly one link, to `/device/download-macos`; no "This computer".
  - With a release whose notes are empty: heading "Version 0.1.10" present, no list inside the notes panel.
  - `metadata` equals the title and description in Global Constraints.

- [ ] **Step 2: Run to see it fail.** `npx vitest run src/app/device` → FAIL (`./DeviceDownload` missing; page
  renders the old card).
- [ ] **Step 3: Implement** the five files per the decisions above and delete `src/app/desktop/page.module.css`.
- [ ] **Step 4: Run to see it pass.** `npx vitest run` → PASS; `npx tsc --noEmit`, `npx eslint .` → no errors
  (img warnings are expected); `npm run build` → succeeds and lists `/device` (static with revalidate 60, `○` or `●`).
- [ ] **Step 5: Commit:** `Website: /device is the Harness Device guide, its downloads and notes from the live manifest`.

---

## Decisions on the planner's questions (orchestrator, 2026-11-20)

1. The Hub's "Get the Harness desktop app" (`ExploreIntro.tsx`) and its footer link "Harness desktop app"
   (`HubFooter.tsx`) point at `/desktop` and will land on the device guide. Default: retarget both to `/download`
   (which still offers the desktop app), labels unchanged, red test first. Answer: yes.
2. A visitor whose OS has only per-CPU builds and whose CPU the browser does not give (Windows always; Linux sometimes).
   Default: Windows gets the x64 build; Linux gets no button and no sentence, just the builds as links. Answer: yes.

## Pull request notes

- Body names: platforms (website only; checked in headless Chromium at 1280 and 390 px, light and dark); that the
  phone onboarding link (`autonomous.ai/go` → `/desktop`) now lands on the device guide, accepted by the owner; the
  proposal to write manifest `notes` for users from the next release on; the dark dial image as a stand-in with a
  follow-up for a real render; the red-then-green tests; Verification output below.
- Merge with `make merge-pr`. No website deploy: the orchestrator asks the owner.

## Verification

All local, on this Mac, against the locally built standalone server. The only outside request is the public,
read-only device manifest the page itself reads; no backend, no account, no deploy. CI's website-checks (run by
`ci.yml` on the pull request, or by hand: `gh workflow run website-checks.yml --ref feat/device-guide-page`) covers
tsc, eslint, vitest, the build and `check-harness-web.mjs` (which, after Task 3, asserts `/device` 200 and `/desktop`
308 → `/device`).

1. **Build and start** (after Tasks 1-4), in `website/`: `npm ci && npm run build`; pick a free port
   (`PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')`) and run
   `PORT=$PORT HOSTNAME=127.0.0.1 node .next/standalone/server.js` in the background (Monitor until `curl -sf
   http://127.0.0.1:$PORT/device` answers; no fixed sleep). Stop it at the end.
2. **Routes:**
   - `curl -sI http://127.0.0.1:$PORT/desktop` → `308`, `location: /device`.
   - `curl -sI http://127.0.0.1:$PORT/desktop/download-macos` and `/desktop/install.sh` → unchanged (302 to the
     desktop dmg, 308 to the CDN script).
   - `V=$(curl -s https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json | node -pe
     'JSON.parse(require("fs").readFileSync(0)).version')`; `curl -s http://127.0.0.1:$PORT/device` → 200 and contains
     `version $V` and the dmg URL from the manifest.
   - `curl -sI http://127.0.0.1:$PORT/device/download-macos` → `302`, `location` the manifest's `device-macos-dmg` URL.
3. **Render**, headless Chromium (`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new
   --disable-gpu --hide-scrollbars --screenshot=<scratch>/x.png --window-size=1280,<h> <url>`), with screenshots in the
   session scratchpad, never the repo:
   - 1280 px: `http://127.0.0.1:$PORT/device`, light (`--blink-settings=preferredColorScheme=1`) and dark
     (`=0`; confirm which value gives which theme from the image itself).
   - 390 px: a scratch HTML file holding `<iframe src="http://127.0.0.1:$PORT/device" width="390" height="<h>"
     style="border:0">` (headless Chrome has a ~500 px minimum window), light and dark.
   - The same four renders of the mockup (`.../website/mockup/device-guide.html`, its yellow strip ignored).
   - A person comparing them sees the same sections, copy, spacing and both themes; at 390 px one column, the dial above
     the hero text, no horizontal scroll, nav showing only "Product page ↗", the file rows and nav links not stretched
     by the site's 44 px mobile tap-target rule beyond what reads well. Any difference beyond the yellow strip and the
     download block's live content is fixed in Task 4's CSS before the review.
The manifest-down fallback needs no live check: Task 4's no-release test covers it.

No check needs the owner's own login or eye beyond the orchestrator's review of the screenshots; no temporary workflow
is needed (website-checks already runs the long checks on GitHub).
