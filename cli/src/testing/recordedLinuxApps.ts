/**
 * The Linux packages of the apps whose links and windows the dial opens, as their vendors ship them, for the Linux
 * link opener, the exe names and Cursor's folder window (docs/plans/2026-11-19-dial-linux-plan.md, Task 1; spec § 1.6).
 * Facts only, no binary. Every value is recorded (none copied from documentation).
 *
 * Recorded 2026-11-19 in a disposable `ubuntu:24.04` container under `--platform linux/amd64` (Podman on macOS, the
 * amd64 binaries run through qemu-user), user `u` (uid 1000) on host `box`, in `/work`, nothing signed in. Packages:
 * code 1.147.0-1794903003, cursor 3.30.14-1794552202, claude-desktop 5.11492.5 (the Claude desktop app's Linux beta),
 * chatgpt 26.1111.71704 (the ChatGPT desktop app's Linux preview), each the vendor's own amd64 `.deb`.
 *
 * How each line was made:
 * - `source`: `curl -sSL -w '%{url_effective}'` of the link the vendor's download page or docs name, redirects
 *   followed: VS Code's `update.code.visualstudio.com/latest/linux-deb-x64/stable`; Cursor's
 *   `api2.cursor.sh/updates/download/golden/linux-x64-deb/cursor/3.30` from cursor.com/download (its unversioned
 *   `…/download/stable/linux-x64-deb/cursor` answered 400); the newest `.deb` in the apt repository
 *   code.claude.com/docs/en/desktop-linux names; the `.deb` learn.chatgpt.com/codex/linux/linux-app names.
 * - `sha256`: `sha256sum` of the download. `version`: `dpkg-deb -f <deb> Version`.
 * - `desktopFile`, `exec`, `schemes`, `schemeDesktopFile`, `startupWmClass`: `dpkg-deb -x`, then each `.desktop` file
 *   under `usr/share/applications/` read for its first `Exec=`, its `MimeType=` and `StartupWMClass=`; after
 *   `apt-get install ./<deb>`, `grep -l 'x-scheme-handler/<scheme>;' /usr/share/applications/*.desktop` found the
 *   same file.
 * - `comm`: `xvfb-run -a <Exec= binary> --no-sandbox` as `u` (no setuid sandbox in a container), then
 *   `ps -u u -o pid=,ppid=,comm=,args=` once its children were up: the comm of the process `xvfb-run` started (or that
 *   the launcher script exec'd). Every app came up.
 * - `cliBesideExec`, `pathCommand`: `dpkg-deb -c` for the file and its mode, `dpkg-deb -e` and the `postinst`'s
 *   `ln -s` for what lands on `PATH`, `ls -la /usr/bin/<name>` after the install.
 */

export interface RecordedLinuxApp {
  /** The download URL. */
  readonly source: string
  /** The package's Version field. */
  readonly version: string
  readonly sha256: string
  /** The app's own `.desktop` file name, under `/usr/share/applications/`. */
  readonly desktopFile: string
  /** The value of that file's first `Exec=` line, without the key. */
  readonly exec: string
  /** Each `x-scheme-handler/<scheme>` in `schemeDesktopFile`'s `MimeType=`. */
  readonly schemes: readonly string[]
  /** The `.desktop` file that carries the schemes. */
  readonly schemeDesktopFile: string
  readonly startupWmClass: string | null
  /** The running process's name as `ps -o comm=` prints it, at most 15 characters. */
  readonly comm: string | null
  readonly commFrom: 'process' | 'exec name'
}

export interface RecordedCursorApp extends RecordedLinuxApp {
  /** An executable `bin/cursor` in the folder of the `Exec=` binary. */
  readonly cliBesideExec: string | null
  /** What the package puts on `PATH`. */
  readonly pathCommand: string | null
}

