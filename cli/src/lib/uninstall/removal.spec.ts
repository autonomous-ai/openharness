import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { finalRemovalDeps, finalRemovalScript, listEntries, removalPlan, removeNow, scheduleFinalRemoval, type FinalRemovalDeps, type PlanInput, type RemovalPlan, type RootEntry } from './removal.js'

const d = (name: string): RootEntry => ({ name, dir: true })
const f = (name: string): RootEntry => ({ name, dir: false })
const mac = { platform: 'darwin' as const, root: '/u/.harness', cliDir: '/u/.harness/cli', dataDir: '/u/.harness/cli/data' }
const entries = [d('auth'), d('bin'), d('cli'), f('computer-id'), d('desktop-app-v2'), d('dsh'), d('runtime'), d('pty'), d('tui')]
const cliEntries = [f('cli.js'), f('notify.mjs'), f('package.json'), d('data')]

/** Whether this account can make a file symlink: on Windows a standard user without Developer Mode cannot. */
function canLinkFiles(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'removal-probe-'))
  try { writeFileSync(join(dir, 'f'), ''); symlinkSync(join(dir, 'f'), join(dir, 'l'), 'file'); return true } catch { return false } finally { rmSync(dir, { recursive: true, force: true }) }
}
const fileLinks = canLinkFiles()

describe('removalPlan', () => {
  it('takes the whole root but the desktop app\'s own state', () => {
    const plan = removalPlan({ ...mac, entries, cliEntries, keepData: false })
    expect(plan.remove.map((t) => t.path)).toEqual(['auth', 'bin', 'cli', 'computer-id', 'dsh', 'runtime', 'pty', 'tui'].map((n) => `/u/.harness/${n}`))
    expect(plan.kept).toEqual(['desktop-app-v2'])
    expect(plan.removeRoot).toBe(false)
    expect(removalPlan({ ...mac, entries: entries.filter((e) => e.name !== 'desktop-app-v2'), cliEntries, keepData: false }).removeRoot).toBe(true)
  })

  it('with --keep-data takes the program only', () => {
    const plan = removalPlan({ ...mac, entries, cliEntries, keepData: true })
    expect(plan.remove).toEqual([
      { path: '/u/.harness/bin', dir: true }, { path: '/u/.harness/runtime', dir: true }, { path: '/u/.harness/pty', dir: true },
      { path: '/u/.harness/cli/cli.js', dir: false }, { path: '/u/.harness/cli/notify.mjs', dir: false }, { path: '/u/.harness/cli/package.json', dir: false },
    ])
    expect(plan.kept).toEqual(['auth', 'computer-id', 'desktop-app-v2', 'dsh', 'tui', 'cli/data'])
    expect(plan.removeRoot).toBe(false)
  })

  it('uses Windows paths for a Windows root, version folders and pointers included', () => {
    const plan = removalPlan({
      platform: 'win32', root: 'C:\\Users\\u\\.harness', cliDir: 'C:\\Users\\u\\.harness\\cli', dataDir: 'C:\\Users\\u\\.harness\\cli\\data',
      entries: [d('bin'), d('cli'), d('runtime')], cliEntries: [d('0.5.1'), d('0.5.2'), f('current'), f('notify.mjs'), d('data')], keepData: true,
    })
    expect(plan.remove.map((t) => t.path)).toEqual([
      'C:\\Users\\u\\.harness\\bin', 'C:\\Users\\u\\.harness\\runtime', 'C:\\Users\\u\\.harness\\cli\\0.5.1',
      'C:\\Users\\u\\.harness\\cli\\0.5.2', 'C:\\Users\\u\\.harness\\cli\\current', 'C:\\Users\\u\\.harness\\cli\\notify.mjs',
    ])
    expect(plan.kept).toEqual(['cli\\data'])
  })

  it('leaves a CLI folder that is not the product root\'s (ADAPTER_CLI_DIR set elsewhere)', () => {
    const plan = removalPlan({ ...mac, cliDir: '/opt/harness-cli', entries: [d('bin'), d('auth')], cliEntries, keepData: true })
    expect(plan.remove.map((t) => t.path)).toEqual(['/u/.harness/bin'])
  })
})

