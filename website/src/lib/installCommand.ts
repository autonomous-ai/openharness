/**
 * The one place the installer URL is written down.
 *
 * It used to live in two: a constant in `components/ConnectComputer`, and the same command hardcoded
 * again in the JSX of `app/connect/page.tsx`. That is how a URL change half-lands — one surface moves
 * and the other keeps telling users to fetch a path that no longer exists. Measured against a real
 * 404: `curl -fsSL … | bash` does print `curl: (22) … 404` (the `-S` in `-fsSL` keeps errors visible),
 * but the PIPELINE still exits 0, so nothing automated notices and the user is left with no CLI.
 *
 * The short public URL redirects to the CDN-published script (`next.config.js`), and `curl -L`
 * follows that redirect. The script stays in `website/scripts/cli-install.sh`, published with
 * `make upload-cli-install-sh`. The older `/cli/install.sh` URL remains supported as well.
 */
export const INSTALL_URL = "https://harness.autonomous.ai/install.sh";

/** The bootstrap one-liner, verbatim — what the UI shows and what the copy button puts on the clipboard. */
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_URL} | bash`;

/**
 * Same drift risk, same fix, for the desktop app. Also served off the CDN-fronted public bucket now:
 * source of truth is `website/scripts/desktop-install.sh`, published with
 * `make upload-desktop-install-sh`. The old web-app URL,
 * `https://harness.autonomous.ai/desktop/install.sh`, still 308-redirects here (`next.config.js`).
 * Resolves the current release from the live desktop manifest itself, so nothing here ever hardcodes
 * a version.
 */
export const DESKTOP_INSTALL_URL = "https://cdn.autonomous.ai/harness/desktop/install.sh";

/** The desktop bootstrap one-liner, verbatim. */
export const DESKTOP_INSTALL_COMMAND = `curl -fsSL ${DESKTOP_INSTALL_URL} | bash`;

/**
 * The stable, versionless link behind the macOS "Download" button — `src/app/desktop/download-macos/`.
 *
 * A redirect rather than a direct GCS link on purpose: published artifacts live under a versioned
 * path (`harness/desktop/<version>/Harness-macos.dmg`), so any link written down here would pin a
 * version and go stale the next time a release is cut. The route reads the same manifest the
 * installer and the in-app updater read, which keeps one source of truth instead of a second
 * "latest" copy in the bucket that can silently drift from it.
 */
export const DESKTOP_DOWNLOAD_URL = "/desktop/download-macos";

/**
 * Same idea as `DESKTOP_DOWNLOAD_URL`, one per Linux architecture — `src/app/desktop/download/linux-x64/`
 * and `.../linux-arm64/`, each redirecting to that architecture's `.AppImage` off the same manifest.
 */
export const DESKTOP_DOWNLOAD_LINUX_X64_URL = "/desktop/download/linux-x64";
export const DESKTOP_DOWNLOAD_LINUX_ARM64_URL = "/desktop/download/linux-arm64";

/**
 * The Apple silicon (Impeller) `.dmg` — `src/app/desktop/download/macos-arm64/`. Offered only to a Mac
 * whose browser reports an ARM CPU; `DESKTOP_DOWNLOAD_URL` stays the one every other Mac gets.
 */
export const DESKTOP_DOWNLOAD_MACOS_ARM64_URL = "/desktop/download/macos-arm64";

/**
 * Windows: `src/app/desktop/download/windows/`, redirecting to the manifest's `harness-install.exe`
 * (`desktop-windows-installer`). One x64 program for every Windows PC: it installs the app built for the
 * PC's own CPU, so there is no per-architecture link.
 */
export const DESKTOP_DOWNLOAD_WINDOWS_URL = "/desktop/download/windows";

/**
 * The PowerShell alternative to the Windows installer, verbatim. The script is the CLI's install.ps1 in its
 * app mode, published as `harness/desktop/install.ps1` by `cli/scripts/upload-install-ps1.sh --app --production`.
 */
export const DESKTOP_WINDOWS_INSTALL_COMMAND = "irm https://cdn.autonomous.ai/harness/desktop/install.ps1 | iex";
