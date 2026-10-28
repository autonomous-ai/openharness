/**
 * The Harness Team account's own tmux, installed by its own daemon, in its own home.
 *
 * Every agent runs in tmux. Setup gives the team account its owner's managed tmux when the owner has one; otherwise it
 * counted on Homebrew's, at /opt/homebrew or /usr/local. A Homebrew another account cannot read (mode 700/770 on a Mac
 * on 2026-10-27) left the team account with no tmux it could run, and every start there failed with TMUX_UNAVAILABLE,
 * the update its owner's daemon asked for included. So the team daemon, which nobody signs in to or installs for,
 * installs Harness's managed tmux itself when it has none it can run: the same checksum-verified build, in the same
 * place, as `install.sh` puts it for a person (`install_managed_tmux`), which the daemon's tmux lookup already reads
 * (lib/tmuxOnPath.ts `managedTmuxPath`). No password: it writes only its own home.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The managed tmux's manifest, as `install.sh` reads it (`TMUX_METADATA_URL`). */
export const TMUX_MANIFEST_URL = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/runtime/tmux/metadata.json'

export interface TmuxBuild { version: string; url: string; sha256: string; size?: number; archiveRoot: string }

export type TeamTmuxOutcome = 'not-team' | 'present' | 'installed' | 'unsupported' | 'failed'

export interface TeamTmuxDeps {
  /** Whether this daemon is a Mac's Harness Team account. */
  team(): boolean
  platform: NodeJS.Platform
  arch: string
  /** The tmux binaries this daemon would find (managed, on PATH, Homebrew's): any that runs is enough. */
  candidates(): string[]
  runs(binary: string): Promise<boolean>
  manifest(): Promise<unknown>
  /** The archive's bytes, checked against its sha256 (lib/selfUpdate.ts `downloadVerified`). */
  download(build: TmuxBuild): Promise<Buffer>
  /** Unpacks a .tar.gz into a folder. */
  untar(archive: string, into: string): Promise<void>
  /** `~/.harness/runtime` and `~/.local/bin` of this account. */
  runtimeDir: string
  binDir: string
  log(line: string): void
}

/** The manifest's build for this Mac (`install.sh` `manifest_platform`), or null. */
export function tmuxBuildFor(manifest: unknown, platform: NodeJS.Platform, arch: string): TmuxBuild | null {
  if (platform !== 'darwin') return null
  const key = `darwin-${arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : ''}`
  const entry = (manifest as { tmux?: Record<string, unknown> } | null)?.tmux?.[key] as Record<string, unknown> | undefined
  if (!entry) return null
  const { version, url, sha256, archiveRoot, size } = entry
  if (typeof version !== 'string' || typeof url !== 'string' || !url.startsWith('https://') || typeof sha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(sha256) || typeof archiveRoot !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(archiveRoot)) return null
  return { version, url, sha256, archiveRoot, ...(typeof size === 'number' ? { size } : {}) }
}

/** Installs the managed tmux in the team account when it has none it can run. Never throws. */
export async function ensureTeamTmux(deps: TeamTmuxDeps): Promise<TeamTmuxOutcome> {
  try {
    if (!deps.team()) return 'not-team'
    for (const binary of deps.candidates()) if (await deps.runs(binary)) return 'present'
    // No managed tmux is built for Linux: the system's serves every account, and setup refuses without one (NO_TMUX).
    if (deps.platform === 'linux') {
      deps.log('team: no tmux every account can run here: install it (apt install tmux / dnf install tmux)')
      return 'unsupported'
    }
    const build = tmuxBuildFor(await deps.manifest(), deps.platform, deps.arch)
    if (!build) {
      deps.log(`team: no managed tmux is published for ${deps.platform}-${deps.arch}; teammates' agents cannot start here`)
      return 'unsupported'
    }
    const target = join(deps.runtimeDir, build.archiveRoot)
    const binary = join(target, 'bin', 'tmux')
    if (!existsSync(binary)) {
      mkdirSync(deps.runtimeDir, { recursive: true, mode: 0o700 })
      const staging = join(deps.runtimeDir, `.tmux-staging-${process.pid}`)
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true, mode: 0o700 })
      try {
        const archive = join(staging, 'tmux.tar.gz')
        writeFileSync(archive, await deps.download(build), { mode: 0o600 })
        await deps.untar(archive, staging)
        if (!existsSync(join(staging, build.archiveRoot, 'bin', 'tmux'))) throw new Error(`the tmux archive has no ${build.archiveRoot}/bin/tmux`)
        rmSync(target, { recursive: true, force: true })
        renameSync(join(staging, build.archiveRoot), target)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    }
    if (!await deps.runs(binary)) throw new Error(`the managed tmux does not run here: ${binary}`)
    // What the daemon's lookup reads, and the link a shell in this account finds first, as install.sh writes them.
    writeFileSync(join(deps.runtimeDir, 'current-tmux'), `${binary}\n`, { mode: 0o600 })
    mkdirSync(deps.binDir, { recursive: true })
    rmSync(join(deps.binDir, 'tmux'), { force: true })
    symlinkSync(binary, join(deps.binDir, 'tmux'))
    deps.log(`team: installed tmux ${build.version} for the Harness Team account → ${target}`)
    return 'installed'
  } catch (error) {
    deps.log(`team: could not install tmux for the Harness Team account: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
}

/** Whether [binary] runs and says it is tmux. */
export const tmuxRunsAt = (binary: string) => new Promise<boolean>((resolve) => {
  execFile(binary, ['-V'], { timeout: 5_000 }, (error, stdout) => resolve(!error && /^tmux \S+/.test(String(stdout).trim())))
})

/** Unpacks with the system's tar, as install.sh does. */
export const untarGz = (archive: string, into: string) => new Promise<void>((resolve, reject) => {
  execFile('/usr/bin/tar', ['-xzf', archive, '-C', into], { timeout: 60_000 }, (error) => error ? reject(new Error(`could not unpack ${archive}`)) : resolve())
})
