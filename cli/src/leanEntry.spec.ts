/**
 * The lean bundle a release carries, as the build writes it: what each process of harnessd loads from
 * it. A process parses every file it imports, so the memory each costs is the code it imports, and
 * that is what this holds: the master none of the services' code, a service none of another's, and the
 * master, search and workspaces no zod (`config/env.ts` and `lib/registry.ts` once brought it to every
 * one of them, 8 to 19 MiB each, measured 2026-10-05).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LEAN_ENTRY, readLeanBundle, writeLeanBundle } from './harnessd/leanBundle.js'
import { PROBE_ANSWER } from './harnessd/reexec.js'
import { KNOWN_SERVICES, SERVICE_HOSTS } from './harnessd/services.js'

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROLES = ['master', ...KNOWN_SERVICES]
const RUNNER: Record<string, string> = { master: 'masterProcess' }
for (const name of KNOWN_SERVICES) RUNNER[name] = `${name}Process`

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
    const roots = role === 'master' ? [LEAN_ENTRY, runner!] : [LEAN_ENTRY, [...files.keys()].find((name) => name.startsWith('serviceProcess-'))!, runner!]
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

  it('is files of their own for the master and each service, the code it runs and no other role\'s', () => {
    for (const role of ROLES) {
      const others = [...loads(role)].map(runnerOf).filter((owner) => owner && owner !== role)
      expect(others, `${role} loads another's code`).toEqual([])
    }
  })

  it('brings no zod to the master, search or the edge host', () => {
    expect(hasZod(new Set(files.keys())), 'the bundle still holds zod, for the services whose own code uses it').toBe(true)
    // The edge host's services share one process: zod in any of them would be in all of them.
    for (const role of ['master', 'search', ...SERVICE_HOSTS.edge.services]) expect(hasZod(loads(role)), role).toBe(false)
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
    writeFileSync(broken, `console.log("cli")\n${leanBlock({ ...Object.fromEntries(files), [LEAN_ENTRY]: 'process.exit(5)' })}`)
    expect(check(broken).stderr).toContain('its master does not answer its probe')
    writeFileSync(broken, 'console.log("no lean bundle")\n')
    expect(check(broken).stderr).toContain('carries no lean bundle')
  }, 120_000)

  it('starts as written out: its master answers the probe a re-executing master asks', () => {
    const run = spawnSync(process.execPath, [entry, '__harnessd-probe'], {
      env: { PATH: process.env.PATH, HOME: join(scratch, 'home'), ADAPTER_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 30_000,
    })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain(PROBE_ANSWER)
  })
})
