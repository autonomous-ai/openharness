/**
 * The Harness Team account's own gh, installed by its own daemon, in its own home.
 *
 * A teammate's agent opens its pull request with gh, signed in as the Harness GitHub App for that session alone
 * (lib/swarmGitHub.ts `GH_CONFIG_DIR`). The team account had only its owner's Homebrew to find gh in, and a Homebrew
 * another account cannot read (/opt/homebrew/bin mode 770 on 2026-10-28) answered "permission denied": the Builder of
 * PR #1934 fell back to GitHub's API by hand. So the team daemon installs gh itself when it has none it can run, as it does
 * tmux (team/tmux.ts): GitHub's own release of it, checked against the checksum pinned here, in its own home. No password.
 *
 * A newer gh is a new version and checksums here, from the release's `gh_<version>_checksums.txt`.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface GhBuild { version: string; url: string; sha256: string; size: number; archiveRoot: string }

const GH_VERSION = '2.103.3'
const release = (arch: string, sha256: string, size: number): GhBuild => ({
  version: GH_VERSION, sha256, size, archiveRoot: `gh_${GH_VERSION}_macOS_${arch}`,
  url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_macOS_${arch}.zip`,
})
/** GitHub's macOS builds of gh, by `process.arch`. */
export const GH_BUILDS: Readonly<Record<string, GhBuild>> = {
  arm64: release('arm64', 'd700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062', 14_106_091),
  x64: release('amd64', 'a2f86418f4350ae6e9ec60d5000bdf7665728436946a97fc27fe50e6ae752682', 15_702_601),
}

export type TeamGhOutcome = 'not-team' | 'present' | 'installed' | 'unsupported' | 'failed'

export interface TeamGhDeps {
  /** Whether this daemon is a Mac's Harness Team account. */
  team(): boolean
  platform: NodeJS.Platform
  arch: string
  /** The gh binaries an agent here would find (its own, on PATH, Homebrew's): any that runs is enough. */
  candidates(): string[]
  runs(binary: string): Promise<boolean>
  /** The archive's bytes, checked against its sha256 (lib/selfUpdate.ts `downloadVerified`). */
  download(build: GhBuild): Promise<Buffer>
  /** Unpacks a .zip into a folder. */
  unzip(archive: string, into: string): Promise<void>
  /** `~/.harness/runtime` and `~/.local/bin` of this account. */
  runtimeDir: string
  binDir: string
  log(line: string): void
}

/** Installs gh in the team account when it has none it can run. Never throws. */
export async function ensureTeamGh(deps: TeamGhDeps): Promise<TeamGhOutcome> {
  try {
    if (!deps.team()) return 'not-team'
    for (const binary of deps.candidates()) if (await deps.runs(binary)) return 'present'
    const build = deps.platform === 'darwin' ? GH_BUILDS[deps.arch] : undefined
    if (!build) {
      deps.log(`team: no gh build is pinned for ${deps.platform}-${deps.arch}; teammates' agents open pull requests through GitHub's API`)
      return 'unsupported'
    }
    const target = join(deps.runtimeDir, build.archiveRoot)
    const binary = join(target, 'bin', 'gh')
    if (!existsSync(binary)) {
      mkdirSync(deps.runtimeDir, { recursive: true, mode: 0o700 })
      const staging = join(deps.runtimeDir, `.gh-staging-${process.pid}`)
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true, mode: 0o700 })
      try {
        const archive = join(staging, 'gh.zip')
        writeFileSync(archive, await deps.download(build), { mode: 0o600 })
        await deps.unzip(archive, staging)
        if (!existsSync(join(staging, build.archiveRoot, 'bin', 'gh'))) throw new Error(`the gh archive has no ${build.archiveRoot}/bin/gh`)
        rmSync(target, { recursive: true, force: true })
        renameSync(join(staging, build.archiveRoot), target)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    }
    if (!await deps.runs(binary)) throw new Error(`the installed gh does not run here: ${binary}`)
    // On the PATH the team daemon gives its agents, and last on a login shell's: an unreadable Homebrew before it is skipped.
    mkdirSync(deps.binDir, { recursive: true })
    rmSync(join(deps.binDir, 'gh'), { force: true })
    symlinkSync(binary, join(deps.binDir, 'gh'))
    deps.log(`team: installed gh ${build.version} for the Harness Team account → ${target}`)
    return 'installed'
  } catch (error) {
    deps.log(`team: could not install gh for the Harness Team account: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
}

/** Whether [binary] runs and says it is gh. */
export const ghRunsAt = (binary: string) => new Promise<boolean>((resolve) => {
  execFile(binary, ['--version'], { timeout: 5_000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } },
    (error, stdout) => resolve(!error && /^gh version \S+/.test(String(stdout).trim())))
})

/** Unpacks with the system's ditto, which every Mac has. */
export const unzipArchive = (archive: string, into: string) => new Promise<void>((resolve, reject) => {
  execFile('/usr/bin/ditto', ['-x', '-k', archive, into], { timeout: 60_000 }, (error) => error ? reject(new Error(`could not unpack ${archive}`)) : resolve())
})
