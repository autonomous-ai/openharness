import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamConfig } from '../team/config.js'
import { agentTmpEnv, agentTmpFolder, agentTmpRoot, agentTmpState, prepareAgentTmp, resetAgentTmpSweep, sweepAgentTmp, type AgentTmpDeps } from './agentTmp.js'

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); resetAgentTmpSweep() })
const scratch = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tmp-'))); made.push(dir); return dir }

const config = { user: 'harnessteam' } as TeamConfig
const deps = (dataDir: string, over: Partial<AgentTmpDeps> = {}): AgentTmpDeps => ({
  platform: 'darwin', dataDir, config: () => config, user: () => 'owner-placeholder', log: vi.fn(), now: () => 1_000_000_000_000, ...over,
})

describe('who gets the private temporary folder', () => {
  it('an owner\'s engine agent on a computer with a Team account, in a 0700 folder', () => {
    const data = scratch()
    const env = agentTmpEnv('claude', undefined, deps(data))
    expect(env).toEqual({ TMPDIR: agentTmpFolder(data) })
    expect(statSync(env.TMPDIR!).mode & 0o777).toBe(0o700)
  })

  it('a Swarm role other than Buddy too, on Linux too', () => {
    const data = scratch()
    expect(agentTmpEnv('codex', 'dev', deps(data, { platform: 'linux' }))).toEqual({ TMPDIR: agentTmpFolder(data) })
  })

  it('nobody else: a Buddy, whose guard closes the data folder; a person\'s terminal; Windows; the Team account; a computer with no Team account', () => {
    const data = scratch()
    expect(agentTmpEnv('claude', 'buddy', deps(data))).toEqual({})
    expect(agentTmpEnv('terminal', undefined, deps(data))).toEqual({})
    expect(agentTmpEnv('claude', undefined, deps(data, { platform: 'win32' }))).toEqual({})
    expect(agentTmpEnv('claude', undefined, deps(data, { user: () => 'harnessteam' }))).toEqual({})
    expect(agentTmpEnv('claude', undefined, deps(data, { config: () => null }))).toEqual({})
    expect(existsSync(agentTmpFolder(data))).toBe(false)
  })

  it('a config that cannot be read counts as no Team account, and the agent still starts', () => {
    const data = scratch()
    expect(agentTmpEnv('claude', undefined, deps(data, { config: () => { throw new Error('unreadable') } }))).toEqual({})
  })

  it('is a root for what agents drop only where it is in use', () => {
    const data = scratch()
    expect(agentTmpRoot(deps(data))).toBe(agentTmpFolder(data))
    expect(agentTmpRoot(deps(data, { config: () => null }))).toBeNull()
  })
})

describe('the folder itself', () => {
  it('closes a folder someone left open', () => {
    const folder = join(scratch(), 'agent-tmp')
    mkdirSync(folder, { mode: 0o777 })
    chmodSync(folder, 0o777)
    expect(prepareAgentTmp(folder)).toBe(true)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
  })

  it('refuses a link in its place, and the agent falls back to the system\'s folder, saying so', () => {
    const data = scratch(), elsewhere = scratch()
    symlinkSync(elsewhere, agentTmpFolder(data))
    const d = deps(data)
    expect(agentTmpEnv('claude', undefined, d)).toEqual({})
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('private temporary folder'))
    chmodSync(elsewhere, 0o755)
    expect(statSync(elsewhere).mode & 0o777).toBe(0o755)
  })

  it('refuses a folder another account owns', () => {
    const folder = join(scratch(), 'agent-tmp')
    mkdirSync(folder, { mode: 0o700 })
    expect(prepareAgentTmp(folder, 99_999)).toBe(false)
  })

  it('refuses a file in its place', () => {
    const folder = join(scratch(), 'agent-tmp')
    writeFileSync(folder, 'x')
    expect(prepareAgentTmp(folder)).toBe(false)
  })

  it('reports its state for harness team status', () => {
    const data = scratch(), folder = agentTmpFolder(data)
    expect(agentTmpState(folder)).toEqual({ path: folder, state: 'not-made', mode: null })
    mkdirSync(folder, { mode: 0o700 })
    chmodSync(folder, 0o700)
    expect(agentTmpState(folder)).toEqual({ path: folder, state: 'private', mode: 0o700 })
    chmodSync(folder, 0o755)
    expect(agentTmpState(folder)).toEqual({ path: folder, state: 'open', mode: 0o755 })
    rmSync(folder, { recursive: true })
    symlinkSync(scratch(), folder)
    expect(agentTmpState(folder)).toEqual({ path: folder, state: 'open', mode: null })
  })
})

