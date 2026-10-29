import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamConfig } from './config.js'
import { checkTeamEngines, engineLines, realEngineCheckDeps, teamEngineBin, TeamEngineReporter, type TeamEngines } from './engines.js'
import { readTeamStatus, type TeamStatus } from './privacy.js'

const config = { user: 'harnessteam', home: '/Users/harnessteam', statusFile: '/status.json' } as TeamConfig
const engines = (over: Partial<TeamEngines> = {}): TeamEngines =>
  ({ checkedAt: 1_000, claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true }, ...over })

const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

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

  it('reads a home it is given, never the owner\'s: an executable, and a credential file\'s presence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'team-engines-'))
    cleanup.push(home)
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    writeFileSync(join(home, '.local', 'bin', 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(home, '.local', 'bin', 'claude'), 'not executable', { mode: 0o644 })
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'present' } }))
    // Codex's answer is read from the files; Claude Code's would also look in this Mac's Keychain, which a test leaves alone.
    const real = realEngineCheckDeps(home, {})
    const result = await checkTeamEngines({ ...real, now: () => 7,
      account: (engine) => engine === 'codex' ? real.account(engine) : Promise.resolve({ signedIn: null, lastUsedAt: null }) })
    expect(result.codex).toEqual({ installed: true, signedIn: true })
    expect(result.claude.installed).toBe(false)
  })

  it('are said plainly in status, with exactly how to sign in the ones that are not', () => {
    const ago = (at: number) => `${at}s ago`
    const lines = engineLines(engines({ claude: { installed: true, signedIn: false }, codex: { installed: false, signedIn: null } }), ago).join('\n')
    expect(lines).toContain('Claude Code ✓ installed · ✗ not signed in')
    expect(lines).toContain('Codex       ✗ not installed · harness team setup installs it')
    expect(lines).toContain('open a terminal on this Mac\'s Harness Team machine')
    // Off a Mac the computer is not a Mac (seen in `harness team setup` on Linux, 2026-10-28).
    const linux = engineLines(engines({ claude: { installed: true, signedIn: false }, codex: { installed: true, signedIn: false } }), ago, 'linux').join('\n')
    expect(linux).toContain('open a terminal on this computer\'s Harness Team machine')
    expect(linux).not.toContain('Mac')
    expect(lines).toContain('    claude                      Claude Code')
    expect(lines).not.toContain('codex login')
    expect(lines).toContain('Your own sign-ins are not copied into the team account')
    const unknown = engineLines(engines({ codex: { installed: true, signedIn: null } }), ago).join('\n')
    expect(unknown).toContain('Codex       ✓ installed · ? sign-in unknown')
    expect(unknown).toContain('    codex login --device-auth   Codex')
    const ready = engineLines(engines(), ago).join('\n')
    expect(ready).toContain('✓ installed · ✓ signed in')
    expect(ready).toContain('(checked 1000s ago)')
    expect(ready).not.toContain('To sign')
    expect(engineLines(undefined, ago)).toEqual(['  engines     ? not reported yet: the team daemon reports them once it runs'])
    // Not signed in, but its owner's relay is there: nothing to sign in.
    const relayed = engineLines(engines({ claude: { installed: true, signedIn: false, relayed: true }, codex: { installed: true, signedIn: null, relayed: true } }), ago).join('\n')
    expect(relayed).toContain('Claude Code ✓ installed · ✓ uses your subscription')
    expect(relayed).not.toContain('To sign')
  })

  it('says an engine it has not signed in uses the owner\'s subscription when the owner\'s relay is there', async () => {
    const result = await checkTeamEngines({ home: '/h', executable: () => true, now: () => 1, relayed: () => true,
      account: async (engine) => ({ signedIn: engine === 'codex', lastUsedAt: null }) })
    expect(result.claude).toEqual({ installed: true, signedIn: false, relayed: true })
    expect(result.codex).toEqual({ installed: true, signedIn: true })
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
