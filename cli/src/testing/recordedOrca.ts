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
     *  written as `/Users/u` and the host folder's hash as `<hash>`. */
    chain: [
      { comm: 'claude', tty: 'ttys020' },
      { comm: '-/bin/zsh', tty: 'ttys020' },
      { comm: '/usr/bin/login', tty: 'ttys020' },
      {
        comm:
          '/Users/u/Library/Application Support/orca/daemon-host/macos/terminal-host-<hash>/' +
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

/** A row of `orca agent list --json`: a chat's, or a terminal agent's. */
interface OrcaAgentRow {
  readonly orcaSessionId: string
  readonly kind: string
  readonly agent: string
  readonly state: string
  readonly worktreeId: string
  readonly workspace: string
  readonly repo: string
  readonly hostId: string
  readonly paneKey: string
  readonly title: string
  readonly lastAssistantMessage: string
  readonly updatedAt: number
}

/** A row of `orca worktree list --json`, cut to what the devices read: a worktree with no identity prints none. */
interface OrcaWorktreeRow {
  readonly id: string
  readonly identity?: { readonly key: string }
}

/** The envelope of every `--json` answer of Orca's CLI, around its result. */
interface OrcaAnswer<Result> {
  readonly id: string
  readonly ok: true
  readonly result: Result & { readonly hostScope: { readonly hostIds: readonly string[]; readonly omittedHostIds: readonly string[] } }
  readonly _meta: { readonly runtimeId: string }
}

/**
 * Orca's own answers to `orca agent list --json` and `orca worktree list --json`, recorded on Tony's Mac with Orca 1.4.271
 * on 2026-11-23 (docs/plans/2026-11-23-dial-orca-chats-design.md, Task 0): 17 chats, 16 of Claude and 1 of Codex, across
 * six worktrees, and 14 worktrees, 2 of them with no identity, which hold 6 of the chats. Their shape, order, states,
 * times, id lengths and the way each chat's `worktreeId` names a worktree's `id` are Orca's. Every value that named
 * something of Tony's was replaced: the ids are made-up UUIDs of the same form (a chat's `chat-` prefix kept), the
 * folders `/Users/someone/work/repo-<n>/wt-<n>`, the workspaces and repos their names, the titles `Chat <n>` and the
 * previews `Answer <n>.`. Each worktree keeps only its `id` and `identity.key`, the two the devices read, of the 40-odd
 * keys Orca prints (its branch and name among them).
 */
export const RECORDED_ORCA_AGENTS = {
  id: 'req-1',
  ok: true,
  result: {
    agents: [
      {
        orcaSessionId: '07e187d9-544c-541d-955a-ff2ba013c46a', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: 'f86dd618-4f2d-5977-bdb8-d719541298e7::/Users/someone/work/repo-3/wt-5',
        workspace: 'wt-5', repo: 'repo-3', hostId: 'local', paneKey: '718402f9-816c-521e-848d-8f3d8861accc',
        title: 'Chat 1', lastAssistantMessage: 'Answer 1.', updatedAt: 1795420217738,
      },
      {
        orcaSessionId: '718d6d62-2989-5bc1-b2d2-d1cee8180cd0', kind: 'chat', agent: 'codex', state: 'done',
        worktreeId: 'f86dd618-4f2d-5977-bdb8-d719541298e7::/Users/someone/work/repo-3/wt-5',
        workspace: 'wt-5', repo: 'repo-3', hostId: 'local', paneKey: '77586277-13cd-5319-8826-d74718c05703',
        title: 'Chat 2', lastAssistantMessage: 'Answer 2.', updatedAt: 1795420313124,
      },
      {
        orcaSessionId: 'd272abef-866b-536f-ae16-ef74afcd0191', kind: 'chat', agent: 'claude', state: 'working',
        worktreeId: 'f86dd618-4f2d-5977-bdb8-d719541298e7::/Users/someone/work/repo-3/wt-5',
        workspace: 'wt-5', repo: 'repo-3', hostId: 'local', paneKey: 'ddd9d48f-43b4-51dc-8ca9-f44e67ccd263',
        title: 'Chat 3', lastAssistantMessage: 'Answer 3.', updatedAt: 1795424154572,
      },
      {
        orcaSessionId: '1b7efe64-d1f0-56a8-b6d7-8f610dd18ae5', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: 'f86dd618-4f2d-5977-bdb8-d719541298e7::/Users/someone/work/repo-3/wt-6',
        workspace: 'wt-6', repo: 'repo-3', hostId: 'local', paneKey: '0da43288-ca76-5adb-b4fe-837d4b700a15',
        title: 'Chat 4', lastAssistantMessage: 'Answer 4.', updatedAt: 1795167045851,
      },
      {
        orcaSessionId: 'chat-93f09923-26e0-5c90-8505-b50171eb8d8b', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: 'f86dd618-4f2d-5977-bdb8-d719541298e7::/Users/someone/work/repo-3/wt-6',
        workspace: 'wt-6', repo: 'repo-3', hostId: 'local', paneKey: '85294c9e-e33d-5e5a-b154-82775b095579',
        title: 'Chat 5', lastAssistantMessage: 'Answer 5.', updatedAt: 1795167240841,
      },
      {
        orcaSessionId: 'chat-bc060030-651b-57ff-a0a1-16cf3a73a7fa', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: '59a2e1dd-ee75-5df4-be5f-33b7cd011dab::/Users/someone/work/repo-4/wt-7',
        workspace: 'wt-7', repo: 'repo-4', hostId: 'local', paneKey: '6e55220a-7c7a-5b84-b9e8-f92906c44cd2',
        title: 'Chat 6', lastAssistantMessage: 'Answer 6.', updatedAt: 1795121749701,
      },
      {
        orcaSessionId: 'chat-8f0c05bb-ba3a-5ea6-a096-5f530d60d083', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: '59a2e1dd-ee75-5df4-be5f-33b7cd011dab::/Users/someone/work/repo-4/wt-7',
        workspace: 'wt-7', repo: 'repo-4', hostId: 'local', paneKey: 'da2ecbce-8f01-5ec7-83e9-3c8ee4e6cfa7',
        title: 'Chat 7', lastAssistantMessage: 'Answer 7.', updatedAt: 1795283388680,
      },
      {
        orcaSessionId: '699a0183-e42e-5ba5-9fab-ff226bb4f7f3', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: '59a2e1dd-ee75-5df4-be5f-33b7cd011dab::/Users/someone/work/repo-4/wt-7',
        workspace: 'wt-7', repo: 'repo-4', hostId: 'local', paneKey: '445f991a-e58e-518d-9440-79a456cc1001',
        title: 'Chat 8', lastAssistantMessage: 'Answer 8.', updatedAt: 1795411088509,
      },
      {
        orcaSessionId: '40e81743-b0f1-507d-a303-bf5fe5ef9e3a', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: '59a2e1dd-ee75-5df4-be5f-33b7cd011dab::/Users/someone/work/repo-4/wt-7',
        workspace: 'wt-7', repo: 'repo-4', hostId: 'local', paneKey: '54d50a8d-e7d4-5d93-9584-be07639c6185',
        title: 'Chat 9', lastAssistantMessage: 'Answer 9.', updatedAt: 1795416922380,
      },
      {
        orcaSessionId: 'chat-18bbc1fc-82ec-5e8b-964f-d8a868a8a6c2', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: '59a2e1dd-ee75-5df4-be5f-33b7cd011dab::/Users/someone/work/repo-4/wt-7',
        workspace: 'wt-7', repo: 'repo-4', hostId: 'local', paneKey: '0854116b-9557-53cc-9dea-28889b783236',
        title: 'Chat 10', lastAssistantMessage: 'Answer 10.', updatedAt: 1795423823686,
      },
      {
        orcaSessionId: 'db2f8b7d-169c-5562-8796-579d48be3a59', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: 'b25b3dd6-8aca-5e52-814f-859d9af261a7::/Users/someone/work/repo-11/wt-14',
        workspace: 'wt-14', repo: 'repo-11', hostId: 'local', paneKey: '0640ddf1-9cc4-55d1-b30b-624c19e99683',
        title: 'Chat 11', lastAssistantMessage: 'Answer 11.', updatedAt: 1795164484293,
      },
      {
        orcaSessionId: 'a69a2e0e-e1ba-5f6c-a713-62826ad6f47b', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: 'f86dd618-4f2d-5977-bdb8-d719541298e7::/Users/someone/work/repo-3/wt-4',
        workspace: 'wt-4', repo: 'repo-3', hostId: 'local', paneKey: '9268d4e6-f48b-53ad-8d76-e63af60fff9e',
        title: 'Chat 12', lastAssistantMessage: 'Answer 12.', updatedAt: 1795167253064,
      },
      {
        orcaSessionId: '9ad85d06-e25e-5765-a967-81f79c350666', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: '2e8b52b4-d635-5c6a-8b8b-d6f80bd0655d::/Users/someone/work/repo-5/wt-8',
        workspace: 'wt-8', repo: 'repo-5', hostId: 'local', paneKey: '71087cbd-4e6c-5c82-bdb1-d112b5be36a5',
        title: 'Chat 13', lastAssistantMessage: 'Answer 13.', updatedAt: 1795147670476,
      },
      {
        orcaSessionId: 'aa98cc13-66ea-573a-af97-22f8c4a22d4d', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: '2e8b52b4-d635-5c6a-8b8b-d6f80bd0655d::/Users/someone/work/repo-5/wt-8',
        workspace: 'wt-8', repo: 'repo-5', hostId: 'local', paneKey: 'cf8f2e5b-470c-5fcd-b82e-2083753bb346',
        title: 'Chat 14', lastAssistantMessage: 'Answer 14.', updatedAt: 1795405322834,
      },
      {
        orcaSessionId: 'dcfad44f-1537-539e-86ed-3f4125be2480', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: '2e8b52b4-d635-5c6a-8b8b-d6f80bd0655d::/Users/someone/work/repo-5/wt-8',
        workspace: 'wt-8', repo: 'repo-5', hostId: 'local', paneKey: '04ff22de-b653-52d6-b132-9540b91d0c9e',
        title: 'Chat 15', lastAssistantMessage: 'Answer 15.', updatedAt: 1795406138529,
      },
      {
        orcaSessionId: 'bff0a6d4-f855-5755-8921-c16326f500be', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: '2e8b52b4-d635-5c6a-8b8b-d6f80bd0655d::/Users/someone/work/repo-5/wt-8',
        workspace: 'wt-8', repo: 'repo-5', hostId: 'local', paneKey: '9621f653-42af-5370-897f-b696432dbf9b',
        title: 'Chat 16', lastAssistantMessage: 'Answer 16.', updatedAt: 1795408821084,
      },
      {
        orcaSessionId: 'chat-5fec7a57-b4bd-505f-9e92-645de48e5dcf', kind: 'chat', agent: 'claude', state: 'done',
        worktreeId: '2e8b52b4-d635-5c6a-8b8b-d6f80bd0655d::/Users/someone/work/repo-5/wt-8',
        workspace: 'wt-8', repo: 'repo-5', hostId: 'local', paneKey: '15700364-270b-5924-ab0e-61d6f24872b1',
        title: 'Chat 17', lastAssistantMessage: 'Answer 17.', updatedAt: 1795419198131,
      },
    ],
    truncated: false,
    hostScope: { hostIds: ['local'], omittedHostIds: [] },
  },
  _meta: { runtimeId: 'x' },
} as const satisfies OrcaAnswer<{ readonly agents: readonly OrcaAgentRow[]; readonly truncated: boolean }>

/** The worktrees of the same recording (RECORDED_ORCA_AGENTS says what was replaced). */
export const RECORDED_ORCA_WORKTREES = {
  id: 'req-1',
  ok: true,
  result: {
    worktrees: [
      { id: '0ef0b99a-0f5a-5a82-92e0-c9b289abeaf6::/Users/someone/work/repo-1/wt-1',
        identity: { key: 'wt2:local:8dd635e7-9277-5ccc-a3a9-ea238f767410' } },
      { id: 'a8119454-2a0b-5799-9340-cdff4ee7f678::/Users/someone/work/repo-2/wt-2',
        identity: { key: 'wt2:local:af52cc39-bb83-5003-a7bd-1ca24a3f8656' } },
      { id: 'a8119454-2a0b-5799-9340-cdff4ee7f678::/Users/someone/work/repo-2/wt-3',
        identity: { key: 'wt2:local:a8b35481-2677-59e1-aa3f-b49a94d270d0' } },
      { id: 'f86dd618-4f2d-5977-bdb8-d719541298e7::/Users/someone/work/repo-3/wt-4',
        identity: { key: 'wt2:local:46489b9e-c271-5a10-936d-267717d70fda' } },
      { id: 'f86dd618-4f2d-5977-bdb8-d719541298e7::/Users/someone/work/repo-3/wt-5',
        identity: { key: 'wt2:local:9b775eec-7d94-569e-b3d7-3df34efce23e' } },
      { id: 'f86dd618-4f2d-5977-bdb8-d719541298e7::/Users/someone/work/repo-3/wt-6',
        identity: { key: 'wt2:local:93475f8e-9894-5b54-9410-5dad6db225ea' } },
      { id: '59a2e1dd-ee75-5df4-be5f-33b7cd011dab::/Users/someone/work/repo-4/wt-7',
        identity: { key: 'wt2:local:9276df18-e372-5075-bddc-e4075d2389f4' } },
      { id: '2e8b52b4-d635-5c6a-8b8b-d6f80bd0655d::/Users/someone/work/repo-5/wt-8' },
      { id: 'f2a9a5fa-fd47-5174-a416-bdef73044d8d::/Users/someone/work/repo-6/wt-9',
        identity: { key: 'wt2:local:5addc9ff-bd61-5114-9f1a-c911b685a0f4' } },
      { id: '7ebf5bed-b35d-50d1-90b7-723f959013fe::/Users/someone/work/repo-7/wt-10',
        identity: { key: 'wt2:local:007a3de3-8b5b-5893-b99d-add4db0f26f9' } },
      { id: 'ff84c5ba-f6ae-5e50-90d5-efccb4a5d855::/Users/someone/work/repo-8/wt-11',
        identity: { key: 'wt2:local:ae9b925c-907a-5595-9f7b-6f9a9ff6710a' } },
      { id: 'b59a031d-c382-5561-9200-a53978a00e02::/Users/someone/work/repo-9/wt-12',
        identity: { key: 'wt2:local:5daef1d3-2e9a-50c7-898e-f6fb28d94c0a' } },
      { id: 'e9368050-6933-5325-baf0-e03dc5f85c42::/Users/someone/work/repo-10/wt-13',
        identity: { key: 'wt2:local:3fd4543d-4340-5ba4-88cc-1c970218e19c' } },
      { id: 'b25b3dd6-8aca-5e52-814f-859d9af261a7::/Users/someone/work/repo-11/wt-14' },
    ],
    hostScope: { hostIds: ['local'], omittedHostIds: [] },
    totalCount: 14,
    truncated: false,
  },
  _meta: { runtimeId: 'x' },
} as const satisfies OrcaAnswer<{
  readonly worktrees: readonly OrcaWorktreeRow[]
  readonly totalCount: number
  readonly truncated: boolean
}>
