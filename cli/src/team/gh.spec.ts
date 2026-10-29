import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureTeamGh, GH_BUILDS, ghBuildFor, ghRunsAt, unzipArchive, type TeamGhDeps } from './gh.js'
import { WINDOWS_GH_BUILDS } from './windowsTeam.js'

const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(dir); return dir }

/** A .zip holding [root]/bin/gh, as GitHub's release is laid out, made with the system's ditto. */
function archive(root: string, withBinary = true): Buffer {
  const dir = temp('gh-archive-')
  mkdirSync(join(dir, root, 'bin'), { recursive: true })
  if (withBinary) writeFileSync(join(dir, root, 'bin', 'gh'), '#!/bin/sh\necho gh version 2.103.3 \\(2026-10-26\\)\n', { mode: 0o755 })
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(dir, root), join(dir, 'out.zip')])
  return readFileSync(join(dir, 'out.zip'))
}

function deps(over: Partial<TeamGhDeps> = {}) {
  const home = temp('team-gh-')
  const d: TeamGhDeps = {
    team: () => true, platform: 'darwin', arch: 'arm64', candidates: () => ['/opt/homebrew/bin/gh'],
    runs: vi.fn(async (binary: string) => binary.startsWith(home)),
    download: vi.fn(async () => archive(GH_BUILDS.arm64!.archiveRoot)), unzip: unzipArchive,
    runtimeDir: join(home, '.harness', 'runtime'), binDir: join(home, '.local', 'bin'), log: vi.fn(), ...over,
  }
  return { d, home }
}

describe('the Harness Team account\'s own gh on Linux', () => {
  /** A .tar.gz holding [root]/bin/gh, as GitHub's Linux release is laid out, made with the system's tar. */
  function tarball(root: string): Buffer {
    const dir = temp('gh-tarball-')
    mkdirSync(join(dir, root, 'bin'), { recursive: true })
    writeFileSync(join(dir, root, 'bin', 'gh'), '#!/bin/sh\necho gh version 2.103.3 \\(2026-10-26\\)\n', { mode: 0o755 })
    execFileSync('tar', ['-czf', join(dir, 'out.tar.gz'), '-C', dir, root])
    return readFileSync(join(dir, 'out.tar.gz'))
  }

  it('pins GitHub\'s own Linux builds for x64 and arm64, by checksum and size', () => {
    expect(ghBuildFor('linux', 'x64')).toEqual({ version: '2.103.3', archiveRoot: 'gh_2.103.3_linux_amd64', format: 'tar.gz',
      url: 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz',
      sha256: '4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d', size: 15_031_972 })
    expect(ghBuildFor('linux', 'arm64')).toEqual({ version: '2.103.3', archiveRoot: 'gh_2.103.3_linux_arm64', format: 'tar.gz',
      url: 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_arm64.tar.gz',
      sha256: 'ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63', size: 13_661_485 })
    expect(ghBuildFor('darwin', 'arm64')).toBe(GH_BUILDS.arm64)
    expect(ghBuildFor('linux', 'ia32')).toBeUndefined()
    expect(ghBuildFor('win32', 'x64')).toBe(WINDOWS_GH_BUILDS.x64)
    expect(ghBuildFor('win32', 'ia32')).toBeUndefined()
  })

  it('on Windows, unpacks the zip that has no folder of its own into one, and leaves a gh.cmd on its agents\' PATH', async () => {
    const home = temp('team-gh-')
    const unzip = vi.fn(async (_archive: string, into: string) => {
      mkdirSync(join(into, 'bin'), { recursive: true })
      writeFileSync(join(into, 'bin', 'gh.exe'), 'MZ')
    })
    const d: TeamGhDeps = {
      team: () => true, platform: 'win32', arch: 'x64', candidates: () => [], runs: vi.fn(async (binary: string) => binary.startsWith(home)),
      download: vi.fn(async () => Buffer.from('zip')), unzip, runtimeDir: join(home, 'runtime'), binDir: join(home, 'bin'), log: vi.fn(),
    }
    expect(await ensureTeamGh(d)).toBe('installed')
    const binary = join(home, 'runtime', 'gh_2.103.3_windows_amd64', 'bin', 'gh.exe')
    expect(existsSync(binary)).toBe(true)
    expect(unzip.mock.calls[0]![1]).toBe(join(home, 'runtime', `.gh-staging-${process.pid}`, 'gh_2.103.3_windows_amd64'))
    expect(readFileSync(join(home, 'bin', 'gh.cmd'), 'utf8')).toBe(`@"${binary}" %*\r\n`)
  })

  it('installs the pinned tarball in its own home, unpacked with tar', async () => {
    const home = temp('team-gh-')
    const download = vi.fn(async () => tarball('gh_2.103.3_linux_arm64'))
    const d: TeamGhDeps = {
      team: () => true, platform: 'linux', arch: 'arm64', candidates: () => [], runs: vi.fn(async (binary: string) => binary.startsWith(home)),
      download, unzip: unzipArchive, runtimeDir: join(home, '.harness', 'runtime'), binDir: join(home, '.local', 'bin'), log: vi.fn(),
    }
    expect(await ensureTeamGh(d)).toBe('installed')
    expect(download).toHaveBeenCalledWith(ghBuildFor('linux', 'arm64'))
    expect(readlinkSync(join(home, '.local', 'bin', 'gh'))).toBe(join(home, '.harness', 'runtime', 'gh_2.103.3_linux_arm64', 'bin', 'gh'))
    expect(await ghRunsAt(join(home, '.local', 'bin', 'gh'))).toBe(true)
  })
})

