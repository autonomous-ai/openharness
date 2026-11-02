import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamConfig } from '../team/config.js'
import { agentTmpEnv, agentTmpFolder, agentTmpRoot, agentTmpState, buddyTmpEnv, buddyTmpFolder, buddyTmpOf, buddyTmpParent, prepareAgentTmp, resetAgentTmpSweep, sweepAgentTmp, sweepBuddyTmp, type AgentTmpDeps } from './agentTmp.js'

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
    // Another account's 0700 folder is not this account's private one.
    expect(agentTmpState(folder, 99_999)).toEqual({ path: folder, state: 'open', mode: 0o700 })
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
  // ctime cannot be set, so an idle file is one the sweep sees from 8 days on, and a recent one has its mtime set to that day.
  const LATER = NOW + 8 * DAY
  const recentThen = (path: string) => { const at = new Date(LATER); utimesSync(path, at, at) }

  it('deletes what nothing has changed in for 7 days, and keeps anything with a recent file inside', async () => {
    const folder = scratch()
    writeFileSync(join(folder, 'stale.log'), 'x')
    mkdirSync(join(folder, 'stale-dir/inner'), { recursive: true })
    writeFileSync(join(folder, 'stale-dir/inner/a'), 'x')
    writeFileSync(join(folder, 'fresh.log'), 'x'); recentThen(join(folder, 'fresh.log'))
    mkdirSync(join(folder, 'in-use/inner'), { recursive: true })
    writeFileSync(join(folder, 'in-use/inner/recent'), 'x'); recentThen(join(folder, 'in-use/inner/recent'))
    expect(await sweepAgentTmp(folder, LATER)).toBe(2)
    expect(existsSync(join(folder, 'stale.log'))).toBe(false)
    expect(existsSync(join(folder, 'stale-dir'))).toBe(false)
    expect(existsSync(join(folder, 'fresh.log'))).toBe(true)
    expect(existsSync(join(folder, 'in-use/inner/recent'))).toBe(true)
  })

  it('keeps what was just unpacked with an old mtime, as tar, cp -p and rsync -t leave it', async () => {
    const folder = scratch()
    mkdirSync(join(folder, 'tool'))
    writeFileSync(join(folder, 'tool/bin'), 'x')
    writeFileSync(join(folder, 'loose'), 'x')
    const long = new Date(NOW - 400 * DAY)
    for (const path of ['tool/bin', 'tool', 'loose']) utimesSync(join(folder, path), long, long)
    expect(await sweepAgentTmp(folder, NOW)).toBe(0)
    expect(existsSync(join(folder, 'tool/bin'))).toBe(true)
    expect(existsSync(join(folder, 'loose'))).toBe(true)
  })

  it('deletes a link, never what it points at', async () => {
    const folder = scratch(), target = scratch()
    writeFileSync(join(target, 'kept'), 'x')
    symlinkSync(target, join(folder, 'link'))
    expect(await sweepAgentTmp(folder, LATER)).toBe(1)
    expect(existsSync(join(folder, 'link'))).toBe(false)
    expect(existsSync(join(target, 'kept'))).toBe(true)
  })

  it('deletes nothing through a link in the folder\'s place', async () => {
    const target = scratch(), folder = join(scratch(), 'agent-tmp')
    writeFileSync(join(target, 'kept'), 'x')
    symlinkSync(target, folder)
    expect(await sweepAgentTmp(folder, LATER)).toBe(0)
    expect(existsSync(join(target, 'kept'))).toBe(true)
  })

  it('still sweeps once the Team account is gone', async () => {
    const data = scratch(), folder = agentTmpFolder(data)
    mkdirSync(folder, { mode: 0o700 })
    writeFileSync(join(folder, 'stale'), 'x')
    expect(agentTmpEnv('claude', undefined, deps(data, { config: () => null, now: () => LATER }))).toEqual({})
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
  })

  it('sweeps from a launch at most once a day', async () => {
    const data = scratch(), folder = agentTmpFolder(data)
    let now = LATER - DAY - 1
    const d = deps(data, { now: () => now })
    agentTmpEnv('claude', undefined, d)
    writeFileSync(join(folder, 'stale'), 'x')
    // The day's sweep already ran: this launch starts none, though the file's 7 days are nearly up.
    now = LATER - DAY / 2
    agentTmpEnv('claude', undefined, d)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(folder, 'stale'))).toBe(true)
    now = LATER
    agentTmpEnv('claude', undefined, d)
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
  })

  it('a sweep of a folder that cannot be read deletes nothing and does not throw', async () => {
    expect(await sweepAgentTmp(join(scratch(), 'missing'), NOW)).toBe(0)
  })
})

