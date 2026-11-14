import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentTmpFolder, agentTmpRoot, prepareAgentTmp, resetAgentTmpSweep, sweepAgentTmp, sweepAgentTmpWhenDue, sweepTmpFolders, type AgentTmpDeps } from './agentTmp.js'

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); resetAgentTmpSweep() })
const scratch = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tmp-'))); made.push(dir); return dir }

const deps = (dataDir: string, over: Partial<AgentTmpDeps> = {}): AgentTmpDeps => ({
  platform: 'darwin', dataDir, log: vi.fn(), now: () => 1_000_000_000_000, ...over,
})

describe('the agents\' folder', () => {
  it('is a root for what agents drop wherever agents are given it, never on Windows', () => {
    const data = scratch()
    expect(agentTmpRoot(deps(data))).toBe(agentTmpFolder(data))
    expect(agentTmpRoot(deps(data, { platform: 'win32' }))).toBeNull()
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

  it('refuses a link in its place, and leaves what it points at as it is', () => {
    const data = scratch(), elsewhere = scratch()
    chmodSync(elsewhere, 0o755)
    symlinkSync(elsewhere, agentTmpFolder(data))
    expect(prepareAgentTmp(agentTmpFolder(data))).toBe(false)
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

  it('is swept as an agent is launched, whoever launches it', async () => {
    const data = scratch(), folder = agentTmpFolder(data)
    mkdirSync(folder, { mode: 0o700 })
    writeFileSync(join(folder, 'stale'), 'x')
    sweepAgentTmpWhenDue(deps(data, { now: () => LATER }))
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
  })

  it('sweeps from a launch at most once a day', async () => {
    const data = scratch(), folder = agentTmpFolder(data)
    let now = LATER - DAY - 1
    const d = deps(data, { now: () => now })
    sweepAgentTmpWhenDue(d)
    mkdirSync(folder, { mode: 0o700 })
    writeFileSync(join(folder, 'stale'), 'x')
    // The day's sweep already ran: this launch starts none, though the file's 7 days are nearly up.
    now = LATER - DAY / 2
    sweepAgentTmpWhenDue(d)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(folder, 'stale'))).toBe(true)
    now = LATER
    sweepAgentTmpWhenDue(d)
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
    expect(d.log).toHaveBeenCalledWith('removed 1 entries nothing had changed in for 7 days')
  })

  it('sweeps nothing on Windows, whose temporary folder is the account\'s own', async () => {
    const data = scratch(), folder = agentTmpFolder(data)
    mkdirSync(folder, { mode: 0o700 })
    writeFileSync(join(folder, 'stale'), 'x')
    sweepAgentTmpWhenDue(deps(data, { platform: 'win32', now: () => LATER }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(folder, 'stale'))).toBe(true)
  })

  it('a sweep of a folder that cannot be read deletes nothing and does not throw', async () => {
    expect(await sweepAgentTmp(join(scratch(), 'missing'), NOW)).toBe(0)
  })
})

describe('the folders in the agents\' folder', () => {
  const DAY = 24 * 60 * 60_000
  const leftFolder = (data: string): string => {
    const folder = join(agentTmpFolder(data), 'one')
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    return folder
  }

  it('deletes what nothing has changed in for 7 days inside each, keeping the folder until it is empty', async () => {
    const data = scratch(), folder = leftFolder(data)
    writeFileSync(join(folder, 'stale'), 'x')
    const later = Date.now() + 8 * DAY
    writeFileSync(join(folder, 'fresh'), 'x'); utimesSync(join(folder, 'fresh'), new Date(later), new Date(later))
    expect(await sweepTmpFolders(agentTmpFolder(data), later)).toBe(1)
    expect(existsSync(join(folder, 'stale'))).toBe(false)
    expect(existsSync(join(folder, 'fresh'))).toBe(true)
    expect(existsSync(folder)).toBe(true)
  })

  // An older build gave some agents a folder of their own here: it is emptied as any is, and goes once empty for 30 days.
  it('removes a folder once it has been empty and idle for 30 days', async () => {
    const data = scratch(), folder = leftFolder(data)
    writeFileSync(join(folder, 'stale'), 'x')
    await sweepTmpFolders(agentTmpFolder(data), Date.now() + 8 * DAY)
    expect(existsSync(join(folder, 'stale'))).toBe(false)
    expect(existsSync(folder)).toBe(true)
    await sweepTmpFolders(agentTmpFolder(data), Date.now() + 31 * DAY)
    expect(existsSync(folder)).toBe(false)
  })

  it('sweeps nothing through a link, in the parent\'s place or among the folders', async () => {
    const data = scratch(), target = scratch()
    writeFileSync(join(target, 'kept'), 'x')
    mkdirSync(agentTmpFolder(data), { recursive: true, mode: 0o700 })
    symlinkSync(target, join(agentTmpFolder(data), 'link'))
    await sweepTmpFolders(agentTmpFolder(data), Date.now() + 40 * DAY)
    expect(existsSync(join(target, 'kept'))).toBe(true)
    const other = join(scratch(), 'parent')
    symlinkSync(target, other)
    expect(await sweepTmpFolders(other, Date.now() + 40 * DAY)).toBe(0)
    expect(existsSync(join(target, 'kept'))).toBe(true)
  })
})
