import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => vi.fn())
// Native version output is a fixture. Never execute a developer's real hn or an unknown command.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...actual, execFile: Object.assign(() => {}, { [promisify.custom]: probe }) }
})

let home: string
let bin: string
let cli: string
let hn: string
let api: typeof import('./launcher.js')
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const managed = () => `#!/bin/sh\nexec ${quote(join(bin, 'harness'))} tui "$@"\n`

function developmentLink(relativeLink = false, dangling = false): string {
  const project = join(home, 'checkout', 'tui')
  const target = join(project, 'target', 'hn-test', 'hn')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "harness-tui"\n')
  if (!dangling) writeFileSync(target, 'old development build', { mode: 0o755 })
  symlinkSync(relativeLink ? relative(bin, target) : target, hn)
  return target
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "hn-launcher-'quoted-"))
  bin = join(home, '.local', 'bin')
  cli = join(home, '.harness', 'cli', 'cli.js')
  hn = join(bin, 'hn')
  mkdirSync(bin, { recursive: true })
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(cli, '// installed bundle')
  writeFileSync(join(bin, 'harness'), `#!/bin/sh\nexec node ${quote(cli)} "$@"\n`, { mode: 0o755 })
  vi.stubEnv('HOME', home)
  vi.stubEnv('HARNESS_BIN_DIR', bin)
  vi.stubEnv('ADAPTER_CLI_DIR', dirname(cli))
  vi.stubEnv('HARNESS_TUI_BIN', undefined)
  vi.stubEnv('PATH', bin)
  probe.mockReset().mockResolvedValue({ stdout: 'hn 0.1.0 (tmux 3.5a)\n', stderr: '' })
  vi.resetModules()
  api = await import('./launcher.js')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('hn launcher migration', () => {
  it('creates a missing launcher only for the installed CLI', async () => {
    const source = join(home, 'source.js')
    writeFileSync(source, '// development bundle')
    await api.repairHnLauncher(source, vi.fn())
    expect((await api.inspectHnLauncher()).kind).toBe('missing')
    await api.repairHnLauncher(cli, vi.fn())
    expect(readFileSync(hn, 'utf8')).toBe(managed())
    expect(lstatSync(hn).mode & 0o777).toBe(0o755)
  })

  it.each(['managed', 'old installer', 'unquoted repair', 'binary symlink'])('recognizes the %s launcher without probing it', async kind => {
    if (kind === 'managed') writeFileSync(hn, managed())
    if (kind === 'old installer') writeFileSync(hn, `#!/bin/sh\nexec '/old/node' ${quote(cli)} tui "$@"\n`)
    if (kind === 'unquoted repair') writeFileSync(hn, `#!/bin/sh\nexec ${join(bin, 'harness')} tui "$@"\n`)
    if (kind === 'binary symlink') symlinkSync(join(home, '.harness', 'bin', 'harness-tui'), hn)
    expect((await api.inspectHnLauncher()).kind).toBe('managed')
    await api.repairHnLauncher(cli, vi.fn())
    expect(probe).not.toHaveBeenCalled()
    expect(readdirSync(bin).sort()).toEqual(['harness', 'hn'])
  })

  it.each([[false, false], [true, false], [true, true]])('backs up development links (relative=%s, dangling=%s) without changing their target', async (relativeLink, dangling) => {
    const target = developmentLink(relativeLink, dangling)
    expect((await api.inspectHnLauncher()).kind).toBe('legacy')
    const log = vi.fn()
    await api.repairHnLauncher(cli, log)
    expect(readFileSync(hn, 'utf8')).toBe(managed())
    expect(lstatSync(hn).isSymbolicLink()).toBe(false)
    const backups = readdirSync(bin).filter(s => s.startsWith('.hn-backup-'))
    expect(backups).toHaveLength(1)
    const backup = join(bin, backups[0], 'hn')
    expect(readlinkSync(backup)).toBe(target)
    if (!dangling) {
      expect(readFileSync(backup, 'utf8')).toBe('old development build')
      expect(readFileSync(target, 'utf8')).toBe('old development build')
    }
    expect(readdirSync(dirname(backup))).toEqual(['hn'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('hn now follows automatic updates'))
    await api.repairHnLauncher(cli, log)
    expect(readdirSync(bin).filter(s => s.startsWith('.hn-backup-'))).toEqual(backups)
  })

  it('migrates a copied native hn with a verified version response', async () => {
    const bytes = Buffer.from('7f454c466c6567616379', 'hex')
    writeFileSync(hn, bytes, { mode: 0o755 })
    await api.repairHnLauncher(cli, vi.fn())
    expect(probe).toHaveBeenCalledWith(hn, ['--version'], expect.objectContaining({ timeout: 3000 }))
    expect(readFileSync(hn, 'utf8')).toBe(managed())
    const backup = readdirSync(bin).find(s => s.startsWith('.hn-backup-'))!
    expect(readFileSync(join(bin, backup, 'hn'))).toEqual(bytes)
    expect(lstatSync(join(bin, backup, 'hn')).mode & 0o777).toBe(0o755)
  })

  it.each(['shell', 'dangling symlink', 'unrelated native', 'broken native'])('preserves an unrelated %s command', async kind => {
    const bytes = kind.includes('native') ? Buffer.from('7f454c466f74686572', 'hex') : Buffer.from('#!/bin/sh\necho .harness\n')
    if (kind === 'dangling symlink') symlinkSync(join(home, 'missing'), hn)
    else writeFileSync(hn, bytes, { mode: 0o755 })
    if (kind === 'unrelated native') probe.mockResolvedValue({ stdout: 'Hacker News 1.0\n' })
    if (kind === 'broken native') probe.mockRejectedValue(new Error('broken'))
    const log = vi.fn()
    await api.repairHnLauncher(cli, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('another or unrecognized command'))
    if (kind === 'dangling symlink') expect(readlinkSync(hn)).toBe(join(home, 'missing'))
    else expect(readFileSync(hn)).toEqual(bytes)
    if (!kind.includes('native')) expect(probe).not.toHaveBeenCalled()
    expect(readdirSync(bin).sort()).toEqual(['harness', 'hn'])
  })

  it('leaves a command changed during its version probe alone', async () => {
    writeFileSync(hn, Buffer.from('7f454c46', 'hex'))
    probe.mockImplementation(async () => {
      writeFileSync(hn, 'replacement command')
      return { stdout: 'hn 0.1.0 (tmux 3.5a)' }
    })
    await expect(api.repairHnLauncher(cli, vi.fn())).rejects.toThrow('changed during installation')
    expect(readFileSync(hn, 'utf8')).toBe('replacement command')
  })

  it('does not redirect hn through an unmanaged harness command', async () => {
    const target = developmentLink()
    writeFileSync(join(bin, 'harness'), '#!/bin/sh\necho something else\n')
    await expect(api.repairHnLauncher(cli, vi.fn())).rejects.toThrow('not managed')
    expect(readlinkSync(hn)).toBe(target)
  })

  it('explains legacy installs, explicit overrides and PATH shadowing', async () => {
    developmentLink()
    const outside = join(home, 'other-bin')
    mkdirSync(outside)
    writeFileSync(join(outside, 'hn'), '#!/bin/sh\n', { mode: 0o755 })
    vi.stubEnv('PATH', `${outside}:${bin}`)
    vi.stubEnv('HARNESS_TUI_BIN', '/chosen/development/hn')
    const lines: string[] = []
    await api.reportHnLauncher(s => lines.push(s))
    expect(lines.join('\n')).toContain('HARNESS_TUI_BIN=/chosen/development/hn')
    expect(lines.join('\n')).toContain('does not receive automatic updates')
    expect(lines.join('\n')).toContain('harness tui --install')
    expect(lines.join('\n')).toContain(`Your PATH resolves hn to ${join(outside, 'hn')}`)
  })
})