describe('a Buddy\'s private temporary folder', () => {
  const DAY = 24 * 60 * 60_000
  /** A data folder in a scratch folder of its own, so the sibling `-buddy-tmp` is cleaned with it. */
  const dataIn = () => join(scratch(), 'data')

  it('is a 0700 folder under a 0700 parent, for Claude Code\'s own files too, outside the data folder', () => {
    const data = dataIn()
    const env = buddyTmpEnv('claude', '/work/one', deps(data))
    expect(env).toEqual({ TMPDIR: buddyTmpFolder('/work/one', data), CLAUDE_CODE_TMPDIR: buddyTmpFolder('/work/one', data) })
    expect(statSync(env.TMPDIR!).mode & 0o777).toBe(0o700)
    expect(statSync(buddyTmpParent(data)).mode & 0o777).toBe(0o700)
    expect(statSync(env.TMPDIR!).uid).toBe(process.geteuid!())
    expect(env.TMPDIR!.startsWith(`${data}/`)).toBe(false)
  })

  it('is one per Buddy, and stays the same across a relaunch', () => {
    const data = dataIn()
    expect(buddyTmpFolder('/work/one', data)).not.toBe(buddyTmpFolder('/work/two', data))
    expect(buddyTmpOf('/work/one', deps(data))).toBe(buddyTmpOf('/work/one', deps(data)))
  })

  it('gives another engine TMPDIR alone', () => {
    const data = dataIn()
    expect(buddyTmpEnv('codex', '/work/one', deps(data))).toEqual({ TMPDIR: buddyTmpFolder('/work/one', data) })
  })

  it('is only for the owner\'s account on a computer with a Team account, on macOS and Linux', () => {
    const data = dataIn()
    expect(buddyTmpEnv('claude', '/work/one', deps(data, { config: () => null }))).toEqual({})
    expect(buddyTmpEnv('claude', '/work/one', deps(data, { user: () => 'harnessteam' }))).toEqual({})
    expect(buddyTmpEnv('claude', '/work/one', deps(data, { platform: 'win32' }))).toEqual({})
    expect(buddyTmpOf('/work/one', deps(data, { config: () => null }))).toBeNull()
    expect(existsSync(buddyTmpParent(data))).toBe(false)
  })

  // Not yet run in Linux's sandbox (bubblewrap): a folder it would not open breaks every command of a Buddy (review of #2563).
  it('leaves Linux on the system\'s folder until the sandbox has been tried there', () => {
    const data = dataIn()
    expect(buddyTmpEnv('claude', '/work/one', deps(data, { platform: 'linux' }))).toEqual({})
    expect(buddyTmpOf('/work/one', deps(data, { platform: 'linux' }))).toBeNull()
    expect(existsSync(buddyTmpParent(data))).toBe(false)
  })

  it('names the folder by its real path when the data folder is reached through a link, as the guard compares real paths', () => {
    const at = scratch(), real = join(at, 'real'), data = join(at, 'data')
    mkdirSync(real); symlinkSync(real, data)
    expect(buddyTmpOf('/work/one', deps(data))).toBe(join(`${data}-buddy-tmp`, buddyTmpFolder('/work/one', data).split('/').at(-1)!))
    const linked = join(scratch(), 'link'), parentReal = scratch()
    symlinkSync(scratch(), linked)
    const nested = join(parentReal, 'real-data'), viaLink = join(scratch(), 'via')
    mkdirSync(nested); symlinkSync(parentReal, viaLink)
    expect(buddyTmpOf('/work/one', deps(join(viaLink, 'real-data')))).toBe(join(`${nested}-buddy-tmp`, buddyTmpFolder('/work/one', nested).split('/').at(-1)!))
  })

  it('closes a folder someone left open, and a parent too', () => {
    const data = dataIn(), folder = buddyTmpFolder('/work/one', data)
    mkdirSync(folder, { recursive: true, mode: 0o777 })
    chmodSync(folder, 0o777); chmodSync(buddyTmpParent(data), 0o777)
    expect(buddyTmpOf('/work/one', deps(data))).toBe(folder)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(statSync(buddyTmpParent(data)).mode & 0o777).toBe(0o700)
  })

  it.each(['the folder', 'the parent'])('refuses a link in place of %s, and the Buddy keeps the system\'s folder, saying so', (which) => {
    const data = dataIn(), elsewhere = scratch(), folder = buddyTmpFolder('/work/one', data)
    if (which === 'the folder') { mkdirSync(buddyTmpParent(data), { recursive: true, mode: 0o700 }); symlinkSync(elsewhere, folder) } else { mkdirSync(data, { recursive: true }); symlinkSync(elsewhere, buddyTmpParent(data)) }
    chmodSync(elsewhere, 0o755)
    const d = deps(data)
    expect(buddyTmpOf('/work/one', d)).toBeNull()
    expect(buddyTmpEnv('claude', '/work/one', d)).toEqual({})
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('private temporary folder'))
    expect(statSync(elsewhere).mode & 0o777).toBe(0o755)
  })

  it('deletes what nothing has changed in for 7 days inside each Buddy\'s folder, keeping the folder a live Buddy has as its TMPDIR', async () => {
    const data = dataIn(), folder = buddyTmpOf('/work/one', deps(data))!
    writeFileSync(join(folder, 'stale'), 'x')
    const later = Date.now() + 8 * DAY
    writeFileSync(join(folder, 'fresh'), 'x'); utimesSync(join(folder, 'fresh'), new Date(later), new Date(later))
    expect(await sweepBuddyTmp(buddyTmpParent(data), later)).toBe(1)
    expect(existsSync(join(folder, 'stale'))).toBe(false)
    expect(existsSync(join(folder, 'fresh'))).toBe(true)
    expect(existsSync(folder)).toBe(true)
  })

  it('removes a Buddy\'s folder only when empty and idle for 30 days', async () => {
    const data = dataIn(), folder = buddyTmpOf('/work/one', deps(data))!
    await sweepBuddyTmp(buddyTmpParent(data), Date.now() + 8 * DAY)
    expect(existsSync(folder)).toBe(true)
    await sweepBuddyTmp(buddyTmpParent(data), Date.now() + 31 * DAY)
    expect(existsSync(folder)).toBe(false)
  })

  it('sweeps nothing through a link, in the parent\'s place or among the Buddies\' folders', async () => {
    const data = dataIn(), target = scratch()
    writeFileSync(join(target, 'kept'), 'x')
    mkdirSync(buddyTmpParent(data), { recursive: true, mode: 0o700 })
    symlinkSync(target, join(buddyTmpParent(data), 'link'))
    await sweepBuddyTmp(buddyTmpParent(data), Date.now() + 40 * DAY)
    expect(existsSync(join(target, 'kept'))).toBe(true)
    const other = join(scratch(), 'parent')
    symlinkSync(target, other)
    expect(await sweepBuddyTmp(other, Date.now() + 40 * DAY)).toBe(0)
    expect(existsSync(join(target, 'kept'))).toBe(true)
  })

  it('is swept by a launch, with the Team account gone too', async () => {
    const data = dataIn(), folder = buddyTmpOf('/work/one', deps(data))!
    writeFileSync(join(folder, 'stale'), 'x')
    resetAgentTmpSweep()
    agentTmpEnv('claude', undefined, deps(data, { config: () => null, now: () => Date.now() + 8 * DAY }))
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
  })
})
