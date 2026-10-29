import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validCreationId } from '../lib/agentCreationReceipt.js'
import type { TeamConfig } from './config.js'
import type { TeamStatus } from './privacy.js'
import {
  readLastTry, refreshCreationId, refreshTeamAccount, TEAM_REFRESH_RETRY_MS, teamBuildStale, writeLastTry, type TeamRefreshDeps,
} from './refresh.js'

const config = { node: '/Users/harnessteam/.harness/runtime/node/bin/node', cli: '/Users/harnessteam/.harness/cli/cli.js',
  home: '/Users/harnessteam', statusFile: '/status.json' } as TeamConfig
const signedOut = (checkedAt: number, relayed = false): TeamStatus => ({ version: 1,
  engines: { checkedAt, claude: { installed: true, signedIn: false, ...(relayed ? { relayed } : {}) }, codex: { installed: true, signedIn: false } } }) as TeamStatus
const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function deps(over: Partial<TeamRefreshDeps> = {}) {
  let last: number | null = null
  const d: TeamRefreshDeps = {
    config: () => config, status: () => signedOut(2_000), publishedAt: () => 1_000,
    machines: async () => [{ machineId: 'mac', sessionKind: 'computer' }, { machineId: 'team', sessionKind: 'team', hostMachineId: 'mac' },
      { machineId: 'other-team', sessionKind: 'team', hostMachineId: 'other' }],
    machineId: () => 'mac', run: vi.fn(async () => ({ ok: true })), lastTry: () => last, remember: vi.fn((at: number) => { last = at }),
    now: () => 5_000, log: vi.fn(), ...over,
  }
  return d
}

describe('a Harness Team account on a build too old for its owner\'s subscriptions', () => {
  it('is read from its own report, checked after the relay was published', () => {
    expect(teamBuildStale(signedOut(2_000), 1_000)).toBe(true)
    // Checked before the relay was there, or before any publish: it could not have seen it yet.
    expect(teamBuildStale(signedOut(500), 1_000)).toBe(false)
    expect(teamBuildStale(signedOut(2_000), null)).toBe(false)
    // A build that knows the relay says so; one engine signed in itself is ready.
    expect(teamBuildStale(signedOut(2_000, true), 1_000)).toBe(false)
    const one = signedOut(2_000); one.engines!.codex.signedIn = true
    expect(teamBuildStale(one, 1_000)).toBe(false)
    const none = signedOut(2_000); none.engines!.claude.installed = false; none.engines!.codex.installed = false
    expect(teamBuildStale(none, 1_000)).toBe(false)
    expect(teamBuildStale(null, 1_000)).toBe(false)
  })

  it('is updated by its owner\'s daemon, as itself, over the link to its own machine; once a day', async () => {
    const d = deps()
    await refreshTeamAccount(d)
    expect(d.run).toHaveBeenCalledWith('team', [config.node, config.cli, 'update', '--force'], '/Users/harnessteam')
    expect(d.remember).toHaveBeenCalledWith(5_000)
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('updating it'))
    await refreshTeamAccount(d)
    expect(d.run).toHaveBeenCalledOnce()
    await refreshTeamAccount({ ...d, now: () => 5_000 + TEAM_REFRESH_RETRY_MS })
    expect(d.run).toHaveBeenCalledTimes(2)
  })

  it('on Windows, runs the build the team account\'s own cli\\current names, which only that account can read', async () => {
    // The version folder setup laid down may be gone: the Windows updater writes new ones and prunes old ones.
    const windows = { node: 'C:\\Users\\harnessteam\\.harness\\runtime\\node-v22.23.2-win32-x64\\node.exe',
      cli: 'C:\\Users\\harnessteam\\.harness\\cli\\0.4.97\\cli.js', home: 'C:\\Users\\harnessteam', statusFile: 'C:\\s.json' } as TeamConfig
    const d = deps({ config: () => windows, platform: 'win32' })
    await refreshTeamAccount(d)
    // Separate words, none with a space or a quote, so the spawn joins them as cmd.exe reads them back.
    expect(d.run).toHaveBeenCalledWith('team', ['cmd.exe', '/d', '/v:on', '/c', 'set', '/p', 'V=<C:\\Users\\harnessteam\\.harness\\cli\\current', '&',
      windows.node, 'C:\\Users\\harnessteam\\.harness\\cli\\!V!\\cli.js', 'update', '--force'], 'C:\\Users\\harnessteam')
    // A path with a space could not be passed so: it is said, and nothing runs.
    const spaced = deps({ config: () => ({ ...windows, home: 'C:\\Users\\Harness Team' }), platform: 'win32' })
    await refreshTeamAccount(spaced)
    expect(spaced.run).not.toHaveBeenCalled()
    expect(spaced.log).toHaveBeenCalledWith(expect.stringContaining('could not update the Harness Team account'))
  })

  it('asks nothing when there is no team account, it is current, or its machine is not this Mac\'s', async () => {
    for (const over of [{ config: () => null }, { status: () => signedOut(2_000, true) }, { machineId: () => 'elsewhere' }] as Array<Partial<TeamRefreshDeps>>) {
      const d = deps(over)
      await refreshTeamAccount(d)
      expect(d.run).not.toHaveBeenCalled()
    }
  })

  it('says why it could not, and never throws', async () => {
    const refused = deps({ run: vi.fn(async () => ({ ok: false, error: 'NO_PEER_LINK' })) })
    await refreshTeamAccount(refused)
    expect(refused.log).toHaveBeenCalledWith(expect.stringContaining('(NO_PEER_LINK); trying again tomorrow'))
    const silent = deps({ run: vi.fn(async () => ({ ok: false })) })
    await refreshTeamAccount(silent)
    expect(silent.log).toHaveBeenCalledWith(expect.stringContaining('(no answer)'))
    const down = deps({ machines: async () => { throw new Error('offline') } })
    await refreshTeamAccount(down)
    expect(down.log).toHaveBeenCalledWith('team: could not update the Harness Team account: offline')
    const odd = deps({ machines: async () => { throw 'odd' } })
    await refreshTeamAccount(odd)
    expect(odd.log).toHaveBeenCalledWith('team: could not update the Harness Team account: odd')
  })

  it('remembers its last try in the daemon\'s own folder, and makes ids the shell takes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-refresh-'))
    cleanup.push(dir)
    const file = join(dir, 'sub', 'team-refresh.json')
    expect(readLastTry(file)).toBeNull()
    writeLastTry(file, 42)
    expect(readLastTry(file)).toBe(42)
    expect(validCreationId(refreshCreationId())).toBe(true)
  })
})
