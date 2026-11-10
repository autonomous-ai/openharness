import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTeamConfig, type TeamConfig } from './config.js'
import { checkTeamEngines, realEngineCheckDeps, teamEngineBin, teamEngineReporter, TeamEngineReporter, type TeamEngines } from './engines.js'
import { readTeamStatus, type TeamStatus } from './privacy.js'

vi.mock('./config.js', async (original) => ({ ...await original<typeof import('./config.js')>(), readTeamConfig: vi.fn(() => null) }))

const config = { user: 'harnessteam', home: '/Users/harnessteam', statusFile: '/status.json' } as TeamConfig
const engines = (over: Partial<TeamEngines> = {}): TeamEngines =>
  ({ checkedAt: 1_000, claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true }, ...over })

const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the reporter on this computer', () => {
  // Windows has had Team accounts since 0.5.4: its daemon never reported, so its owner read "not reported yet" for good.
  it('reads the Team account of a Windows PC, as of a Mac and a Linux computer', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const reads = vi.mocked(readTeamConfig)
      reads.mockClear()
      const reporter = teamEngineReporter()
      reporter.start()
      reporter.stop()
      expect(reads).toHaveBeenCalled()
    } finally { Object.defineProperty(process, 'platform', platform) }
  })
})

describe('the team account\'s engines', () => {
  it('are installed when its own ~/.local/bin holds them, and signed in as the engine\'s own files say', async () => {
    const account = vi.fn(async (engine: string) => ({ signedIn: engine === 'claude' ? false : null, lastUsedAt: null }))
    const result = await checkTeamEngines({ home: '/Users/harnessteam', executable: (path) => path === '/Users/harnessteam/.local/bin/claude', account, now: () => 42 })
    expect(result).toEqual({ checkedAt: 42, claude: { installed: true, signedIn: false }, codex: { installed: false, signedIn: null } })
    expect(teamEngineBin('/h', 'codex')).toBe('/h/.local/bin/codex')
    // Windows: npm's .cmd in the prefix itself.
    expect(teamEngineBin('C:\\Users\\harnessteam', 'claude', 'win32')).toBe('C:\\Users\\harnessteam\\.local\\claude.cmd')
    const windows = await checkTeamEngines({ home: 'C:\\Users\\harnessteam', platform: 'win32', now: () => 1, account,
      executable: (path) => path === 'C:\\Users\\harnessteam\\.local\\codex.cmd' })
    expect(windows).toMatchObject({ claude: { installed: false }, codex: { installed: true } })
    const failing = await checkTeamEngines({ home: '/h', executable: () => true, account: async () => { throw new Error('unreadable') }, now: () => 1 })
    expect(failing.claude).toEqual({ installed: true, signedIn: null })
  })

  // The team's CLIs are in its own home's .local/bin, which a daemon's PATH need not name: each is asked there (#4137, no
  // login file read).
  it.skipIf(process.platform === 'win32')('reads a home it is given, never the owner\'s: an executable, and its own CLI\'s sign-in', async () => {
    const home = mkdtempSync(join(tmpdir(), 'team-engines-'))
    cleanup.push(home)
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    // `codex login status` exits 0 when signed in.
    writeFileSync(join(home, '.local', 'bin', 'codex'), '#!/bin/sh\n[ "$1 $2" = "login status" ] && exit 0\nexit 2\n', { mode: 0o755 })
    writeFileSync(join(home, '.local', 'bin', 'claude'), 'not executable', { mode: 0o644 })
    const real = realEngineCheckDeps(home, { PATH: '/usr/bin:/bin' })
    const result = await checkTeamEngines({ ...real, now: () => 7,
      account: (engine) => engine === 'codex' ? real.account(engine) : Promise.resolve({ signedIn: null, lastUsedAt: null }) })
    expect(result.codex).toEqual({ installed: true, signedIn: true })
    expect(result.claude.installed).toBe(false)
  })

})

describe('TeamEngineReporter', () => {
  const reporter = (over: { user?: string; config?: TeamConfig | null; checked?: TeamEngines[] } = {}) => {
    const status: { value: TeamStatus | null } = { value: null }
    const results = [...(over.checked ?? [engines()])]
    const check = vi.fn(async () => results.length > 1 ? results.shift()! : results[0]!)
    const write = vi.fn((_path: string, update: Partial<TeamStatus>) => { status.value = { ...(status.value ?? { version: 1 }), ...update, version: 1 } })
    const r = new TeamEngineReporter({ config: () => over.config === undefined ? config : over.config, user: () => over.user ?? 'harnessteam',
      check, read: () => status.value, write, intervalMs: 60_000 })
    return { r, check, write, status }
  }

  it('reports only in the Harness Team account, and writes only what changed or has grown old', async () => {
    const owner = reporter({ user: 'owner-placeholder' })
    owner.r.start()
    await owner.r.report()
    expect(owner.check).not.toHaveBeenCalled()
    await expect(reporter({ config: null }).r.report()).resolves.toBeUndefined()

    const team = reporter({ checked: [engines({ checkedAt: 1_000 }), engines({ checkedAt: 2_000 }),
      engines({ checkedAt: 3_000, claude: { installed: true, signedIn: false } }), engines({ checkedAt: 3_000 + 10 * 60_000 })] })
    await team.r.report()
    expect(team.write).toHaveBeenCalledTimes(1)
    await team.r.report()
    expect(team.write).toHaveBeenCalledTimes(1)
    await team.r.report()
    expect(team.write).toHaveBeenCalledTimes(2)
    expect(team.status.value?.engines?.claude.signedIn).toBe(false)
    await team.r.report()
    expect(team.write).toHaveBeenCalledTimes(3)
  })

  it('looks again on a timer while started, and a failed look waits for the next', async () => {
    vi.useFakeTimers()
    try {
      const team = reporter()
      team.check.mockRejectedValueOnce(new Error('disk'))
      team.r.start()
      team.r.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(team.write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(team.write).toHaveBeenCalledTimes(1)
      team.r.stop()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(team.check).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('is what the status file keeps, and an engines field that is not one is dropped', () => {
    const read = (value: unknown) => readTeamStatus('/s', () => JSON.stringify({ version: 1, engines: value }))?.engines
    expect(read(engines())).toEqual(engines())
    for (const bad of [null, 'x', { checkedAt: 'now' }, { checkedAt: 1, claude: { installed: true, signedIn: true } },
      { ...engines(), codex: { installed: 'yes', signedIn: true } }, { ...engines(), codex: { installed: true, signedIn: 'maybe' } }]) {
      expect(read(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

