/**
 * The process that makes the pty of an Orca terminal, per Orca mode, for the own-pane check's table of pty makers
 * (docs/plans/2026-11-21-dial-linux-followups-plan.md, Task 1; spec § 1). Facts only, no binary. Every name is as
 * `ps -o comm=` printed it (Linux cuts it at 15 characters); none is copied from Orca's source.
 *
 * Source read: stablyai/orca at tag v1.4.267 (`sourceCommit`), the newest release on 2026-11-21. What it says:
 * - Orca's terminals live in a daemon, its terminal host, started by the app's main process. On macOS the main process
 *   asks launchd for a signed helper bundle, `Orca Agents.app` with executable `Orca Agents`
 *   (`src/main/daemon/executable-host/macos/macos-daemon-bundle.ts`), copied under the profile's `daemon-host/macos/`.
 *   On Linux the daemon is `daemon-entry.js` run by the app's Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`), or,
 *   from an AppImage, by the Node runtime bundled in the AppImage's unpacked copy under `~/.cache/orca/appimage/`
 *   (`src/main/daemon/executable-host/linux/daemon-appimage-generation-launch.ts`), or by the Electron binary from the
 *   daemon's own FUSE mount when there is no unpacked copy (`daemon-appimage-launch.ts`). Whichever binary runs it,
 *   `daemon-entry.ts` first writes `orca-agents` to `/proc/self/comm` on Linux (`src/main/daemon/daemon-process-name.ts`).
 * - node-pty in the daemon forks the shell, so the shell's parent is the daemon.
 * - In-process fallback: when the daemon cannot start, the main process logs `[daemon] STARTUP FAILED — falling back
 *   to local PTYs` and makes each pty itself (`LocalPtyProvider`, `src/main/startup/pty-startup/main-process-pty-startup.ts`).
 *   On Linux the main process is the Electron binary, `executableName: 'orca-ide'` in `config/electron-builder.config.cjs`.
 *
 * Linux, recorded 2026-11-21 on the Podman machine `devcrew-dlf` (aarch64) in disposable `ubuntu:24.04` containers
 * (image sha256:cd04f18ea6639206fcecf4c148bde909cd08098e1d0569117c2af59242059558, arm64, Ubuntu 24.04.5 LTS), user `u`
 * (uid 1000) on host `box`, repo in `/work`. Packages beside Orca: xvfb 2:21.1.12-1ubuntu1.9, git 1:2.43.0-1ubuntu7.4,
 * procps 2:4.0.4-4ubuntu3.3, bash 5.2.21-2ubuntu4, and for the AppImage fuse3 3.14.0-5build1 and libfuse2t64
 * 2.9.9-8.1build1 (`--device /dev/fuse --cap-add SYS_ADMIN`). Orca's own arm64 builds, so no emulation. Each download's
 * size and sha256 matched the GitHub release's asset digest, and its sha512 matched `latest-linux-arm64.yml`.
 *
 * How each chain was made: the app ran as `u` under `xvfb-run -a <app> --no-sandbox` and came up (no `orca-server`
 * build was needed). Through Orca's own CLI (`/usr/bin/orca-ide` from the `.deb`, `resources/bin/orca-ide` in the
 * AppImage's mount or extraction): `repo add --path /work --json`, `worktree create --repo path:/work --name <rec> --json`,
 * then `terminal create --worktree path:<the new worktree> --title rec --command 'sleep <n>' --json` (each rc 0). From the
 * `sleep` in that terminal (the agent's stand-in), `ps -o pid=,ppid=,tty=,comm= -p <pid>` up its parents to the first
 * process on no tty or another one: that last one is the maker. Pids are the container's.
 *
 * macOS, this Mac, names only: the installed app's version (`plutil -extract CFBundleShortVersionString raw
 * /Applications/Orca.app/Contents/Info.plist`), and `ps -o ppid=,tty=,comm= -p <pid>` from the recorder's agent, which ran
 * in an Orca terminal, up to the maker. Nothing else of this Mac was read; Orca was not restarted.
 */