describe.runIf(process.platform === 'darwin')('the Harness Team account\'s own gh', () => {
  it('pins GitHub\'s own macOS builds, by checksum', () => {
    for (const [arch, name] of [['arm64', 'arm64'], ['x64', 'amd64']]) {
      expect(GH_BUILDS[arch]).toMatchObject({ archiveRoot: `gh_2.103.3_macOS_${name}`,
        url: `https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_macOS_${name}.zip`, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    }
  })

  // PR #1934 (2026-10-28): Homebrew's gh behind /opt/homebrew/bin, mode 770, answered "permission denied".
  it('installs gh in its own home when it has none it can run, on its agents\' PATH', async () => {
    const { d, home } = deps()
    expect(await ensureTeamGh(d)).toBe('installed')
    const binary = join(home, '.harness', 'runtime', 'gh_2.103.3_macOS_arm64', 'bin', 'gh')
    expect(readlinkSync(join(home, '.local', 'bin', 'gh'))).toBe(binary)
    expect(await ghRunsAt(join(home, '.local', 'bin', 'gh'))).toBe(true)
    expect(d.download).toHaveBeenCalledWith(GH_BUILDS.arm64)
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('installed gh 2.103.3'))
    // Already there: nothing downloaded again, and no staging left behind.
    expect(await ensureTeamGh({ ...d, candidates: () => [] })).toBe('installed')
    expect(d.download).toHaveBeenCalledOnce()
    expect(existsSync(join(home, '.harness', 'runtime', `.gh-staging-${process.pid}`))).toBe(false)
  })

  it('leaves alone a gh that runs, an account that is not a team account, and a Mac it has no build for', async () => {
    const { d } = deps({ runs: async () => true })
    expect(await ensureTeamGh(d)).toBe('present')
    expect(await ensureTeamGh({ ...d, team: () => false })).toBe('not-team')
    expect(await ensureTeamGh({ ...d, runs: async () => false, arch: 'ia32' })).toBe('unsupported')
    expect(await ensureTeamGh({ ...d, runs: async () => false, platform: 'freebsd' })).toBe('unsupported')
    expect(d.download).not.toHaveBeenCalled()
  })

  it('fails, saying why, on a download that fails, an archive without gh, or a gh that does not run', async () => {
    const failed = deps({ download: async () => { throw new Error('sha256 mismatch') } })
    expect(await ensureTeamGh(failed.d)).toBe('failed')
    expect(failed.d.log).toHaveBeenCalledWith(expect.stringContaining('sha256 mismatch'))
    const empty = deps({ download: async () => archive(GH_BUILDS.arm64!.archiveRoot, false) })
    expect(await ensureTeamGh(empty.d)).toBe('failed')
    expect(empty.d.log).toHaveBeenCalledWith(expect.stringContaining('has no gh_2.103.3_macOS_arm64/bin/gh'))
    const dead = deps({ runs: async () => false })
    expect(await ensureTeamGh(dead.d)).toBe('failed')
    expect(dead.d.log).toHaveBeenCalledWith(expect.stringContaining('does not run here'))
    expect(await ghRunsAt('/nonexistent/gh')).toBe(false)
    await expect(unzipArchive('/nonexistent.zip', temp('gh-into-'))).rejects.toThrow('could not unpack')
  })
})