describe('what deletes it', () => {
  const DAY = 24 * 60 * 60_000
  const NOW = Date.now()
  const old = (path: string) => { const at = new Date(NOW - 8 * DAY); utimesSync(path, at, at) }

  it('deletes what nothing has changed in for 7 days, and keeps anything with a recent file inside', async () => {
    const folder = scratch()
    writeFileSync(join(folder, 'stale.log'), 'x'); old(join(folder, 'stale.log'))
    mkdirSync(join(folder, 'stale-dir/inner'), { recursive: true })
    writeFileSync(join(folder, 'stale-dir/inner/a'), 'x'); old(join(folder, 'stale-dir/inner/a')); old(join(folder, 'stale-dir/inner')); old(join(folder, 'stale-dir'))
    writeFileSync(join(folder, 'fresh.log'), 'x')
    mkdirSync(join(folder, 'in-use/inner'), { recursive: true })
    writeFileSync(join(folder, 'in-use/inner/recent'), 'x'); old(join(folder, 'in-use/inner')); old(join(folder, 'in-use'))
    expect(await sweepAgentTmp(folder, NOW)).toBe(2)
    expect(existsSync(join(folder, 'stale.log'))).toBe(false)
    expect(existsSync(join(folder, 'stale-dir'))).toBe(false)
    expect(existsSync(join(folder, 'fresh.log'))).toBe(true)
    expect(existsSync(join(folder, 'in-use/inner/recent'))).toBe(true)
  })

  it('deletes a link, never what it points at', async () => {
    const folder = scratch(), target = scratch()
    writeFileSync(join(target, 'kept'), 'x')
    symlinkSync(target, join(folder, 'link'))
    const at = new Date(NOW - 8 * DAY)
    const { lutimesSync } = await import('node:fs')
    lutimesSync(join(folder, 'link'), at, at)
    expect(await sweepAgentTmp(folder, NOW)).toBe(1)
    expect(existsSync(join(target, 'kept'))).toBe(true)
  })

  it('deletes nothing through a link in the folder\'s place', async () => {
    const target = scratch(), folder = join(scratch(), 'agent-tmp')
    writeFileSync(join(target, 'kept'), 'x'); old(join(target, 'kept'))
    symlinkSync(target, folder)
    expect(await sweepAgentTmp(folder, NOW)).toBe(0)
    expect(existsSync(join(target, 'kept'))).toBe(true)
  })

  it('still sweeps once the Team account is gone', async () => {
    const data = scratch(), folder = agentTmpFolder(data)
    mkdirSync(folder, { mode: 0o700 })
    writeFileSync(join(folder, 'stale'), 'x'); old(join(folder, 'stale'))
    expect(agentTmpEnv('claude', undefined, deps(data, { config: () => null, now: () => NOW }))).toEqual({})
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
  })

  it('sweeps from a launch at most once a day', async () => {
    const data = scratch(), folder = agentTmpFolder(data)
    let now = NOW
    const d = deps(data, { now: () => now })
    agentTmpEnv('claude', undefined, d)
    await vi.waitFor(() => expect(existsSync(folder)).toBe(true))
    writeFileSync(join(folder, 'stale'), 'x'); old(join(folder, 'stale'))
    agentTmpEnv('claude', undefined, d)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(folder, 'stale'))).toBe(true)
    now += DAY + 1
    agentTmpEnv('claude', undefined, d)
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
  })

  it('a sweep of a folder that cannot be read deletes nothing and does not throw', async () => {
    expect(await sweepAgentTmp(join(scratch(), 'missing'), NOW)).toBe(0)
  })
})