interface ChainStep {
  readonly pid: number
  readonly ppid: number
  /** `null` where `ps` printed `?`. */
  readonly tty: string | null
  readonly comm: string
}

interface LinuxMode {
  readonly version: string
  /** The download URL. */
  readonly source: string
  readonly sha256: string
  readonly arch: string
  readonly how: string
  /** From the agent's stand-in up to the maker, which is last. */
  readonly chain: readonly ChainStep[]
  readonly makerComm: string
}

export const RECORDED_ORCA = {
  sourceCommit: 'baf9c2c328fa95c0ba9c25fda4836b479162d232',
  macos: {
    version: '1.4.265',
    /** The recorder's agent, its login shell, `login`, then the terminal host (no tty, ppid 1). The home folder is
     *  written as `/Users/u`. */
    chain: [
      { comm: 'claude', tty: 'ttys020' },
      { comm: '-/bin/zsh', tty: 'ttys020' },
      { comm: '/usr/bin/login', tty: 'ttys020' },
      {
        comm:
          '/Users/u/Library/Application Support/orca/daemon-host/macos/terminal-host-c0a1457fc9539503c43f1a19d826c49e898863c1/' +
          'app.noindex/Orca Agents.app/Contents/MacOS/Orca Agents',
        tty: null,
      },
    ],
  },
  linux: {
    deb: {
      version: '1.4.267',
      source: 'https://github.com/stablyai/orca/releases/download/v1.4.267/orca-ide_1.4.267_arm64.deb',
      sha256: '4cb4974ad6794905c76aa37e1a8d152af977a1661d251a6a29558bb6d4d4f160',
      arch: 'arm64',
      how:
        '`apt-get install ./orca-ide_1.4.267_arm64.deb` (it puts the app in /opt/Orca and links /usr/bin/orca-ide), then ' +
        '`xvfb-run -a /opt/Orca/orca-ide --no-sandbox`. The daemon is /opt/Orca/orca-ide run as Node, a child of the ' +
        'main process (comm `orca-ide`).',
      chain: [
        { pid: 4273, ppid: 4263, tty: 'pts/2', comm: 'sleep' },
        { pid: 4263, ppid: 3926, tty: 'pts/2', comm: 'bash' },
        { pid: 3926, ppid: 3816, tty: null, comm: 'orca-agents' },
      ],
      makerComm: 'orca-agents',
    },
    appimage: {
      version: '1.4.267',
      source: 'https://github.com/stablyai/orca/releases/download/v1.4.267/orca-linux-arm64.AppImage',
      sha256: '8a8a3e6857cdbc35e8d91beec4c7af813e403f3506e42b681f833d0504bb6fe8',
      arch: 'arm64',
      how:
        'FUSE present: `xvfb-run -a /home/u/orca-linux-arm64.AppImage --no-sandbox`, mounted at /tmp/.mount_orca-…. The ' +
        'app logged `[appimage-copy] Unpacked this AppImage in 6s` into ~/.cache/orca/appimage and started the daemon ' +
        'with the Node runtime bundled there (`/proc/<daemon>/exe` was `…/resources/node-runtime/bin/node`); its comm ' +
        'reads `orca-agents` only because Orca renames it.',
      chain: [
        { pid: 3929, ppid: 3919, tty: 'pts/2', comm: 'sleep' },
        { pid: 3919, ppid: 3711, tty: 'pts/2', comm: 'bash' },
        { pid: 3711, ppid: 3521, tty: null, comm: 'orca-agents' },
      ],
      makerComm: 'orca-agents',
    },
    inProcess: {
      version: '1.4.267',
      source: 'https://github.com/stablyai/orca/releases/download/v1.4.267/orca-ide_1.4.267_arm64.deb',
      sha256: '4cb4974ad6794905c76aa37e1a8d152af977a1661d251a6a29558bb6d4d4f160',
      arch: 'arm64',
      how:
        'The `.deb` install, a fresh profile with a plain file at ~/.config/orca/daemon (where the daemon\'s runtime ' +
        'folder goes), then `xvfb-run -a /opt/Orca/orca-ide --no-sandbox`. The app logged `[daemon] STARTUP FAILED — ' +
        'falling back to local PTYs; terminals will not persist across quit. Reason: EEXIST: file already exists, mkdir ' +
        '\'/home/u/.config/orca/daemon\'` and no `orca-agents` ran. The maker is the main process, /opt/Orca/orca-ide ' +
        '(the AppImage\'s main process prints the same comm, `orca-ide`, from its mount).',
      chain: [
        { pid: 4708, ppid: 4698, tty: 'pts/2', comm: 'sleep' },
        { pid: 4698, ppid: 4354, tty: 'pts/2', comm: 'bash' },
        { pid: 4354, ppid: 4341, tty: null, comm: 'orca-ide' },
      ],
      makerComm: 'orca-ide',
    },
  },
  /** The AppImage's two other daemon launches the source has, recorded the same way in the same container. */
  appimageOtherLaunches: [
    {
      how:
        '`--appimage-extract-and-run` (no mount; the app ran from /tmp/appimage_extracted_…): it still unpacked its copy ' +
        'into ~/.cache/orca/appimage and ran the daemon on the bundled Node there.',
      chain: [
        { pid: 4344, ppid: 4334, tty: 'pts/2', comm: 'sleep' },
        { pid: 4334, ppid: 4147, tty: 'pts/2', comm: 'bash' },
        { pid: 4147, ppid: 3989, tty: null, comm: 'orca-agents' },
      ],
    },
    {
      how:
        'FUSE present, a plain file at ~/.cache/orca/appimage: the app logged `[appimage-copy] Not unpacking this ' +
        'AppImage: /home/u/.cache/orca/appimage is not usable (EEXIST)` and `[daemon] AppImage daemon host fallback ' +
        'reason=no-extracted-copy: starting it on Electron, from its own mount`; `/proc/<daemon>/exe` was ' +
        '/tmp/.mount_orca-…/orca-ide.',
      chain: [
        { pid: 4768, ppid: 4758, tty: 'pts/2', comm: 'sleep' },
        { pid: 4758, ppid: 4515, tty: 'pts/2', comm: 'bash' },
        { pid: 4515, ppid: 4403, tty: null, comm: 'orca-agents' },
      ],
    },
  ],
  notCovered: [
    {
      mode: 'macOS daemon forked from the app (launchd helper not eligible or failed)',
      why:
        'The source falls back to forking the main executable when the `Orca Agents` helper cannot start; triggering it ' +
        'would restart this Mac\'s Orca and its terminals.',
    },
    {
      mode: 'macOS in-process fallback',
      why: 'Triggering a daemon start failure would restart this Mac\'s Orca and its terminals.',
    },
    {
      mode: 'Linux daemon whose /proc/self/comm write fails',
      why:
        'Orca ignores the failure (read-only procfs), leaving the binary\'s own name: `node` for the AppImage\'s bundled ' +
        'runtime, a generic name that must never be a maker row. Not triggerable without changing the container\'s procfs.',
    },
    {
      mode: 'Linux .rpm',
      why: 'Same build and executable name as the .deb (`orca-ide`); not installed, no Fedora image in this recording.',
    },
  ],
} as const satisfies {
  readonly sourceCommit: string
  readonly macos: { readonly version: string; readonly chain: ReadonlyArray<{ readonly comm: string; readonly tty: string | null }> }
  readonly linux: Readonly<Partial<Record<'deb' | 'appimage' | 'inProcess', LinuxMode>>>
  readonly appimageOtherLaunches: ReadonlyArray<{ readonly how: string; readonly chain: readonly ChainStep[] }>
  readonly notCovered: ReadonlyArray<{ readonly mode: string; readonly why: string }>
}
