import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentTmpFolder, agentTmpLaunch, agentTmpRoot, prepareAgentTmp, resetAgentTmpSweep, sweepAgentTmp, sweepTmpFolders, type AgentTmpDeps } from './agentTmp.js'

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); resetAgentTmpSweep() })
const scratch = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tmp-'))); made.push(dir); return dir }

const deps = (dataDir: string, over: Partial<AgentTmpDeps> = {}): AgentTmpDeps => ({
  platform: 'darwin', dataDir, log: vi.fn(), now: () => 1_000_000_000_000, ...over,
})

const none = { env: {}, args: [] }

describe('who gets the private temporary folder', () => {
  // Task #4395: since #4215 an agent starts in its owner's own settings, which on the Mac Studio block reads outside the working
  // directories, and since v3 there is no Team computer, so agents used the system's folder and stopped at Claude Code's
  // question for their own mktemp file (Authorder, 11-07). Each Swarm agent gets a folder of its own, added to Claude Code's
  // working directories: Claude Code reads an added folder's own skills and settings, so one shared folder would let an
  // agent plant them for the others.
  it('a Swarm agent: a 0700 folder of its own as TMPDIR, added to Claude Code\'s working directories', () => {
    const data = scratch()
    const launch = agentTmpLaunch('claude', { role: 'agent', key: 'one' }, deps(data))
    const folder = launch.env.TMPDIR!
    expect(folder.startsWith(`${realpathSync(agentTmpFolder(data))}/`)).toBe(true)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(statSync(agentTmpFolder(data)).mode & 0o777).toBe(0o700)
    // Joined to its flag: Claude Code's takes several values and would swallow what follows it.
    expect(launch).toEqual({ env: { TMPDIR: folder }, args: [`--add-dir=${folder}`] })
    // Codex gets it as its TMPDIR alone: its --add-dir made codex-cli 0.164 quit in an untrusted folder (agentTmp.ts ADDED_FOLDER).
    expect(agentTmpLaunch('codex', { role: 'coordinator', key: 'one' }, deps(data, { platform: 'linux' })))
      .toEqual({ env: { TMPDIR: folder }, args: [] })
    // The same agent's relaunch finds the same folder; another agent has its own, in the same workspace too: a person's
    // Regular agents all start in that person's home folder (security review of #3506). On a Mac too, only that folder is
    // added, never the account's own temporary folder, which every agent and app of the account shares.
    const another = agentTmpLaunch('claude', { role: 'agent', key: 'two' }, deps(data)).env.TMPDIR
    expect(another).not.toBe(folder)
    expect(another!.startsWith(`${realpathSync(agentTmpFolder(data))}/`)).toBe(true)
  })

  it('an engine that takes no such folder gets the folder alone', () => {
    const data = scratch()
    const launch = agentTmpLaunch('opencode', { role: 'agent', key: 'one' }, deps(data))
    expect(launch.args).toEqual([])
    expect(launch.env.TMPDIR!.startsWith(`${realpathSync(agentTmpFolder(data))}/`)).toBe(true)
  })

  it('nobody else gets an added folder: a terminal; a person\'s own session; Windows', () => {
    const data = scratch()
    expect(agentTmpLaunch('terminal', { role: 'agent', key: 'one' }, deps(data))).toEqual(none)
    expect(agentTmpLaunch('claude', undefined, deps(data))).toEqual(none)
    expect(agentTmpLaunch('claude', { role: 'agent', key: 'one' }, deps(data, { platform: 'win32' }))).toEqual(none)
    expect(existsSync(agentTmpFolder(data))).toBe(false)
  })

  it('is a root for what agents drop wherever agents are given it, never on Windows', () => {
    const data = scratch()
    expect(agentTmpRoot(deps(data))).toBe(agentTmpFolder(data))
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

  it('refuses a link in its place, and the agent falls back to the system\'s folder with nothing added, saying so', () => {
    const data = scratch(), elsewhere = scratch()
    symlinkSync(elsewhere, agentTmpFolder(data))
    const d = deps(data)
    expect(agentTmpLaunch('claude', undefined, d)).toEqual(none)
    expect(agentTmpLaunch('claude', { role: 'agent', key: 'one' }, d)).toEqual(none)
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

  it('is swept by a launch, whoever launches', async () => {
    const data = scratch(), folder = agentTmpFolder(data)
    mkdirSync(folder, { mode: 0o700 })
    writeFileSync(join(folder, 'stale'), 'x')
    expect(agentTmpLaunch('claude', undefined, deps(data, { now: () => LATER }))).toEqual(none)
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
  })

  // Task #4395: each agent's folder is its TMPDIR while it runs, however quiet: what is in it goes after 7
  // days, the folder itself only once it has been empty for 30.
  it('keeps a quiet agent\'s own folder, sweeping what is in it', async () => {
    const data = scratch()
    const mine = agentTmpLaunch('claude', { role: 'agent', key: 'one' }, deps(data)).env.TMPDIR!
    writeFileSync(join(mine, 'stale'), 'x')
    await sweepTmpFolders(agentTmpFolder(data), Date.now() + 8 * DAY)
    expect(existsSync(join(mine, 'stale'))).toBe(false)
    expect(existsSync(mine)).toBe(true)
    await sweepTmpFolders(agentTmpFolder(data), Date.now() + 31 * DAY)
    expect(existsSync(mine)).toBe(false)
    // Its next launch makes it again.
    expect(agentTmpLaunch('claude', { role: 'agent', key: 'one' }, deps(data)).env.TMPDIR).toBe(mine)
    expect(existsSync(mine)).toBe(true)
  })

  it('sweeps from a launch at most once a day', async () => {
    const data = scratch(), folder = agentTmpFolder(data)
    let now = LATER - DAY - 1
    const d = deps(data, { now: () => now })
    agentTmpLaunch('claude', undefined, d)
    mkdirSync(folder, { mode: 0o700 })
    writeFileSync(join(folder, 'stale'), 'x')
    // The day's sweep already ran: this launch starts none, though the file's 7 days are nearly up.
    now = LATER - DAY / 2
    agentTmpLaunch('claude', undefined, d)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(folder, 'stale'))).toBe(true)
    now = LATER
    agentTmpLaunch('claude', undefined, d)
    await vi.waitFor(() => expect(existsSync(join(folder, 'stale'))).toBe(false))
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

  // Task #4395: each Swarm agent's own folder is in the shared parent, whose marker covers it.
  it('in a Swarm agent\'s own folder, by the marker in their parent', () => {
    const data = inModulePackage()
    const folder = agentTmpLaunch('claude', { role: 'agent', key: 'one' }, deps(data)).env.TMPDIR!
    expect(runs(folder)).toBe(join('a', 'b'))
    expect(existsSync(join(folder, 'package.json'))).toBe(false)
    expect(existsSync(join(agentTmpFolder(data), 'package.json'))).toBe(true)
  })

  it('keeps a package.json already there', () => {
    const data = inModulePackage(), folder = agentTmpFolder(data)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, 'package.json'), '{"type":"commonjs","name":"kept"}')
    agentTmpLaunch('claude', { role: 'agent', key: 'one' }, deps(data))
    expect(readFileSync(join(folder, 'package.json'), 'utf8')).toContain('kept')
  })

  it('no sweep deletes the folders\' own package.json however old; a tool\'s goes like any file', async () => {
    const data = inModulePackage(), folder = agentTmpFolder(data)
    const own = agentTmpLaunch('claude', { role: 'agent', key: 'one' }, deps(data)).env.TMPDIR!
    writeFileSync(join(own, 'package.json'), '{"type":"module"}')
    const later = Date.now() + 8 * DAY
    expect(await sweepTmpFolders(folder, later)).toBe(1)
    expect(existsSync(join(folder, 'package.json'))).toBe(true)
    expect(existsSync(join(own, 'package.json'))).toBe(false)
  })
})
