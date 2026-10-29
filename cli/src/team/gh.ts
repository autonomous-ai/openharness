/**
 * The Harness Team account's own gh, installed by its own daemon, in its own home.
 *
 * A teammate's agent opens its pull request with gh, signed in as the Harness GitHub App for that session alone
 * (lib/swarmGitHub.ts `GH_CONFIG_DIR`). The team account had only its owner's Homebrew to find gh in, and a Homebrew
 * another account cannot read (/opt/homebrew/bin mode 770 on 2026-10-28) answered "permission denied": the Builder of
 * PR #1934 fell back to GitHub's API by hand. So the team daemon installs gh itself when it has none it can run, as it does
 * tmux (team/tmux.ts): GitHub's own release of it, checked against the checksum pinned here, in its own home. No password.
 *
 * On Linux the same, from GitHub's tarball for the computer's architecture.
 *
 * A newer gh is a new version and checksums here, from the release's `gh_<version>_checksums.txt`.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPowershell } from '../lib/windows/powershell.js'
import { untarGz } from './tmux.js'
import { WINDOWS_GH_BUILDS, windowsUnzipScript } from './windowsTeam.js'

export interface GhBuild { version: string; url: string; sha256: string; size: number; archiveRoot: string; format: 'zip' | 'tar.gz' }

const GH_VERSION = '2.103.3'
const release = (system: 'macOS' | 'linux', arch: string, sha256: string, size: number): GhBuild => {
  const format = system === 'linux' ? 'tar.gz' : 'zip'
  return {
    version: GH_VERSION, sha256, size, archiveRoot: `gh_${GH_VERSION}_${system}_${arch}`, format,
    url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${system}_${arch}.${format}`,
  }
}
/** GitHub's macOS builds of gh, by `process.arch`. */
export const GH_BUILDS: Readonly<Record<string, GhBuild>> = {
  arm64: release('macOS', 'arm64', 'd700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062', 14_106_091),
  x64: release('macOS', 'amd64', 'a2f86418f4350ae6e9ec60d5000bdf7665728436946a97fc27fe50e6ae752682', 15_702_601),
}
/** GitHub's Linux builds of gh, by `process.arch`: tarballs, from the same release's checksums and sizes. */
export const GH_LINUX_BUILDS: Readonly<Record<string, GhBuild>> = {
  arm64: release('linux', 'arm64', 'ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63', 13_661_485),
  x64: release('linux', 'amd64', '4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d', 15_031_972),
}

/** The pinned build for this system, or undefined where none is. */
export function ghBuildFor(platform: NodeJS.Platform, arch: string): GhBuild | undefined {
  const builds: Readonly<Record<string, GhBuild>> | null = platform === 'darwin' ? GH_BUILDS : platform === 'linux' ? GH_LINUX_BUILDS
    : platform === 'win32' ? WINDOWS_GH_BUILDS : null
  return builds && Object.hasOwn(builds, arch) ? builds[arch] : undefined
}

/**
 * Where a build's gh is once unpacked, and what to unpack it into. GitHub's Windows zip holds `bin\gh.exe` at its top with
 * no folder around it (./windowsTeam.ts), so it is unpacked into a folder of that name; the others hold one.
 */
const ghLayout = (build: GhBuild, staging: string) => 'binary' in build
  ? { into: join(staging, build.archiveRoot), binary: join(build.archiveRoot, 'bin', 'gh.exe') }
  : { into: staging, binary: join(build.archiveRoot, 'bin', 'gh') }

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
    const build = ghBuildFor(deps.platform, deps.arch)
    if (!build) {
      deps.log(`team: no gh build is pinned for ${deps.platform}-${deps.arch}; teammates' agents open pull requests through GitHub's API`)
      return 'unsupported'
    }
    const target = join(deps.runtimeDir, build.archiveRoot)
    const layout = ghLayout(build, '')
    const binary = join(deps.runtimeDir, layout.binary)
    if (!existsSync(binary)) {
      mkdirSync(deps.runtimeDir, { recursive: true, mode: 0o700 })
      const staging = join(deps.runtimeDir, `.gh-staging-${process.pid}`)
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true, mode: 0o700 })
      try {
        const archive = join(staging, `gh.${build.format}`)
        writeFileSync(archive, await deps.download(build), { mode: 0o600 })
        await deps.unzip(archive, ghLayout(build, staging).into)
        if (!existsSync(join(staging, layout.binary))) throw new Error(`the gh archive has no ${layout.binary}`)
        rmSync(target, { recursive: true, force: true })
        renameSync(join(staging, build.archiveRoot), target)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    }
    if (!await deps.runs(binary)) throw new Error(`the installed gh does not run here: ${binary}`)
    // On the PATH the team daemon gives its agents, and last on a login shell's: an unreadable Homebrew before it is skipped.
    mkdirSync(deps.binDir, { recursive: true })
    if (deps.platform === 'win32') {
      // A link needs a privilege on Windows: a command file in its place, which cmd.exe and PowerShell find as `gh`.
      writeFileSync(join(deps.binDir, 'gh.cmd'), `@"${binary}" %*\r\n`)
    } else {
      rmSync(join(deps.binDir, 'gh'), { force: true })
      symlinkSync(binary, join(deps.binDir, 'gh'))
    }
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

/** Unpacks a .zip with the system's ditto, which every Mac has, Linux's .tar.gz with the system's tar, and on Windows a .zip
 *  with Windows PowerShell's Expand-Archive. */
export const unzipArchive = (archive: string, into: string, platform: NodeJS.Platform = process.platform): Promise<void> => archive.endsWith('.tar.gz')
  ? untarGz(archive, into)
  : platform === 'win32' ? new Promise<void>((resolve, reject) => {
    const query = windowsUnzipScript(archive, into)
    if (runPowershell(query.script, query.inputs).status === 0) resolve()
    else reject(new Error(`could not unpack ${archive}`))
  })
  : new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', archive, into], { timeout: 60_000 }, (error) => error ? reject(new Error(`could not unpack ${archive}`)) : resolve())
  })
