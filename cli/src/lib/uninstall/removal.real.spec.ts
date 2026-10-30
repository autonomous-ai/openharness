import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { finalRemovalDeps, finalRemovalScript, listEntries, removalPlan, removeNow, scheduleFinalRemoval, UNINSTALL_MARKER } from './removal.js'

// The real last step, on Windows only: a cmd.exe that waits for a process (a node.exe standing in for the CLI, holding
// a file open in the tree) to exit, then removes the tree and itself. Every root here is a throwaway one under the
// temp folder, its path made hard to quote (a space, a %, an &, a ^, a !, brackets, a non-ASCII letter): never the
// person's own %USERPROFILE%\.harness, which each case checks before it starts.
const realRoot = join(homedir(), '.harness')
const bases: string[] = []
afterAll(() => { for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true }) })

function throwaway(): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), `harness-removal-${process.pid} Jö 100% &^!()-`))
  bases.push(base)
  const root = join(base, '.harness')
  const rel = relative(tmpdir(), root)
  if (rel.startsWith('..') || root.toLowerCase() === realRoot.toLowerCase()) throw new Error(`not a throwaway root: ${root}`)
  return { base, root }
}

/** A folder outside the root, with a file in it, that a link inside the root points to. */
function outsideFolder(base: string): { dir: string; file: string } {
  const dir = join(base, 'outside')
  mkdirSync(dir)
  writeFileSync(join(dir, 'keep.txt'), 'k')
  return { dir, file: join(dir, 'keep.txt') }
}

const plan = (root: string, keepData = false) => removalPlan({
  platform: 'win32', root, cliDir: join(root, 'cli'), dataDir: join(root, 'cli', 'data'), entries: listEntries(root), cliEntries: listEntries(join(root, 'cli')), keepData,
})

/** A node.exe that stands in for the CLI for [ms]. */
const holder = (ms: number, open?: string) => spawn(process.execPath, ['-e', `${open ? `require('fs').openSync(${JSON.stringify(open)}, 'r'); ` : ''}setTimeout(() => {}, ${ms})`], { stdio: 'ignore' })

async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
}

/** Whether this account can make a file symlink: a standard user without Developer Mode cannot. */
function canLinkFiles(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'removal-probe-'))
  try { writeFileSync(join(dir, 'f'), ''); symlinkSync(join(dir, 'f'), join(dir, 'l'), 'file'); return true } catch { return false } finally { rmSync(dir, { recursive: true, force: true }) }
}
const fileLinks = process.platform === 'win32' && canLinkFiles()

const leftovers = (pid: number) => readdirSync(tmpdir()).filter((name) => name.startsWith(`harness-uninstall-${pid}-`))