describe('removalPlan refuses a root that is not a .harness folder of its own', () => {
  const plan = (root: string, platform: NodeJS.Platform = 'darwin', home?: string) =>
    () => removalPlan({ platform, root, home, cliDir: `${root}/cli`, dataDir: `${root}/cli/data`, entries: [d('bin')], cliEntries: [], keepData: false })

  it('an empty root', () => {
    expect(plan('')).toThrow(/Harness will not remove/)
    expect(plan('   ')).toThrow(/Harness will not remove/)
    expect(plan('', 'win32')).toThrow(/Harness will not remove/)
  })

  it('a drive root, a share root or the file system root', () => {
    expect(plan('/')).toThrow(/Harness will not remove/)
    expect(plan('C:\\', 'win32')).toThrow(/Harness will not remove/)
    expect(plan('C:', 'win32')).toThrow(/Harness will not remove/)
    expect(plan('\\\\server\\share\\', 'win32')).toThrow(/Harness will not remove/)
  })

  it('the person\'s home, and a root their home is inside', () => {
    expect(plan('/u/.harness', 'darwin', '/u/.harness')).toThrow(/home/)
    expect(plan('/u/.harness', 'darwin', '/u/.harness/me')).toThrow(/home/)
    expect(plan('C:\\Users\\.harness', 'win32', 'c:\\users\\.HARNESS')).toThrow(/home/)
    expect(plan('C:\\Users\\.harness', 'win32', 'C:\\Users\\.harness\\u')).toThrow(/home/)
    expect(plan('/u/.harness', 'darwin', '/u')).not.toThrow()
  })

  it('a path with .. in it, even one that would end inside a .harness', () => {
    expect(plan('/u/x/../.harness')).toThrow(/Harness will not remove/)
    expect(plan('/u/.harness/..')).toThrow(/Harness will not remove/)
    expect(plan('C:\\Users\\u\\..\\.harness', 'win32')).toThrow(/Harness will not remove/)
    expect(plan('C:\\Users\\u\\...\\.harness', 'win32')).toThrow(/Harness will not remove/)
  })

  it('a folder not named .harness', () => {
    expect(plan('/u/harness')).toThrow(/\.harness/)
    expect(plan('/u/.harness-old')).toThrow(/\.harness/)
    expect(plan('/u/.harness/cli')).toThrow(/\.harness/)
    expect(plan('C:\\Users\\u', 'win32')).toThrow(/\.harness/)
    expect(plan('C:\\Users\\u\\.harness.', 'win32')).toThrow(/\.harness/)
  })

  it('a relative path, a drive-relative one, a device path, and one with a quote or a line break', () => {
    expect(plan('.harness')).toThrow(/Harness will not remove/)
    expect(plan('u/.harness')).toThrow(/Harness will not remove/)
    expect(plan('\\Users\\u\\.harness', 'win32')).toThrow(/Harness will not remove/)
    expect(plan('C:Users\\u\\.harness', 'win32')).toThrow(/Harness will not remove/)
    expect(plan('\\\\?\\C:\\Users\\u\\.harness', 'win32')).toThrow(/Harness will not remove/)
    expect(plan('\\\\.\\C:\\Users\\u\\.harness', 'win32')).toThrow(/Harness will not remove/)
    expect(plan('C:\\Users\\a"b\\.harness', 'win32')).toThrow(/Harness will not remove/)
    expect(plan('/u\n/.harness')).toThrow(/Harness will not remove/)
  })

  it('takes a Windows .harness of any case, and a trailing separator', () => {
    expect(plan('C:\\Users\\u\\.Harness', 'win32')).not.toThrow()
    expect(plan('C:\\Users\\u\\.harness\\', 'win32')).not.toThrow()
    expect(plan('/u/.harness/')).not.toThrow()
  })

  it('an entry whose name would reach outside the root', () => {
    const base = { ...mac, cliEntries: [], keepData: false }
    for (const name of ['', '.', '..', 'a/b', '../x']) expect(() => removalPlan({ ...base, entries: [d(name)] }), name).toThrow(/Harness will not remove/)
    const win = { platform: 'win32' as const, root: 'C:\\U\\.harness', cliDir: 'C:\\U\\.harness\\cli', dataDir: 'C:\\U\\.harness\\cli\\data', cliEntries: [], keepData: false }
    for (const name of ['a\\b', 'bin.', 'bin ', 'x:stream', '...', 'a"b']) expect(() => removalPlan({ ...win, entries: [d(name)] }), name).toThrow(/Harness will not remove/)
    expect(() => removalPlan({ ...mac, keepData: true, entries: [d('cli')], cliEntries: [f('../../etc')] })).toThrow(/Harness will not remove/)
  })

  it('names only paths strictly inside the root', () => {
    const p = removalPlan({ ...mac, entries, cliEntries, keepData: false })
    for (const t of p.remove) expect(t.path.startsWith('/u/.harness/')).toBe(true)
  })
})