export const RECORDED_LINUX_APPS = {
  vscode: {
    source:
      'https://vscode.download.prss.microsoft.com/dbazure/download/stable/8a14f0cc1b08d531eb83255ea3764ae22aa932b5/code_1.147.0-1794903003_amd64.deb',
    version: '1.147.0-1794903003',
    sha256: '749efcdf5008a8323d76773b836199cdecf708fdb993f0f0544d9475176837ab',
    desktopFile: 'com.microsoft.VSCode.desktop',
    exec: '/usr/share/code/code %F',
    schemes: ['vscode'],
    // Exec=/usr/share/code/code --open-url %U, NoDisplay=true.
    schemeDesktopFile: 'com.microsoft.VSCode.UrlHandler.desktop',
    startupWmClass: 'com.microsoft.VSCode',
    comm: 'code',
    commFrom: 'process',
  },
  cursor: {
    source:
      'https://downloads.cursor.com/production/5f54c8173e5552412beb40702adac16275677fa0/linux/x64/deb/amd64/deb/cursor_3.30.14_amd64.deb',
    version: '3.30.14-1794552202',
    sha256: 'c8003e009f96a6e4fd7185f7016c66d7e36e03d8fa2e2394197511907bcd8226',
    desktopFile: 'cursor.desktop',
    exec: '/usr/share/cursor/cursor %F',
    schemes: ['cursor'],
    // Exec=/usr/share/cursor/cursor --open-url %U, NoDisplay=true.
    schemeDesktopFile: 'cursor-url-handler.desktop',
    startupWmClass: 'Cursor',
    comm: 'cursor',
    commFrom: 'process',
    // -rwxr-xr-x in the package: a sh script (VS Code's CLI launcher) beside code-tunnel and cursor-tunnel.
    cliBesideExec: '/usr/share/cursor/bin/cursor',
    // Not a file of the package: its postinst runs `ln -s /usr/share/cursor/bin/cursor /usr/bin/cursor`.
    pathCommand: '/usr/bin/cursor',
  },
  claude: {
    source:
      'https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_5.11492.5_amd64.deb',
    version: '5.11492.5',
    sha256: 'b96208b207e450b740f7dbe304f6077fed80e7f3d37ddd545991c4e8201564cf',
    desktopFile: 'com.anthropic.Claude.desktop',
    // Not absolute: found on PATH, /usr/bin/claude-desktop -> ../lib/claude-desktop/claude-desktop.
    exec: 'claude-desktop %U',
    // MimeType=x-scheme-handler/claude;application/vnd.anthropic.mcpb;application/vnd.anthropic.skill;
    schemes: ['claude'],
    schemeDesktopFile: 'com.anthropic.Claude.desktop',
    startupWmClass: 'com.anthropic.Claude',
    comm: 'claude-desktop',
    commFrom: 'process',
  },
  chatgpt: {
    source: 'https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb',
    version: '26.1111.71704',
    sha256: '01eef7c77c835f7e1afb92ba1c29178a4c19d6c66573bdd3b86520e2abf806a4',
    desktopFile: 'chatgpt.desktop',
    // Not absolute: found on PATH, /usr/bin/chatgpt -> ../lib/chatgpt/codex-launcher.
    exec: 'chatgpt %U',
    // The file also claims csv, tsv and office file types. http and https make it a browser candidate; codex is the
    // only scheme of its own.
    schemes: ['codex', 'http', 'https'],
    schemeDesktopFile: 'chatgpt.desktop',
    // The file has no StartupWMClass= line.
    startupWmClass: null,
    // codex-launcher is `exec "$(dirname "$(readlink -f "$0")")/ChatGPT" "$@"`, so the app runs as ChatGPT, not as
    // the Exec= name.
    comm: 'ChatGPT',
    commFrom: 'process',
  },
} as const satisfies {
  vscode: RecordedLinuxApp | null
  cursor: RecordedCursorApp | null
  claude: RecordedLinuxApp | null
  chatgpt: RecordedLinuxApp | null
}
