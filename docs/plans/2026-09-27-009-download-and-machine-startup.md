# Download page and browser startup

Requested: match the download page to the current terminal UI and open the machine picker automatically only when there is no connected machine.

## Download page

The website source is in the separate `autonomous-ai/autonomous-code` repository. The download changes were merged into `deploy/flutter-web` in [PR #6](https://github.com/autonomous-ai/autonomous-code/pull/6), commit `b8b4abb9f997418258f4cbdbac5f26971d13fb6c`, and deployed as `v1.2.19_web`. The local worktree is `/private/tmp/harness-download-ui-20260927`.

- Replaced the old amber buttons and rounded card with the terminal palette, monospace text, flat sections, workspace navigation and bracketed actions.
- Kept the existing manifest-backed macOS/Linux download routes.
- Shortened the CLI install command to `curl -fsSL https://harness.autonomous.ai/install.sh | bash`. The new `/install.sh` route redirects to the existing CDN installer, and all website install surfaces use the shared constant.
- Kept commands visible when copied; provided keyboard-accessible copy controls, success feedback and a manual-copy fallback.
- Stacked the sections on narrow screens and truncated long commands with an ellipsis; hovering reveals the full command and Copy keeps the complete value.
- Workspace links use full document navigation because `/` is served by Flutter, not the Next.js router.

Local production preview: <http://127.0.0.1:54873/download>.
Screenshots: `/private/tmp/harness-download-ui-desktop.png` and `/private/tmp/harness-download-ui-mobile.png`.

## Machine picker

The Flutter changes remain in this checkout on `harness-web-release-readiness`.

- Wait for discovery and saved connections to finish connecting or reconnecting.
- Suppress the automatic picker if an owned machine is connected, even if another selected machine needs linking.
- Offer the picker once when discovery finishes with no connection, including an empty machine list or offline machines.
- Dismissal stays dismissed for the visit. Later connection loss does not interrupt the workspace.
- Alt-M and explicit machine setup navigation still work. Native startup behavior is preserved.

## Verification

- Chrome workspace/startup tests: 10 passed.
- Native machine-picker, link-prompt and first-workspace regressions: 31 passed.
- Focused Flutter analysis: no issues. Production Flutter web build passed (`desktop/build/web-machine-startup`).
- Download, connect and installer command tests: 9 passed. Focused ESLint has no errors (two existing warnings in `next.config.js`); the standard Next.js production build/typecheck passed.
- The local `/install.sh` route follows one redirect to HTTP 200. Its response matches the CDN installer byte-for-byte and passes `bash -n`; the script was not executed. The existing `/cli/install.sh` redirect still works.
- Standalone `tsc` also reads the repository's `.spec` files and reports missing test declarations and mock typing errors. Next.js excludes test files from its production diagnostics; no build check was disabled or configuration changed for this work.
- Reviewed the production page in Chrome at desktop, 390 px and 320 px widths, including keyboard copying, readable commands, zero horizontal overflow, and full navigation into the Flutter web app. No browser console errors.

## Deployment

- Website release `v1.2.19_web`: [production build passed](https://github.com/autonomous-ai/autonomous-code/actions/runs/36364667119).
- Verified the live `/download` page shows the redesigned layout and short install command. Screenshot: `/private/tmp/harness-download-live-v1.2.19.png`.
- Verified `https://harness.autonomous.ai/install.sh` follows one redirect to HTTP 200 and returns the published installer byte-for-byte; `bash -n` passes without executing it.
- The machine-picker startup changes above remain local in the openharness checkout. The website release keeps the previously published Flutter bundle (`0.1.3`); sharing PR #394 and readiness PR #395 are separate pending releases.