describe('removalPlan with --keep-data keeps the person\'s data', () => {
  it('keeps cli\\data of any case on Windows', () => {
    const plan = removalPlan({
      platform: 'win32', root: 'C:\\Users\\u\\.harness', cliDir: 'C:\\Users\\U\\.HARNESS\\cli', dataDir: 'c:\\users\\u\\.harness\\CLI\\Data',
      entries: [d('auth'), d('bin'), d('cli')], cliEntries: [d('0.5.1'), d('data')], keepData: true,
    })
    expect(plan.remove.map((t) => t.path)).toEqual(['C:\\Users\\u\\.harness\\bin', 'C:\\Users\\U\\.HARNESS\\cli\\0.5.1'])
    expect(plan.kept).toEqual(['auth', 'cli\\data'])
  })

  it('keeps an entry the data folder is inside, and everything when the data is the CLI folder itself', () => {
    const nested = removalPlan({ ...mac, dataDir: '/u/.harness/cli/data/v2', entries: [d('bin'), d('cli')], cliEntries: [d('data'), f('cli.js')], keepData: true })
    expect(nested.remove.map((t) => t.path)).toEqual(['/u/.harness/bin', '/u/.harness/cli/cli.js'])
    expect(nested.kept).toEqual(['cli/data'])
    const inBin = removalPlan({ ...mac, dataDir: '/u/.harness/bin/data', entries: [d('bin'), d('runtime')], cliEntries: [], keepData: true })
    expect(inBin.remove.map((t) => t.path)).toEqual(['/u/.harness/runtime'])
    const whole = removalPlan({ ...mac, dataDir: '/u/.harness/cli', entries: [d('bin'), d('cli')], cliEntries: [f('cli.js'), d('sessions')], keepData: true })
    expect(whole.remove.map((t) => t.path)).toEqual(['/u/.harness/bin'])
  })
})

