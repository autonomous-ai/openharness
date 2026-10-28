import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureTeamGh, GH_BUILDS, ghRunsAt, unzipArchive, type TeamGhDeps } from './gh.js'

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
    expect(await ensureTeamGh({ ...d, runs: async () => false, platform: 'linux' })).toBe('unsupported')
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