// A ceiling, not a timing check: each case starts Windows PowerShell (and Add-Type compiles), ~5 s on windows-latest.
describe.runIf(process.platform === 'win32')('the last step of harness uninstall', { timeout: 60_000 }, () => {
  it('removes the tree once the process has exited, and leaves no script or log', async () => {
    const { root } = throwaway()
    mkdirSync(join(root, 'cli', '0.5.1'), { recursive: true })
    writeFileSync(join(root, 'cli', '0.5.1', 'cli.js'), '')
    writeFileSync(join(root, 'cli', 'current'), '0.5.1\n')
    // Ended by the case, not by a timer: scheduling starts Windows PowerShell, which outlasted a 4 s stand-in on
    // windows-latest (CI 39097994576).
    const cli = holder(30_000, join(root, 'cli', 'current'))
    const scheduled = scheduleFinalRemoval(plan(root), { ...finalRemovalDeps(), pid: cli.pid! })
    expect(scheduled).toMatchObject({ ok: true })
    // It waits for that process: while it runs, the tree is all there.
    await new Promise((r) => setTimeout(r, 1500))
    expect(cli.exitCode).toBe(null)
    expect(existsSync(join(root, 'cli', 'current'))).toBe(true)
    cli.kill()
    await until(() => !existsSync(root))
    expect(existsSync(root)).toBe(false)
    await new Promise((r) => setTimeout(r, 1000))
    expect(leftovers(cli.pid!)).toEqual([])
  }, 40_000)

  // The desktop app starts no daemon while the marker is there: cmd.exe removes it after the rest, then the root.
  it('removes the uninstall marker after the rest, and the root after it', async () => {
    const { root } = throwaway()
    mkdirSync(join(root, 'cli'), { recursive: true })
    writeFileSync(join(root, 'cli', 'cli.js'), '')
    writeFileSync(join(root, UNINSTALL_MARKER), `${Math.floor(Date.now() / 1000)}\n`)
    const p = plan(root)
    expect(p.remove.map((t) => t.path)).not.toContain(join(root, UNINSTALL_MARKER))
    const cli = holder(500)
    expect(scheduleFinalRemoval(p, { ...finalRemovalDeps(), pid: cli.pid! })).toMatchObject({ ok: true })
    await until(() => !existsSync(root))
    expect(existsSync(root)).toBe(false)
    await new Promise((r) => setTimeout(r, 1000))
    expect(leftovers(cli.pid!)).toEqual([])
  }, 40_000)

  it('removes a junction, never what it points to', async () => {
    const { base, root } = throwaway()
    const outside = outsideFolder(base)
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(root, 'cli'), { recursive: true })
    symlinkSync(outside.dir, join(root, 'linked'), 'junction')
    symlinkSync(outside.dir, join(root, 'bin', 'linked'), 'junction')
    symlinkSync(outside.dir, join(root, 'cli', 'linked'), 'junction')
    const p = plan(root)
    expect(p.remove).toContainEqual({ path: join(root, 'linked'), dir: false, link: true })
    const cli = holder(500)
    expect(scheduleFinalRemoval(p, { ...finalRemovalDeps(), pid: cli.pid! })).toMatchObject({ ok: true })
    await until(() => !existsSync(root))
    expect(existsSync(root)).toBe(false)
    expect(readdirSync(outside.dir)).toEqual(['keep.txt'])
    expect(readFileSync(outside.file, 'utf8')).toBe('k')
    await new Promise((r) => setTimeout(r, 1000))
    expect(leftovers(cli.pid!)).toEqual([])
  }, 40_000)

  // Skipped where this account cannot make a file symlink (a standard user without Developer Mode).
  it.skipIf(!fileLinks)('removes a file link, never the file it points to', async () => {
    const { base, root } = throwaway()
    const outside = outsideFolder(base)
    mkdirSync(join(root, 'cli'), { recursive: true })
    symlinkSync(outside.file, join(root, 'cli', 'current'), 'file')
    symlinkSync(outside.file, join(root, 'current-link'), 'file')
    const cli = holder(500)
    expect(scheduleFinalRemoval(plan(root), { ...finalRemovalDeps(), pid: cli.pid! })).toMatchObject({ ok: true })
    await until(() => !existsSync(root))
    expect(existsSync(root)).toBe(false)
    expect(readFileSync(outside.file, 'utf8')).toBe('k')
    await new Promise((r) => setTimeout(r, 1000))
    expect(leftovers(cli.pid!)).toEqual([])
  }, 40_000)

  it('removes the tree after a CLI that scheduled it has exited at once, and leaves the temp folder empty', async () => {
    const { base, root } = throwaway()
    const temp = join(base, 'temp')
    mkdirSync(temp)
    mkdirSync(join(root, 'cli', '0.5.1'), { recursive: true })
    mkdirSync(join(root, 'runtime', 'node-v24-win32-arm64'), { recursive: true })
    writeFileSync(join(root, 'cli', '0.5.1', 'cli.js'), '')
    writeFileSync(join(root, 'cli', 'current'), '0.5.1\n')
    // The CLI's stand-in: a node.exe of its own that schedules the last step for itself, through WMI, and exits.
    const child = join(base, 'cli-stand-in.mts')
    writeFileSync(child, [
      `import { finalRemovalDeps, listEntries, removalPlan, scheduleFinalRemoval } from ${JSON.stringify(new URL('./removal.ts', import.meta.url).href)}`,
      'const root = process.env.HARNESS_TEST_ROOT',
      "const plan = removalPlan({ platform: 'win32', root, cliDir: root + '\\\\cli', dataDir: root + '\\\\cli\\\\data', entries: listEntries(root), cliEntries: listEntries(root + '\\\\cli'), keepData: false })",
      'process.stdout.write(JSON.stringify(scheduleFinalRemoval(plan, { ...finalRemovalDeps(), tempDir: process.env.HARNESS_TEST_TEMP })))',
      'process.exit(0)',
    ].join('\n'))
    try {
      const ran = spawnSync(process.execPath, ['--import', 'tsx', child], {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HARNESS_TEST_ROOT: root, HARNESS_TEST_TEMP: temp },
      })
      expect(ran.status, ran.stderr).toBe(0)
      expect(JSON.parse(ran.stdout)).toMatchObject({ ok: true })
      await until(() => !existsSync(root) && readdirSync(temp).length === 0)
      expect(existsSync(root)).toBe(false)
      expect(readdirSync(temp)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 90_000)

  it('with --keep-data leaves cli\\data and the person\'s data', async () => {
    const { root } = throwaway()
    mkdirSync(join(root, 'cli', 'data', 'sessions'), { recursive: true })
    mkdirSync(join(root, 'cli', '0.5.1'), { recursive: true })
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(root, 'auth'), { recursive: true })
    writeFileSync(join(root, 'cli', 'data', 'sessions', 's.json'), 's')
    writeFileSync(join(root, 'auth', 'session.json'), 'a')
    writeFileSync(join(root, 'cli', 'current'), '0.5.1\n')
    writeFileSync(join(root, 'bin', 'harness.cmd'), '')
    const cli = holder(500)
    expect(scheduleFinalRemoval(plan(root, true), { ...finalRemovalDeps(), pid: cli.pid! })).toMatchObject({ ok: true })
    await until(() => !existsSync(join(root, 'bin')) && !existsSync(join(root, 'cli', '0.5.1')) && !existsSync(join(root, 'cli', 'current')))
    expect(listEntries(root).map((e) => e.name).sort()).toEqual(['auth', 'cli'])
    expect(listEntries(join(root, 'cli')).map((e) => e.name)).toEqual(['data'])
    expect(readFileSync(join(root, 'cli', 'data', 'sessions', 's.json'), 'utf8')).toBe('s')
    expect(readFileSync(join(root, 'auth', 'session.json'), 'utf8')).toBe('a')
  }, 40_000)

  it('removeNow removes a junction, never what it points to', () => {
    const { base, root } = throwaway()
    const outside = outsideFolder(base)
    mkdirSync(join(root, 'cli'), { recursive: true })
    symlinkSync(outside.dir, join(root, 'linked'), 'junction')
    symlinkSync(outside.dir, join(root, 'cli', 'linked'), 'junction')
    expect(removeNow(plan(root))).toEqual([])
    expect(existsSync(root)).toBe(false)
    expect(readdirSync(outside.dir)).toEqual(['keep.txt'])
  })

  it('refuses a root that is a junction, in the CLI and in the script itself', () => {
    const { base, root } = throwaway()
    const real = join(base, 'real', '.harness')
    mkdirSync(join(real, 'bin'), { recursive: true })
    writeFileSync(join(real, 'bin', 'harness.cmd'), 'h')
    symlinkSync(real, root, 'junction')
    const p = plan(root)
    expect(() => removeNow(p)).toThrow(/link/)
    expect(() => scheduleFinalRemoval(p, { ...finalRemovalDeps(), pid: 1 })).toThrow(/link/)
    // The script on its own, as if the root had become a junction after the CLI made the plan.
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    const script = join(base, 'last-step.cmd')
    const log = join(base, 'last-step.log')
    writeFileSync(script, finalRemovalScript({ pid: exited, plan: p, log, systemRoot: process.env.SystemRoot ?? 'C:\\Windows' }), 'utf8')
    spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', `""${script}""`], { windowsVerbatimArguments: true, timeout: 30_000 })
    expect(readFileSync(join(real, 'bin', 'harness.cmd'), 'utf8')).toBe('h')
    expect(readFileSync(log, 'utf8')).toContain('has become a link to another folder')
    expect(existsSync(script)).toBe(false)
  }, 40_000)
})