describe('removeNow', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  const home = () => { const dir = mkdtempSync(join(tmpdir(), 'removal-')); dirs.push(dir); return dir }
  const planOf = (root: string, keepData = false, extra: Partial<PlanInput> = {}) => removalPlan({
    platform: process.platform, root, cliDir: join(root, 'cli'), dataDir: join(root, 'cli', 'data'), entries: listEntries(root), cliEntries: listEntries(join(root, 'cli')), keepData, ...extra,
  })

  it('removes the plan and the root, and says what is left', () => {
    const root = join(home(), '.harness')
    mkdirSync(join(root, 'cli', 'data'), { recursive: true })
    writeFileSync(join(root, 'cli', 'cli.js'), '')
    writeFileSync(join(root, 'computer-id'), 'x')
    const plan = removalPlan({ platform: process.platform, root, cliDir: join(root, 'cli'), dataDir: join(root, 'cli', 'data'), entries: listEntries(root), cliEntries: listEntries(join(root, 'cli')), keepData: false })
    expect(removeNow(plan)).toEqual([])
    expect(existsSync(root)).toBe(false)
  })

  it('with --keep-data leaves cli/data and the rest of the person\'s data', () => {
    const root = join(home(), '.harness')
    mkdirSync(join(root, 'cli', 'data', 'sessions'), { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(root, 'auth'), { recursive: true })
    writeFileSync(join(root, 'cli', 'data', 'sessions', 's.json'), 's')
    writeFileSync(join(root, 'auth', 'session.json'), 'a')
    writeFileSync(join(root, 'cli', 'cli.js'), '')
    writeFileSync(join(root, 'bin', 'harness'), '')
    expect(removeNow(planOf(root, true))).toEqual([])
    expect(readFileSync(join(root, 'cli', 'data', 'sessions', 's.json'), 'utf8')).toBe('s')
    expect(readFileSync(join(root, 'auth', 'session.json'), 'utf8')).toBe('a')
    expect(existsSync(join(root, 'bin'))).toBe(false)
    expect(existsSync(join(root, 'cli', 'cli.js'))).toBe(false)
  })

  it('removes a link, never what it points to, at the root and deeper', () => {
    const base = home()
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'k')
    const root = join(base, '.harness')
    mkdirSync(join(root, 'cli'), { recursive: true })
    symlinkSync(outside, join(root, 'linked'), 'junction')
    symlinkSync(outside, join(root, 'cli', 'linked'), 'junction')
    const plan = planOf(root)
    expect(plan.remove.find((t) => t.path === join(root, 'linked'))).toEqual({ path: join(root, 'linked'), dir: false, link: true })
    expect(removeNow(plan)).toEqual([])
    expect(existsSync(root)).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('k')
  })

  // Skipped where this account cannot make a file symlink (Windows, a standard user without Developer Mode).
  it.skipIf(!fileLinks)('removes a file link, never the file it points to', () => {
    const base = home()
    writeFileSync(join(base, 'keep.txt'), 'k')
    const root = join(base, '.harness')
    mkdirSync(root)
    symlinkSync(join(base, 'keep.txt'), join(root, 'keep-link'), 'file')
    expect(removeNow(planOf(root))).toEqual([])
    expect(existsSync(root)).toBe(false)
    expect(readFileSync(join(base, 'keep.txt'), 'utf8')).toBe('k')
  })

  it('refuses a root that is itself a link, and touches nothing behind it', () => {
    const base = home()
    const real = join(base, 'real', '.harness')
    mkdirSync(join(real, 'bin'), { recursive: true })
    writeFileSync(join(real, 'bin', 'harness'), 'h')
    const root = join(base, '.harness')
    symlinkSync(real, root, 'junction')
    expect(() => removeNow(planOf(root))).toThrow(/link/)
    expect(readFileSync(join(real, 'bin', 'harness'), 'utf8')).toBe('h')
  })

  it('refuses a plan, however made, that names a path outside its root', () => {
    const base = home()
    const root = join(base, '.harness')
    mkdirSync(root)
    writeFileSync(join(base, 'precious'), 'p')
    const bad: RemovalPlan[] = [
      { root, remove: [{ path: join(base, 'precious'), dir: false }], kept: [], removeRoot: false },
      { root, remove: [{ path: `${root}/../precious`, dir: false }], kept: [], removeRoot: false },
      { root, remove: [{ path: root, dir: true }], kept: [], removeRoot: false },
      { root: base, remove: [{ path: join(base, 'precious'), dir: false }], kept: [], removeRoot: true },
    ]
    for (const plan of bad) expect(() => removeNow(plan)).toThrow(/Harness will not remove/)
    expect(readFileSync(join(base, 'precious'), 'utf8')).toBe('p')
  })

  it('removes the root only when it is empty, never with what the plan did not name', () => {
    const root = join(home(), '.harness')
    mkdirSync(join(root, 'bin'), { recursive: true })
    const plan = planOf(root)
    writeFileSync(join(root, 'arrived-later'), 'x')
    expect(removeNow(plan)).toEqual([root])
    expect(readFileSync(join(root, 'arrived-later'), 'utf8')).toBe('x')
  })
})

