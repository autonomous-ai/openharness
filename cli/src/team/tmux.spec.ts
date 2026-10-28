import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureTeamTmux, systemTar, tmuxBuildFor, untarGz, type TeamTmuxDeps } from './tmux.js'

const SHA = 'a'.repeat(64)
const manifest = { tmux: {
  'darwin-arm64': { version: '3.7c', url: 'https://example.com/tmux-arm64.tar.gz', sha256: SHA, size: 9, archiveRoot: 'tmux-3.7c-darwin-arm64' },
  'darwin-x64': { version: '3.7c', url: 'https://example.com/tmux-x64.tar.gz', sha256: SHA, archiveRoot: 'tmux-3.7c-darwin-x64' },
} }
const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A .tar.gz holding [root]/bin/tmux, made with the system's tar. */
function archive(root: string, withBinary = true): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-archive-'))
  cleanup.push(dir)
  mkdirSync(join(dir, root, 'bin'), { recursive: true })
  if (withBinary) writeFileSync(join(dir, root, 'bin', 'tmux'), '#!/bin/sh\necho tmux 3.7c\n', { mode: 0o755 })
  execFileSync('/usr/bin/tar', ['-czf', join(dir, 'out.tar.gz'), '-C', dir, root])
  return readFileSync(join(dir, 'out.tar.gz'))
}

function deps(over: Partial<TeamTmuxDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'team-tmux-'))
  cleanup.push(home)
  const d: TeamTmuxDeps = {
    team: () => true, platform: 'darwin', arch: 'arm64', candidates: () => ['/opt/homebrew/bin/tmux'],
    runs: vi.fn(async (binary: string) => binary.startsWith(home)), manifest: async () => manifest,
    download: vi.fn(async () => archive('tmux-3.7c-darwin-arm64')), untar: untarGz,
    runtimeDir: join(home, '.harness', 'runtime'), binDir: join(home, '.local', 'bin'), log: vi.fn(), ...over,
  }
  return { d, home }
}

describe('the Harness Team account\'s own tmux', () => {
  it('reads this Mac\'s build from the published manifest, and nothing that is not one', () => {
    expect(tmuxBuildFor(manifest, 'darwin', 'arm64')).toMatchObject({ version: '3.7c', archiveRoot: 'tmux-3.7c-darwin-arm64', size: 9 })
    expect(tmuxBuildFor(manifest, 'darwin', 'x64')).not.toHaveProperty('size')
    for (const [m, platform, arch] of [[manifest, 'linux', 'x64'], [manifest, 'darwin', 'ia32'], [null, 'darwin', 'arm64'],
      [{ tmux: { 'darwin-arm64': { ...manifest.tmux['darwin-arm64'], url: 'http://plain.example/t.tar.gz' } } }, 'darwin', 'arm64'],
      [{ tmux: { 'darwin-arm64': { ...manifest.tmux['darwin-arm64'], sha256: 'nope' } } }, 'darwin', 'arm64'],
      [{ tmux: { 'darwin-arm64': { ...manifest.tmux['darwin-arm64'], archiveRoot: '../escape' } } }, 'darwin', 'arm64'],
    ] as Array<[unknown, NodeJS.Platform, string]>) expect(tmuxBuildFor(m, platform, arch)).toBeNull()
  })

  it('installs the managed build in its own home when it has no tmux it can run, where the daemon looks for it', async () => {
    const { d, home } = deps()
    expect(await ensureTeamTmux(d)).toBe('installed')
    const binary = join(home, '.harness', 'runtime', 'tmux-3.7c-darwin-arm64', 'bin', 'tmux')
    expect(readFileSync(join(home, '.harness', 'runtime', 'current-tmux'), 'utf8')).toBe(`${binary}\n`)
    expect(readlinkSync(join(home, '.local', 'bin', 'tmux'))).toBe(binary)
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('installed tmux 3.7c'))
    // Already there (a tmux link from before replaced): nothing downloaded again.
    expect(await ensureTeamTmux({ ...d, candidates: () => [] })).toBe('installed')
    expect(d.download).toHaveBeenCalledOnce()
    expect(existsSync(join(home, '.harness', 'runtime', `.tmux-staging-${process.pid}`))).toBe(false)
  })

  it('leaves alone an account that is not the team account, or one whose tmux runs', async () => {
    expect(await ensureTeamTmux(deps({ team: () => false }).d)).toBe('not-team')
    const { d } = deps({ runs: async () => true })
    expect(await ensureTeamTmux(d)).toBe('present')
    expect(d.download).not.toHaveBeenCalled()
  })

  it('unpacks with the system\'s tar: /usr/bin/tar, or on Linux without merged /usr (Debian 10 and 11) /bin/tar', () => {
    expect(systemTar('darwin', () => false)).toBe('/usr/bin/tar')
    expect(systemTar('linux', () => true)).toBe('/usr/bin/tar')
    expect(systemTar('linux', (path) => path === '/bin/tar')).toBe('/bin/tar')
  })

  it('on Linux, uses the system\'s tmux and never downloads one', async () => {
    const manifest = vi.fn(async () => { throw new Error('never read') })
    const present = deps({ platform: 'linux', candidates: () => ['/usr/bin/tmux'], runs: vi.fn(async (b: string) => b === '/usr/bin/tmux'), manifest })
    expect(await ensureTeamTmux(present.d)).toBe('present')
    const missing = deps({ platform: 'linux', candidates: () => [], manifest })
    expect(await ensureTeamTmux(missing.d)).toBe('unsupported')
    expect(missing.d.log).toHaveBeenCalledWith('team: no tmux every account can run here: install it (apt install tmux / dnf install tmux)')
    for (const f of [present, missing]) expect(f.d.download).not.toHaveBeenCalled()
    expect(manifest).not.toHaveBeenCalled()
  })

  it('says so when no build is published for this Mac, and fails without throwing', async () => {
    expect(await ensureTeamTmux(deps({ arch: 'ia32' }).d)).toBe('unsupported')
    const noBinary = deps({ download: async () => archive('tmux-3.7c-darwin-arm64', false) })
    expect(await ensureTeamTmux(noBinary.d)).toBe('failed')
    expect(noBinary.d.log).toHaveBeenCalledWith(expect.stringContaining('has no tmux-3.7c-darwin-arm64/bin/tmux'))
    const broken = deps({ untar: async () => { throw new Error('could not unpack') } })
    expect(await ensureTeamTmux(broken.d)).toBe('failed')
    const silent = deps({ runs: async () => false })
    expect(await ensureTeamTmux(silent.d)).toBe('failed')
    expect(silent.d.log).toHaveBeenCalledWith(expect.stringContaining('does not run here'))
    const odd = deps({ manifest: async () => { throw 'offline' } })
    expect(await ensureTeamTmux(odd.d)).toBe('failed')
    expect(odd.d.log).toHaveBeenCalledWith('team: could not install tmux for the Harness Team account: offline')
  })
})
