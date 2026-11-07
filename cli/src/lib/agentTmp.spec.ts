import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamConfig } from '../team/config.js'
import { agentTmpFolder, agentTmpLaunch, agentTmpRoot, agentTmpState, buddyTmpEnv, buddyTmpFolder, buddyTmpOf, buddyTmpParent, prepareAgentTmp, resetAgentTmpSweep, sweepAgentTmp, sweepTmpFolders, type AgentTmpDeps } from './agentTmp.js'

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); resetAgentTmpSweep() })
const scratch = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tmp-'))); made.push(dir); return dir }

const config = { user: 'harnessteam' } as TeamConfig
const deps = (dataDir: string, over: Partial<AgentTmpDeps> = {}): AgentTmpDeps => ({
  platform: 'darwin', dataDir, config: () => config, user: () => 'owner-placeholder', log: vi.fn(), now: () => 1_000_000_000_000, ...over,
})

const none = { env: {}, args: [] }

describe('who gets the private temporary folder', () => {
  // Task #4395: since #4215 an agent starts in its owner's own settings, which on the Mac Studio block reads outside the working
  // directories, and since v3 there is no Team computer, so agents used the system's folder and stopped at Claude Code's
  // question for their own mktemp file (Authorder, 11-07). Each Swarm agent gets a folder of its own, added to the engine's
  // working directories: Claude Code reads an added folder's own skills and settings, so one shared folder would let an
  // agent plant them for the others.
  it('a Swarm agent, with no Team account here: a 0700 folder of its own as TMPDIR, added to Claude Code\'s and Codex\'s working directories', () => {
    const data = scratch(), workspace = scratch(), other = scratch()
    const launch = agentTmpLaunch('claude', 'agent', workspace, deps(data, { config: () => null }))
    const folder = launch.env.TMPDIR!
    expect(folder.startsWith(`${realpathSync(agentTmpFolder(data))}/`)).toBe(true)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(statSync(agentTmpFolder(data)).mode & 0o777).toBe(0o700)
    // Joined to its flag: Claude Code's takes several values and would swallow what follows it.
    expect(launch).toEqual({ env: { TMPDIR: folder }, args: [`--add-dir=${folder}`] })
    expect(agentTmpLaunch('codex', 'coordinator', workspace, deps(data, { platform: 'linux', config: () => null })))
      .toEqual({ env: { TMPDIR: folder }, args: [`--add-dir=${folder}`] })
    // The same agent's relaunch finds the same folder; another agent has its own.
    const another = agentTmpLaunch('claude', 'agent', other, deps(data, { config: () => null })).env.TMPDIR
    expect(another).not.toBe(folder)
    expect(another!.startsWith(`${realpathSync(agentTmpFolder(data))}/`)).toBe(true)
  })

  it('an engine that takes no such folder gets the folder alone', () => {
    const data = scratch(), workspace = scratch()
    const launch = agentTmpLaunch('opencode', 'agent', workspace, deps(data, { config: () => null }))
    expect(launch.args).toEqual([])
    expect(launch.env.TMPDIR!.startsWith(`${realpathSync(agentTmpFolder(data))}/`)).toBe(true)
  })

  it('nobody else gets an added folder: a Buddy, whose guard closes the data folder; a terminal; a person\'s own session; Windows; a Swarm agent with no workspace', () => {
    const data = scratch(), workspace = scratch()
    expect(agentTmpLaunch('claude', 'buddy', workspace, deps(data))).toEqual(none)
    expect(agentTmpLaunch('terminal', 'agent', workspace, deps(data))).toEqual(none)
    expect(agentTmpLaunch('claude', undefined, workspace, deps(data, { config: () => null }))).toEqual(none)
    expect(agentTmpLaunch('claude', 'agent', workspace, deps(data, { platform: 'win32' }))).toEqual(none)
    expect(agentTmpLaunch('claude', 'agent', null, deps(data, { config: () => null }))).toEqual(none)
    expect(existsSync(agentTmpFolder(data))).toBe(false)
  })

  it('a person\'s own session on a computer with a Team account keeps the shared folder, with nothing added', () => {
    const data = scratch()
    expect(agentTmpLaunch('claude', undefined, scratch(), deps(data))).toEqual({ env: { TMPDIR: agentTmpFolder(data) }, args: [] })
    expect(agentTmpLaunch('claude', undefined, scratch(), deps(data, { user: () => 'harnessteam' }))).toEqual(none)
  })

  it('a config that cannot be read counts as no Team account, and the agent still starts', () => {
    const data = scratch()
    expect(agentTmpLaunch('claude', undefined, scratch(), deps(data, { config: () => { throw new Error('unreadable') } }))).toEqual(none)
  })

  it('is a root for what agents drop wherever agents are given it, never on Windows', () => {
    const data = scratch()
    expect(agentTmpRoot(deps(data))).toBe(agentTmpFolder(data))
    expect(agentTmpRoot(deps(data, { config: () => null }))).toBe(agentTmpFolder(data))
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

  it('refuses a link in its place, and the agent falls back to the system\'s folder with nothing added, saying so', () => {
    const data = scratch(), elsewhere = scratch()
    symlinkSync(elsewhere, agentTmpFolder(data))
    const d = deps(data)
    expect(agentTmpLaunch('claude', undefined, scratch(), d)).toEqual(none)
    expect(agentTmpLaunch('claude', 'agent', scratch(), d)).toEqual(none)
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
    expect(agentTmpLaunch('claude', undefined, null, deps(data, { config: () => null, now: () => LATER }))).toEqual(none)
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
  })

  // Task #4395: each agent's folder is its TMPDIR while it runs, however quiet, as a Buddy's is: what is in it goes after 7
  // days, the folder itself only once it has been empty for 30.
  it('keeps a quiet agent\'s own folder, sweeping what is in it', async () => {
    const data = scratch(), workspace = scratch()
    const mine = agentTmpLaunch('claude', 'agent', workspace, deps(data, { config: () => null })).env.TMPDIR!
    writeFileSync(join(mine, 'stale'), 'x')
    await sweepTmpFolders(agentTmpFolder(data), Date.now() + 8 * DAY)
    expect(existsSync(join(mine, 'stale'))).toBe(false)
    expect(existsSync(mine)).toBe(true)
    await sweepTmpFolders(agentTmpFolder(data), Date.now() + 31 * DAY)
    expect(existsSync(mine)).toBe(false)
    // Its next launch makes it again.
    expect(agentTmpLaunch('claude', 'agent', workspace, deps(data, { config: () => null })).env.TMPDIR).toBe(mine)
    expect(existsSync(mine)).toBe(true)
  })

  it('sweeps from a launch at most once a day', async () => {
    const data = scratch(), folder = agentTmpFolder(data)
    let now = LATER - DAY - 1
    const d = deps(data, { now: () => now })
    agentTmpLaunch('claude', undefined, null, d)
    writeFileSync(join(folder, 'stale'), 'x')
    // The day's sweep already ran: this launch starts none, though the file's 7 days are nearly up.
    now = LATER - DAY / 2
    agentTmpLaunch('claude', undefined, null, d)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(folder, 'stale'))).toBe(true)
    now = LATER
    agentTmpLaunch('claude', undefined, null, d)
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
    expect(await sweepTmpFolders(buddyTmpParent(data), later)).toBe(1)
    expect(existsSync(join(folder, 'stale'))).toBe(false)
    expect(existsSync(join(folder, 'fresh'))).toBe(true)
    expect(existsSync(folder)).toBe(true)
  })

  it('removes a Buddy\'s folder only when empty and idle for 30 days', async () => {
    const data = dataIn(), folder = buddyTmpOf('/work/one', deps(data))!
    await sweepTmpFolders(buddyTmpParent(data), Date.now() + 8 * DAY)
    expect(existsSync(folder)).toBe(true)
    await sweepTmpFolders(buddyTmpParent(data), Date.now() + 31 * DAY)
    expect(existsSync(folder)).toBe(false)
  })

  it('sweeps nothing through a link, in the parent\'s place or among the Buddies\' folders', async () => {
    const data = dataIn(), target = scratch()
    writeFileSync(join(target, 'kept'), 'x')
    mkdirSync(buddyTmpParent(data), { recursive: true, mode: 0o700 })
    symlinkSync(target, join(buddyTmpParent(data), 'link'))
    await sweepTmpFolders(buddyTmpParent(data), Date.now() + 40 * DAY)
    expect(existsSync(join(target, 'kept'))).toBe(true)
    const other = join(scratch(), 'parent')
    symlinkSync(target, other)
    expect(await sweepTmpFolders(other, Date.now() + 40 * DAY)).toBe(0)
    expect(existsSync(join(target, 'kept'))).toBe(true)
  })

  it('is swept by a launch, with the Team account gone too', async () => {
    const data = dataIn(), folder = buddyTmpOf('/work/one', deps(data))!
    writeFileSync(join(folder, 'stale'), 'x')
    resetAgentTmpSweep()
    agentTmpLaunch('claude', undefined, null, deps(data, { config: () => null, now: () => Date.now() + 8 * DAY }))
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
  })
})