describe('finalRemovalScript', () => {
  const plan = {
    root: 'C:\\Users\\u 100%\\.harness', removeRoot: true, kept: [],
    remove: [{ path: 'C:\\Users\\u 100%\\.harness\\bin', dir: true }, { path: 'C:\\Users\\u 100%\\.harness\\cli\\current', dir: false }],
  }
  const script = finalRemovalScript({ pid: 4321, plan, log: 'C:\\T\\harness-uninstall-4321.log', systemRoot: 'C:\\Windows' })

  it('waits for this process, then removes each path and the root, with every % doubled', () => {
    const lines = script.split('\r\n')
    expect(lines[0]).toBe('@echo off')
    expect(lines).toContain('"C:\\Windows\\System32\\tasklist.exe" /FI "PID eq 4321" /NH 2>nul | "C:\\Windows\\System32\\find.exe" " 4321 " >nul')
    expect(lines).toContain('rmdir /s /q "C:\\Users\\u 100%%\\.harness\\bin" 2>nul')
    // A file (or a link) is never given to del as a folder: del on a junction empties the folder it points to.
    expect(lines).toContain('rmdir "C:\\Users\\u 100%%\\.harness\\cli\\current" 2>nul')
    expect(lines).toContain('if not exist "C:\\Users\\u 100%%\\.harness\\cli\\current\\*" del /f /q "C:\\Users\\u 100%%\\.harness\\cli\\current" 2>nul')
    // The root goes only when empty: never with something the plan did not name.
    expect(lines).toContain('rmdir "C:\\Users\\u 100%%\\.harness" 2>nul')
    expect(lines.filter((line) => line.startsWith('rmdir /s'))).toEqual(['rmdir /s /q "C:\\Users\\u 100%%\\.harness\\bin" 2>nul'])
    expect(lines.indexOf(':remove')).toBeGreaterThan(lines.indexOf(':wait'))
  })

  it('waits a bounded time, with delayed expansion off', () => {
    const lines = script.split('\r\n')
    expect(lines[1]).toBe('setlocal DisableDelayedExpansion')
    expect(lines).toContain('if %tries% GEQ 120 goto remove')
  })

  it('refuses at run time a root that has become a link', () => {
    const lines = script.split('\r\n')
    expect(lines).toContain('for %%A in ("C:\\Users\\u 100%%\\.harness") do set "attr=-%%~aA"')
    expect(lines).toContain('if not "%attr%"=="%attr:l=%" goto refused')
    expect(lines.indexOf('if not "%attr%"=="%attr:l=%" goto refused')).toBeLessThan(lines.indexOf(':again'))
    expect(script).toContain(':refused\r\n>"C:\\T\\harness-uninstall-4321.log" echo Harness did not remove C:\\Users\\u 100%%\\.harness')
  })

  it('lists what stayed in its log, escaped for echo, and deletes itself without cmd reading it again', () => {
    expect(script).toContain('if exist "C:\\Users\\u 100%%\\.harness\\bin" >>"C:\\T\\harness-uninstall-4321.log" echo C:\\Users\\u 100%%\\.harness\\bin')
    expect(script.trimEnd().endsWith('(goto) 2>nul & del "%~f0"')).toBe(true)
    const odd = finalRemovalScript({ pid: 1, plan: { root: 'C:\\a&b (x)^!\\.harness', remove: [], kept: [], removeRoot: true }, log: 'C:\\T\\l.log', systemRoot: 'C:\\Windows' })
    expect(odd).toContain('if exist "C:\\a&b (x)^!\\.harness" >>"C:\\T\\l.log" echo C:\\a^&b ^(x^)^^!\\.harness')
  })

  it('refuses a plan with a bad root, a path outside it, a bad pid, or a quote in a path', () => {
    const ok = { pid: 1, log: 'C:\\T\\l.log', systemRoot: 'C:\\Windows' }
    const bad: Array<[RemovalPlan, Partial<typeof ok>]> = [
      [{ ...plan, root: 'C:\\' }, {}],
      [{ ...plan, root: 'C:\\Users\\u' }, {}],
      [{ ...plan, root: 'C:\\Users\\u\\..\\.harness', remove: [] }, {}],
      [{ ...plan, root: '' }, {}],
      [{ ...plan, remove: [{ path: 'C:\\Users\\u 100%\\other', dir: true }] }, {}],
      [{ ...plan, remove: [{ path: 'C:\\Users\\u 100%\\.harness\\..\\..', dir: true }] }, {}],
      [plan, { pid: 0 }],
      [plan, { pid: 1.5 }],
      [plan, { log: 'C:\\T\\a"b.log' }],
      [plan, { systemRoot: 'C:\\Win"dows' }],
    ]
    for (const [p, o] of bad) expect(() => finalRemovalScript({ ...ok, ...o, plan: p })).toThrow(/Harness will not remove/)
    expect(() => finalRemovalScript({ ...ok, plan: { ...plan, root: 'C:\\Users\\u\\.harness', remove: [] }, home: 'C:\\Users\\u\\.harness' })).toThrow(/home/)
  })
})

