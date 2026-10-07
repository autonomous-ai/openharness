/**
 * The lean bundle a release carries, as the build writes it: what each process of harnessd loads from
 * it. A process parses every file it imports, so the memory each costs is the code it imports, and
 * that is what this holds: the master none of the services' code, a service none of another's, the core
 * none of the CLI's commands, and the master, search and workspaces no zod (`config/env.ts` and `lib/registry.ts` once brought it to every
 * one of them, 8 to 19 MiB each, measured 2026-10-05).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LEAN_CORE_ENTRY, LEAN_ENTRY, readLeanBundle, writeLeanBundle } from './harnessd/leanBundle.js'
import { PROBE_ANSWER } from './harnessd/reexec.js'
import { KNOWN_SERVICES, SERVICE_HOSTS } from './harnessd/services.js'

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
// The updater, beside the services the core knows: the master runs it (harnessd/services.ts `UPDATER_HOST`).
const ROLES = ['master', 'core', ...KNOWN_SERVICES, 'updater']
const RUNNER: Record<string, string> = { master: 'masterProcess', core: 'core-coreProcess' }
for (const name of [...KNOWN_SERVICES, 'updater']) RUNNER[name] = `${name}Process`

describe('the lean bundle a release carries', () => {
  let scratch = ''
  let entry = ''
  let files = new Map<string, string>()
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'lean-entry-'))
    execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: join(scratch, 'build') }, stdio: 'pipe' })
    const lean = readLeanBundle(readFileSync(join(scratch, 'build', 'cli.js')))!
    files = new Map([...lean.files].map(([name, code]) => [name, code.toString('utf8')]))
    entry = writeLeanBundle(join(scratch, 'lean'), lean)
  }, 120_000)
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

  /** The files a process loads: the entry, its runner's file, and what they import, but not what they
   *  import only when asked (another role's runner). */
  function loads(role: string): Set<string> {
    const runner = [...files.keys()].find((name) => name.startsWith(`${RUNNER[role]}-`))
    expect(runner, `${role}'s own file`).toBeDefined()
    const roots = role === 'core' ? [LEAN_CORE_ENTRY, runner!]
      : role === 'master' ? [LEAN_ENTRY, runner!]
        : [LEAN_ENTRY, [...files.keys()].find((name) => name.startsWith('serviceProcess-'))!, runner!]
    const seen = new Set<string>()
    const visit = (name: string): void => {
      if (seen.has(name)) return
      seen.add(name)
      for (const match of files.get(name)!.matchAll(/(?:from|import)\s*"\.\/([^"]+\.mjs)"/g)) visit(match[1])
    }
    for (const root of roots) visit(root)
    return seen
  }
  const runnerOf = (name: string): string | undefined => Object.entries(RUNNER).find(([, runner]) => name.startsWith(`${runner}-`))?.[0]
  const hasZod = (names: Set<string>): boolean => [...names].some((name) => files.get(name)!.includes('$ZodType'))

  it('is files of their own for the master, the core and each service, the code it runs and no other role\'s', () => {
    for (const role of ROLES) {
      const others = [...loads(role)].map(runnerOf).filter((owner) => owner && owner !== role)
      expect(others, `${role} loads another's code`).toEqual([])
    }
  })

  it('builds the core apart: it loads none of the master\'s and the services\' files, and they none of its', () => {
    // Built together, the files they shared held what the core uses too, and the master and every service
    // loaded it (leanCoreEntry.ts).
    const isCores = (name: string): boolean => name === LEAN_CORE_ENTRY || name.startsWith('core-')
    for (const role of ROLES) {
      const loaded = [...loads(role)]
      expect(loaded.filter((name) => isCores(name) !== (role === 'core')), role).toEqual([])
    }
  })

  it('gives the core its own code and none of the CLI\'s commands, which parsing cli.js cost it', () => {
    const core = loads('core')
    const text = [...core].map((name) => files.get(name)!).join('\n')
    // The core's own (core/main.ts), and not the CLI's: its usage text, written only in cli.ts.
    expect(text).toContain('[fatal-guard] uncaughtException')
    expect(text).not.toContain('sign in with Google in your browser, without asking')
    // Smaller than the whole bundle it used to parse, by the CLI's commands and the other processes' code.
    const whole = [...files.values()].reduce((sum, code) => sum + code.length, 0)
    expect([...core].reduce((sum, name) => sum + files.get(name)!.length, 0)).toBeLessThan(whole)
  })

  it('runs a core only from the core\'s entry, only for the cli.js its master read it from, and says so otherwise', () => {
    const run = (file: string, command: string) => spawnSync(process.execPath, [join(dirname(entry), file), command], {
      env: { PATH: process.env.PATH, HOME: join(scratch, 'home'), ADAPTER_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 30_000,
    })
    const core = run(LEAN_CORE_ENTRY, '__run')
    expect(core.status).toBe(2)
    expect(core.stderr).toContain('the lean bundle runs a core only for the cli.js its master read it from')
    const other = run(LEAN_CORE_ENTRY, '__harnessd')
    expect(other.status).toBe(2)
    expect(other.stderr).toContain('__harnessd is the CLI\'s (cli.js)')
    const nothing = run(LEAN_CORE_ENTRY, '')
    expect(nothing.status).toBe(2)
    // The master's and the services' entry has no core to run.
    const services = run(LEAN_ENTRY, '__run')
    expect(services.status).toBe(2)
    expect(services.stderr).toContain('__run is the CLI\'s (cli.js)')
  })

  it('brings no zod to the master, search, the updater or the edge host', () => {
    expect(hasZod(new Set(files.keys())), 'the bundle still holds zod, for the services whose own code uses it').toBe(true)
    // The edge host's services share one process: zod in any of them would be in all of them.
    for (const role of ['master', 'search', 'updater', ...SERVICE_HOSTS.edge.services]) expect(hasZod(loads(role)), role).toBe(false)
  })

  it('passes the release script\'s check, which a lean bundle that breaks a process does not', async () => {
    // @ts-expect-error — plain ESM with no declaration file
    const { leanBlock } = await import('../scripts/lib/leanBlock.mjs') as { leanBlock: (files: Record<string, string>) => string }
    const check = (cli: string) => spawnSync(process.execPath, ['scripts/check-lean-bundle.mjs', cli], { cwd: CLI_ROOT, encoding: 'utf8', timeout: 120_000 })
    const good = check(join(scratch, 'build', 'cli.js'))
    expect(good.status, good.stderr).toBe(0)
    expect(good.stdout).toMatch(/the master answers its probe, and \d+ modules load/)
    const search = [...files.keys()].find((name) => name.startsWith('searchProcess-'))!
    const broken = join(scratch, 'broken.js')
    writeFileSync(broken, `console.log("cli")\n${leanBlock({ ...Object.fromEntries(files), [search]: 'throw new Error("a broken service")' })}`)
    const bad = check(broken)
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain(`${search} does not load`)
    expect(bad.stderr).toContain('a broken service')
    const core = [...files.keys()].find((name) => name.startsWith('core-coreProcess-'))!
    writeFileSync(broken, `console.log("cli")\n${leanBlock({ ...Object.fromEntries(files), [core]: 'throw new Error("a broken core")' })}`)
    expect(check(broken).stderr).toContain(`${core} does not load`)
    writeFileSync(broken, `console.log("cli")\n${leanBlock({ ...Object.fromEntries(files), [LEAN_CORE_ENTRY]: 'throw new Error("a broken entry")' })}`)
    expect(check(broken).stderr).toContain('its core\'s entry does not load')
    writeFileSync(broken, `console.log("cli")\n${leanBlock({ ...Object.fromEntries(files), [LEAN_CORE_ENTRY]: 'process.exit(0)' })}`)
    expect(check(broken).stderr).toContain('its core\'s entry ran a core no master started')
    const { [core]: _gone, ...coreless } = Object.fromEntries(files)
    writeFileSync(broken, `console.log("cli")\n${leanBlock(coreless)}`)
    expect(check(broken).stderr).toContain('missing the master\'s, the services\' or the core\'s module')
    const { [LEAN_CORE_ENTRY]: _entry, ...entryless } = Object.fromEntries(files)
    writeFileSync(broken, `console.log("cli")\n${leanBlock(entryless)}`)
    expect(check(broken).stderr).toContain('missing the master\'s, the services\' or the core\'s module')
    writeFileSync(broken, `console.log("cli")\n${leanBlock({ ...Object.fromEntries(files), [LEAN_ENTRY]: 'process.exit(5)' })}`)
    expect(check(broken).stderr).toContain('its master does not answer its probe')
    writeFileSync(broken, 'console.log("no lean bundle")\n')
    expect(check(broken).stderr).toContain('carries no lean bundle')
    // Eight checks, most importing every process's module in a Node of its own, the core's among them.
  }, 300_000)

  it('starts as written out: its master answers the probe a re-executing master asks', () => {
    const run = spawnSync(process.execPath, [entry, '__harnessd-probe'], {
      env: { PATH: process.env.PATH, HOME: join(scratch, 'home'), ADAPTER_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 30_000,
    })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain(PROBE_ANSWER)
  })
})
