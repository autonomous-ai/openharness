import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { pmAccountsCommand, type PmAccountsDeps } from './pmAccountsCommand.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const ACCOUNTS = [
  { id: 'default', label: 'Default', email: 'me@x.com', pmMayUse: true, pmHere: ['Mia'], windows: [{ name: '5-hour', leftPercent: 80 }, { name: 'weekly', leftPercent: 40 }] },
  { id: 'abc', label: 'Work', email: 'work@x.com', pmMayUse: false, pmHere: [], windows: [{ name: '5-hour', leftPercent: 3, resetsAt: '2026-11-06T10:00:00Z' }] },
]

function setup(opts: { login?: number; status?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pmacc-'))
  dirs.push(root)
  const bin = join(root, 'claude')
  writeFileSync(bin, `#!/bin/sh
echo "$1 $2 $CLAUDE_CONFIG_DIR" >> "${root}/calls"
if [ "$2" = login ]; then exit ${opts.login ?? 0}; fi
exit ${opts.status ?? 0}
`)
  chmodSync(bin, 0o755)
  const out: string[] = [], err: string[] = [], requests: Array<[string, Record<string, unknown>]> = [], linked: string[] = []
  const deps = (argv: string[]): PmAccountsDeps => ({
    argv, home: root, claudeBin: bin, env: {},
    request: async (type, payload) => {
      requests.push([type, payload])
      if (type === 'pm_accounts_list') return { accounts: ACCOUNTS }
      if (type === 'pm_accounts_history') return { moves: [
        { at: 1000, pm: 'Mia', from: 'default', to: 'abc', why: 'low', awayMs: 5000, ok: true },
        { at: 2000, pm: 'Leo', from: 'abc', to: 'default', why: 'out', ok: false }] }
      return { pool: [] }
    },
    link: folder => { linked.push(folder); return { profile: { id: 'new1', label: 'Claude 3' } as never } },
    output: l => out.push(l), error: l => err.push(l),
  })
  return { root, deps, out, err, requests, linked, calls: () => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : '' }
}
const folders = (root: string) => { try { return readdirSync(join(root, '.harness', 'claude-profiles')) } catch { return [] } }

const before = process.listenerCount('SIGINT')
describe('harness pm accounts', () => {
  it('lists both windows, PM may use and PM here', async () => {
    const t = setup()
    expect(await pmAccountsCommand(t.deps([]))).toBe(0)
    const text = t.out.join('\n')
    expect(text).toContain('80%')
    expect(text).toContain('40%')
    expect(text).toMatch(/Default.*yes.*Mia/)
    expect(text).toMatch(/Work.*3% \(back .*\).*no/)
  })

  it('add creates the folder, logs in with CLAUDE_CONFIG_DIR, links and ticks', async () => {
    const t = setup()
    expect(await pmAccountsCommand(t.deps(['add']))).toBe(0)
    const [folder] = folders(t.root)
    const path = join(t.root, '.harness', 'claude-profiles', folder!)
    expect(t.calls()).toContain(`auth login ${path}`)
    expect(t.calls()).toContain(`auth status ${path}`)
    expect(t.linked).toEqual([path])
    expect(t.requests).toContainEqual(['pm_accounts_use', { ids: ['new1'], on: true }])
  })

  it('add --no-use does not tick', async () => {
    const t = setup()
    expect(await pmAccountsCommand(t.deps(['add', '--no-use']))).toBe(0)
    expect(t.requests.some(r => r[0] === 'pm_accounts_use')).toBe(false)
  })

  it('a failed login removes the folder, links nothing and exits non-zero', async () => {
    const t = setup({ login: 1 })
    expect(await pmAccountsCommand(t.deps(['add']))).toBe(1)
    expect(folders(t.root)).toEqual([])
    expect(t.linked).toEqual([])
    expect(t.requests).toEqual([])
    expect(t.err.join(' ')).toContain('Nothing was added')
  })

  it('a login that leaves no signed-in account is undone the same way', async () => {
    const t = setup({ status: 1 })
    expect(await pmAccountsCommand(t.deps(['add']))).toBe(1)
    expect(folders(t.root)).toEqual([])
    expect(t.linked).toEqual([])
  })

  it('use resolves an email to its id; --off unticks', async () => {
    const t = setup()
    expect(await pmAccountsCommand(t.deps(['use', 'WORK@x.com']))).toBe(0)
    expect(await pmAccountsCommand(t.deps(['use', '--off', 'Default']))).toBe(0)
    expect(t.requests).toContainEqual(['pm_accounts_use', { ids: ['abc'], on: true }])
    expect(t.requests).toContainEqual(['pm_accounts_use', { ids: ['default'], on: false }])
  })

  it('use with an unknown account lists the known labels', async () => {
    const t = setup()
    expect(await pmAccountsCommand(t.deps(['use', 'nope']))).toBe(1)
    expect(t.err.join(' ')).toContain('Known accounts: Default, Work')
    expect(t.requests.some(r => r[0] === 'pm_accounts_use')).toBe(false)
  })

  it('history prints newest first and passes --limit', async () => {
    const t = setup()
    expect(await pmAccountsCommand(t.deps(['history', '--limit', '5']))).toBe(0)
    expect(t.requests).toContainEqual(['pm_accounts_history', { limit: 5 }])
    const lines = t.out.join('\n')
    expect(lines.indexOf('Leo')).toBeLessThan(lines.indexOf('Mia'))
    expect(lines).toContain('5s')
    // Names, not ids; an id nobody lists any more is said so.
    expect(lines).toContain('Work → Default')
    expect(lines).toContain('Default → Work')
    expect(lines).not.toContain('abc')
  })

  it('history says a removed or unknown account plainly', async () => {
    const t = setup()
    const d = t.deps(['history'])
    const request = d.request
    d.request = async (type, payload) => type === 'pm_accounts_history'
      ? { moves: [{ at: 1, pm: 'Mia', from: '', to: '0123456789abcdef', why: 'low', ok: true }] } : request(type, payload)
    await pmAccountsCommand(d)
    expect(t.out.join('\n')).toContain('unknown → a removed account')
  })

  it('a .cmd claude on Windows runs through a shell, with the path quoted and nothing else in the command line', async () => {
    const t = setup()
    const calls: Array<{ file: string; args: string[]; shell: unknown; env: NodeJS.ProcessEnv }> = []
    const spawn = ((file: string, args: string[], options: { shell: unknown; env: NodeJS.ProcessEnv }) => { calls.push({ file, args, shell: options.shell, env: options.env }); return { status: 0, signal: null, stdout: '' } }) as never
    const base = t.deps(['add', '--no-use'])
    expect(await pmAccountsCommand({ ...base, platform: 'win32', claudeBin: 'C:\\Program Files\\claude.cmd', spawn })).toBe(0)
    expect(calls.map(c => [c.file, c.args, c.shell])).toEqual([
      ['"C:\\Program Files\\claude.cmd"', ['auth', 'login'], true], ['"C:\\Program Files\\claude.cmd"', ['auth', 'status'], true]])
    expect(calls[0]!.env.CLAUDE_CONFIG_DIR).toContain('claude-profiles')
    calls.length = 0
    await pmAccountsCommand({ ...base, platform: 'win32', claudeBin: 'C:\\claude.exe', spawn })
    await pmAccountsCommand({ ...base, platform: 'linux', claudeBin: '/x/claude.cmd', spawn })
    expect(calls.map(c => [c.file, c.shell])).toEqual([['C:\\claude.exe', false], ['C:\\claude.exe', false], ['/x/claude.cmd', false], ['/x/claude.cmd', false]])
  })

  it('a signal during the sign-in removes the new folder', async () => {
    const t = setup()
    const spawn = (() => ({ status: null, signal: 'SIGINT', stdout: '' })) as never
    expect(await pmAccountsCommand({ ...t.deps(['add']), spawn })).toBe(130)
    expect(folders(t.root)).toEqual([])
    expect(t.linked).toEqual([])
    expect(t.err.join(' ')).toContain('Cancelled. Nothing was added')
    expect(t.calls()).not.toContain('logout')
  })

  it('Ctrl-C on this process while claude runs removes the folder, and signs out after a finished sign-in', async () => {
    const t = setup()
    let n = 0
    const spawn = (() => { if (++n === 1) process.emit('SIGINT'); return { status: 0, signal: null, stdout: '' } }) as never
    expect(await pmAccountsCommand({ ...t.deps(['add']), spawn })).toBe(130)
    expect(folders(t.root)).toEqual([])
    const late = setup()
    let k = 0
    const second = ((_f: string, args: string[]) => { if (++k === 2) process.emit('SIGTERM'); return { status: 0, signal: null, stdout: '', args } }) as never
    expect(await pmAccountsCommand({ ...late.deps(['add']), spawn: second })).toBe(130)
    expect(folders(late.root)).toEqual([])
    expect(k).toBe(3)
    // The handlers are gone again.
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('a signal in the status check ends it the same way, with a logout', async () => {
    const t = setup()
    let k = 0
    const spawn = (() => ++k === 2 ? { status: null, signal: 'SIGINT', stdout: '' } : { status: 0, signal: null, stdout: '' }) as never
    expect(await pmAccountsCommand({ ...t.deps(['add']), spawn })).toBe(130)
    expect(k).toBe(3)
    expect(folders(t.root)).toEqual([])
  })

  it('a finished sign-in that cannot be used is signed out before its folder goes', async () => {
    const t = setup({ status: 1 })
    expect(await pmAccountsCommand(t.deps(['add']))).toBe(1)
    expect(t.calls()).toMatch(/auth logout .*claude-profiles/)
    expect(folders(t.root)).toEqual([])
    const bad = setup()
    const d = bad.deps(['add'])
    d.link = () => ({ error: 'INVALID_PROFILE' }) as never
    expect(await pmAccountsCommand(d)).toBe(1)
    expect(bad.calls()).toMatch(/auth logout/)
    expect(folders(bad.root)).toEqual([])
    // A sign-in that never finished has nothing to sign out of.
    const none = setup({ login: 1 })
    await pmAccountsCommand(none.deps(['add']))
    expect(none.calls()).not.toContain('logout')
  })

  it('says so when the daemon is not answering', async () => {
    const t = setup()
    const d = t.deps([])
    d.request = async () => { throw new Error('The Harness daemon is not running.') }
    expect(await pmAccountsCommand(d)).toBe(1)
    expect(t.err).toEqual(['The Harness daemon is not running.'])
  })
})