describe('scheduleFinalRemoval', () => {
  const plan = { root: 'C:\\U\\.harness', remove: [], kept: [], removeRoot: true }
  function deps(overrides: Partial<FinalRemovalDeps> = {}) {
    const written: string[] = []
    const spawned: string[][] = []
    const cwds: string[] = []
    const scripts: Array<Record<string, string>> = []
    const base: FinalRemovalDeps = {
      pid: 77, tempDir: 'C:\\T', systemRoot: 'C:\\Windows', now: () => 1000,
      write: (path) => { written.push(path) },
      powershell: (_script, inputs = {}) => { scripts.push(inputs); return { status: 0, stdout: '', stderr: '' } },
      spawnDetached: (file, args, cwd) => { spawned.push([file, ...args]); cwds.push(cwd) },
      ...overrides,
    }
    return { base, written, spawned, scripts, cwds }
  }

  it('starts cmd.exe through WMI, outside this process\'s job', () => {
    const t = deps()
    expect(scheduleFinalRemoval(plan, t.base)).toEqual({ ok: true, script: 'C:\\T\\harness-uninstall-77-1000.cmd', log: 'C:\\T\\harness-uninstall-77-1000.log', via: 'wmi' })
    expect(t.written).toEqual(['C:\\T\\harness-uninstall-77-1000.cmd'])
    expect(t.scripts[0]).toEqual({ HARNESS_CMD: 'C:\\Windows\\System32\\cmd.exe', HARNESS_UNINSTALL_SCRIPT: 'harness-uninstall-77-1000.cmd', HARNESS_UNINSTALL_CWD: 'C:\\T' })
    expect(t.spawned).toEqual([])
  })

  it('falls back to a spawn when WMI refuses, and reports a script it could not write', () => {
    const t = deps({ powershell: () => ({ status: 3, stdout: '', stderr: 'Win32_Process.Create returned 2' }) })
    expect(scheduleFinalRemoval(plan, t.base)).toMatchObject({ ok: true, via: 'spawn' })
    // Only the script's name, from the temp folder: cmd /c would expand a %VAR% in a full path such as C:\Users\a%OS%b.
    expect(t.spawned).toEqual([['C:\\Windows\\System32\\cmd.exe', '/d', '/v:off', '/c', '.\\harness-uninstall-77-1000.cmd']])
    expect(t.cwds).toEqual(['C:\\T'])
    const unwritable = deps({ write: () => { throw new Error('EACCES') } })
    expect(scheduleFinalRemoval(plan, unwritable.base)).toEqual({ ok: false, detail: 'could not write C:\\T\\harness-uninstall-77-1000.cmd: EACCES' })
  })

  it('refuses a bad root before writing or starting anything', () => {
    const t = deps()
    expect(() => scheduleFinalRemoval({ ...plan, root: 'C:\\Users\\u' }, t.base)).toThrow(/Harness will not remove/)
    expect(() => scheduleFinalRemoval(plan, deps({ tempDir: 'T' }).base)).toThrow(/Harness will not remove/)
    // The script and its log must outlive the removal: never a temp folder in the root.
    expect(() => scheduleFinalRemoval(plan, deps({ tempDir: 'C:\\U\\.harness\\tmp' }).base)).toThrow(/Harness will not remove/)
    expect(() => scheduleFinalRemoval(plan, deps({ tempDir: 'c:\\u\\.HARNESS' }).base)).toThrow(/Harness will not remove/)
    expect(t.written).toEqual([])
    expect(t.scripts).toEqual([])
    expect(t.spawned).toEqual([])
  })
})

describe('finalRemovalDeps', () => {
  it('reports a cmd.exe it could not start, and does not crash later on its error', async () => {
    const missing = join(tmpdir(), 'no-such-folder-b54', 'cmd.exe')
    expect(() => finalRemovalDeps().spawnDetached(missing, ['/d'], tmpdir())).toThrow(/could not start/)
    const t = { ...finalRemovalDeps(), pid: 77, tempDir: 'C:\\T', systemRoot: 'C:\\No Such Windows', write: () => {}, powershell: () => ({ status: 3, stdout: '', stderr: 'off' }) }
    expect(scheduleFinalRemoval({ root: 'C:\\U\\.harness', remove: [], kept: [], removeRoot: true }, t)).toMatchObject({ ok: false, detail: expect.stringMatching(/could not start the last step/) })
    // Node raises the spawn's ENOENT afterwards, as an 'error' event: unheard, it would end the CLI with exit 1.
    await new Promise((r) => setTimeout(r, 200))
  })
})