describe('a script written to the folder runs as it would in the system\'s', () => {
  // The data folder is under ~/.harness/cli, whose package.json says "type": "module". An extensionless script a spec wrote
  // to TMPDIR (the fake grid) loaded as an ES module and died on require, so specs failed for agents and passed in CI (#4356).
  const DAY = 24 * 60 * 60_000
  const inModulePackage = () => { const root = scratch(); writeFileSync(join(root, 'package.json'), '{"type":"module"}'); return join(root, 'data') }
  const runs = (folder: string) => {
    const script = join(folder, 'fake-grid')
    writeFileSync(script, "#!/usr/bin/env node\nconst { join } = require('node:path')\nprocess.stdout.write(join('a', 'b'))\n")
    return execFileSync(process.execPath, [script], { encoding: 'utf8' })
  }

  it('an extensionless require() script in an agent\'s folder runs', () => {
    expect(runs(agentTmpLaunch('claude', undefined, null, deps(inModulePackage())).env.TMPDIR!)).toBe(join('a', 'b'))
  })

  // Task #4395: each Swarm agent's own folder is in the shared parent, whose marker covers it.
  it('in a Swarm agent\'s own folder too, by the marker in their parent', () => {
    const data = inModulePackage()
    const folder = agentTmpLaunch('claude', 'agent', scratch(), deps(data, { config: () => null })).env.TMPDIR!
    expect(runs(folder)).toBe(join('a', 'b'))
    expect(existsSync(join(folder, 'package.json'))).toBe(false)
    expect(existsSync(join(agentTmpFolder(data), 'package.json'))).toBe(true)
  })

  it('in a Buddy\'s folder too', () => {
    expect(runs(buddyTmpOf('/work/one', deps(inModulePackage()))!)).toBe(join('a', 'b'))
  })

  it('keeps a package.json already there', () => {
    const data = inModulePackage(), folder = agentTmpFolder(data)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, 'package.json'), '{"type":"commonjs","name":"kept"}')
    agentTmpLaunch('claude', undefined, null, deps(data))
    expect(readFileSync(join(folder, 'package.json'), 'utf8')).toContain('kept')
  })

  it('no sweep deletes the folders\' own package.json however old; a tool\'s goes like any file', async () => {
    const data = inModulePackage(), folder = agentTmpFolder(data), parent = buddyTmpParent(data)
    agentTmpLaunch('claude', undefined, null, deps(data))
    const buddy = buddyTmpOf('/work/one', deps(data))!
    writeFileSync(join(buddy, 'package.json'), '{"type":"module"}')
    const later = Date.now() + 8 * DAY
    expect(await sweepTmpFolders(folder, later)).toBe(0)
    expect(await sweepTmpFolders(parent, later)).toBe(1)
    expect(existsSync(join(folder, 'package.json'))).toBe(true)
    expect(existsSync(join(parent, 'package.json'))).toBe(true)
    expect(existsSync(join(buddy, 'package.json'))).toBe(false)
  })
})
