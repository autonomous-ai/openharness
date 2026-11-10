import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isOldTeamAccount } from './bootGuard.js'

describe('whether this process is an old Team account', () => {
  const config = (user: unknown) => () => JSON.stringify({ version: 1, user })
  it('is the account the root-owned config names, on each platform', () => {
    expect(isOldTeamAccount('darwin', config('harnessteam'), () => 'harnessteam')).toBe(true)
    expect(isOldTeamAccount('linux', config('harnessteam'), () => 'harnessteam')).toBe(true)
    // Windows' names are not case-sensitive.
    expect(isOldTeamAccount('win32', config('harnessteam'), () => 'HarnessTeam')).toBe(true)
  })

  it('is not the owner, nor anyone where there is no config, one that cannot be read, or no name to compare', () => {
    expect(isOldTeamAccount('darwin', config('harnessteam'), () => 'ken')).toBe(false)
    expect(isOldTeamAccount('darwin', () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }) }, () => 'harnessteam')).toBe(false)
    expect(isOldTeamAccount('darwin', () => 'not json', () => 'harnessteam')).toBe(false)
    expect(isOldTeamAccount('darwin', config(''), () => '')).toBe(false)
    expect(isOldTeamAccount('darwin', config(7), () => 'harnessteam')).toBe(false)
    expect(isOldTeamAccount('darwin', config('harnessteam'), () => { throw new Error('no passwd entry') })).toBe(false)
    expect(isOldTeamAccount('freebsd', config('harnessteam'), () => 'harnessteam')).toBe(false)
  })

  it('reads this platform\'s config', () => {
    const read: string[] = []
    isOldTeamAccount('linux', (path) => { read.push(path); return '{}' }, () => 'x')
    expect(read).toEqual(['/etc/harness/team.json'])
  })
})

/**
 * What an old Team account's boot job runs, through the bundle's entry, with the Team config it would see (a preload,
 * ./__fixtures__/asOldTeamAccount.mjs). Since #3771 its `team __start` is no command, and since its Team code went its daemon
 * would run as any other, beside the owner's: every command ends at once, exit 0, saying nothing and making nothing.
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
  ])('ends %s at once, exit 0, saying nothing and making nothing', (_name, args) => {
    const dir = home()
    const run = spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: envIn(dir, true) })
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(readdirSync(dir)).toEqual([])
  }, 60_000)

  // The LaunchDaemon's and the systemd unit's own line (team/script.ts TEAM_JOB_WRAPPER before #3771): its log stays empty.
  it.skipIf(process.platform === 'win32')('runs its Mac and Linux job line to a clean stop with nothing in its log', () => {
    const dir = home(), log = join(dir, 'harness.log')
    const wrapper = '"$1" "$2" team __start "$3" >>"$4" 2>&1; exec "$1" "$2" __harnessd >>"$4" 2>&1'
    const run = spawnSync('/bin/sh', ['-c', wrapper, 'harness-team', process.execPath, ENTRY, join(dir, 'team-handoff'), log],
      { encoding: 'utf8', timeout: 60_000, env: envIn(dir, true) })
    expect(run.status).toBe(0)
    expect(readFileSync(log, 'utf8')).toBe('')
    expect(readdirSync(dir)).toEqual(['harness.log'])
  }, 90_000)

  it('is what ends them: the owner\'s `team __start` is an unknown command', () => {
    const dir = home()
    const run = spawnSync(process.execPath, [ENTRY, 'team', '__start', '/x'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: envIn(dir, false) })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Unknown command: team')
  }, 60_000)
})
