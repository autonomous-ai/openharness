import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROBE_ANSWER } from '../harnessd/protocol.js'
import { OLD_TEAM_ACCOUNT_LINE, isOldTeamAccount } from './bootGuard.js'

describe('whether this process is an old Team account', () => {
  const config = (user: unknown, version: unknown = 1) => () => JSON.stringify({ version, user })
  it('is the account Team setup made, while the root-owned config names it, on each platform', () => {
    expect(isOldTeamAccount('darwin', config('harnessteam'), () => 'harnessteam')).toBe(true)
    expect(isOldTeamAccount('linux', config('harnessteam'), () => 'harnessteam')).toBe(true)
    // Windows' names are not case-sensitive.
    expect(isOldTeamAccount('win32', config('harnessteam'), () => 'HarnessTeam')).toBe(true)
  })

  // Review of #3806: any account may create C:\ProgramData\Harness on a PC that never had a Team account. A config planted
  // there naming the owner must not stop the owner's Harness, and every other account reads nothing.
  it('is never another account, whatever a config names', () => {
    const read = vi.fn(config('ken'))
    expect(isOldTeamAccount('win32', read, () => 'ken')).toBe(false)
    expect(isOldTeamAccount('darwin', read, () => 'ken')).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it('is not the Team account\'s name without a config that names it, as setup wrote it', () => {
    expect(isOldTeamAccount('darwin', config('someone-else'), () => 'harnessteam')).toBe(false)
    expect(isOldTeamAccount('darwin', config('harnessteam', 2), () => 'harnessteam')).toBe(false)
    expect(isOldTeamAccount('darwin', () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }) }, () => 'harnessteam')).toBe(false)
    expect(isOldTeamAccount('darwin', () => 'not json', () => 'harnessteam')).toBe(false)
    expect(isOldTeamAccount('darwin', config(7), () => 'harnessteam')).toBe(false)
    expect(isOldTeamAccount('darwin', config('harnessteam'), () => { throw new Error('no passwd entry') })).toBe(false)
    expect(isOldTeamAccount('freebsd', config('harnessteam'), () => 'harnessteam')).toBe(false)
  })

  it('reads this platform\'s config', () => {
    const read: string[] = []
    isOldTeamAccount('linux', (path) => { read.push(path); return '{}' }, () => 'harnessteam')
    expect(read).toEqual(['/etc/harness/team.json'])
  })
})

/**
 * What an old Team account's boot job runs, through the bundle's entry, with the Team config it would see (a preload,
 * ./__fixtures__/asOldTeamAccount.mjs, which also names this process `harnessteam`). Since #3771 its `team __start` is no
 * command, and since its Team code went its daemon would run as any other, beside the owner's: every step ends at once, exit 0,
 * with one line for its log and nothing made.
 */
describe('an old Team account\'s boot job', () => {
  const ENTRY = fileURLToPath(new URL('../entry.ts', import.meta.url))
  const LOADER = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))
  const AS_TEAM = fileURLToPath(new URL('./__fixtures__/asOldTeamAccount.mjs', import.meta.url))
  const WINDOWS_ENV = Object.fromEntries(['TEMP', 'TMP', 'SystemRoot'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
  const homes: string[] = []
  afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
  const home = () => { const dir = mkdtempSync(join(tmpdir(), 'old-team-')); homes.push(dir); return dir }
  const envIn = (dir: string, asTeam: boolean) => ({
    ...WINDOWS_ENV, PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, ADAPTER_DATA_DIR: join(dir, 'data'), PORT: '18493',
    NODE_OPTIONS: `--import ${LOADER}${asTeam ? ` --import ${AS_TEAM}` : ''}`,
  })

  it.each([
    ['its first step', ['team', '__start', '/Users/harnessteam/.harness/team-handoff']],
    ['its daemon\'s master', ['__harnessd']],
    ['a core', ['__run']],
    ['a service', ['__service', 'edge']],
  ])('ends %s at once, exit 0, with one line for its log and nothing made', (_name, args) => {
    const dir = home()
    const run = spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: envIn(dir, true) })
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: '', stderr: `${OLD_TEAM_ACCOUNT_LINE}\n` })
    expect(readdirSync(dir)).toEqual([])
  }, 60_000)

  // The LaunchDaemon's and the systemd unit's own line (team/script.ts TEAM_JOB_WRAPPER before #3771): one line a step.
  it.skipIf(process.platform === 'win32')('runs its Mac and Linux job line to a clean stop, its log saying why', () => {
    const dir = home(), log = join(dir, 'harness.log')
    const wrapper = '"$1" "$2" team __start "$3" >>"$4" 2>&1; exec "$1" "$2" __harnessd >>"$4" 2>&1'
    const run = spawnSync('/bin/sh', ['-c', wrapper, 'harness-team', process.execPath, ENTRY, join(dir, 'team-handoff'), log],
      { encoding: 'utf8', timeout: 60_000, env: envIn(dir, true) })
    expect(run.status).toBe(0)
    expect(readFileSync(log, 'utf8')).toBe(`${OLD_TEAM_ACCOUNT_LINE}\n${OLD_TEAM_ACCOUNT_LINE}\n`)
    expect(readdirSync(dir)).toEqual(['harness.log'])
  }, 90_000)

  // Review of #3806: an old Team daemon still running probes a new build before it re-executes on it. A probe that failed
  // would roll this release back, and the account would go on running its old daemon.
  it('lets its running daemon\'s probe of this build through', () => {
    const dir = home()
    const run = spawnSync(process.execPath, [ENTRY, '__harnessd-probe'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: envIn(dir, true) })
    expect(run.stderr).not.toContain(OLD_TEAM_ACCOUNT_LINE)
    expect(run.stdout).toContain(PROBE_ANSWER)
  }, 60_000)

  it('is what ends them: the owner\'s `team __start` is an unknown command', () => {
    const dir = home()
    const run = spawnSync(process.execPath, [ENTRY, 'team', '__start', '/x'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: envIn(dir, false) })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Unknown command: team')
  }, 60_000)
})
