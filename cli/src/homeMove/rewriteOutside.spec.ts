import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLATFORM_ENV, systemdUnit } from '../harnessd/platform.js'
import type { Done } from './journal.js'
import { planMove, type MovePlan } from './plan.js'
import { restoreOutside, rewriteOutside } from './rewriteOutside.js'

const NODE = 'runtime/node-v24.11.1/bin/node'
const CLI = 'cli/cli.js'
const LOG = 'cli/data/harness.log'

interface Home { home: string; plan: MovePlan; binDir: string; unitFile: string; old: (rest: string) => string; moved: (rest: string) => string }

function legacyHome(env: NodeJS.ProcessEnv = {}, name = 'h'): Home {
  const home = join(mkdtempSync(join(tmpdir(), 'move-outside-')), name)
  mkdirSync(join(home, '.harness'), { recursive: true })
  const plan = planMove(home, env, ['cli', 'runtime', 'bin', 'logs'])
  const binDir = join(home, '.local', 'bin'), unitFile = join(home, '.config', 'systemd', 'user', 'harnessd.service')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(unitFile, '..'), { recursive: true })
  const old = (rest: string): string => `${plan.legacy}/${rest}`
  const moved = (rest: string): string => `${rest.startsWith('runtime/') ? plan.state : plan.data}/${rest}`
  return { home, plan, binDir, unitFile, old, moved }
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const script = (path: string, text: string): void => {
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}
const unitOf = (home: string, at: (rest: string) => string, env: Record<string, string> = {}, logFile = at(LOG)): string =>
  systemdUnit({ nodePath: at(NODE), scriptPath: at(CLI), logFile, home, env })

/** A journal that keeps each step and what its file held when the step was added. */
function journal(): { add(done: Done): void; steps: Done[]; seen: (string | null)[] } {
  const steps: Done[] = [], seen: (string | null)[] = []
  return {
    steps, seen,
    add: (done) => {
      steps.push(done)
      seen.push(done.did === 'file' && existsSync(done.path) ? readFileSync(done.path, 'utf8') : null)
    },
  }
}

/** A runner that keeps each command and the unit's text when it ran. */
function runner(unitFile: string, status: number | null = 0): { run(command: string, args: string[]): { status: number | null }; calls: string[][]; units: string[] } {
  const calls: string[][] = [], units: string[] = []
  return {
    calls, units,
    run: (command, args) => {
      calls.push([command, ...args])
      units.push(readFileSync(unitFile, 'utf8'))
      return { status }
    },
  }
}

const base64 = (text: string): string => Buffer.from(text).toString('base64')
const RELOAD = ['systemctl', '--user', 'daemon-reload']

describe('the move rewrites what names the old tree outside it', () => {
  it('the harness launcher\'s exec line names the new node and cli.js, for each shipped shape', () => {
    const shapes = [
      // The public installer's two-liner (scripts/install.sh).
      (at: (rest: string) => string) => `#!/bin/sh\nexec ${quote(at(NODE))} ${quote(at(CLI))} "$@"\n`,
      // install-cli.sh's.
      (at: (rest: string) => string) => `#!/bin/sh\nexec "${at(NODE)}" "${at(CLI)}" "$@"\n`,
      // install-cli.sh --no-updates: its preamble is kept.
      (at: (rest: string) => string) => '#!/bin/sh\n# Local dev install, PINNED with --no-updates (see scripts/install-cli.sh).\n'
        + '# Self-update is off: no release will ever reach this computer on its own, not even a newer one.\n'
        + '# Re-run install-cli.sh without --no-updates (or the public installer) to rejoin the release train.\n'
        + `ADAPTER_UPDATE_DISABLE=true\nexport ADAPTER_UPDATE_DISABLE\nexec "${at(NODE)}" "${at(CLI)}" "$@"\n`,
    ]
    for (const shape of shapes) {
      const { plan, binDir, unitFile, old, moved } = legacyHome()
      const launcher = join(binDir, 'harness')
      script(launcher, shape(old))
      const steps = journal(), { run, calls } = runner(unitFile)
      expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, steps, run)).toEqual({ launcher: true, hn: false, unit: false })
      expect(readFileSync(launcher, 'utf8')).toBe(shape(moved))
      expect(lstatSync(launcher).mode & 0o777).toBe(0o755)
      // Its previous bytes are in the journal before it is written.
      expect(steps.steps).toEqual([{ did: 'file', path: launcher, before: base64(shape(old)) }])
      expect(steps.seen).toEqual([shape(old)])
      expect(readdirSync(binDir)).toEqual(['harness'])
      expect(calls).toEqual([])
    }
  })

  it('a launcher that runs another bundle is not touched', () => {
    const { plan, binDir, unitFile, old } = legacyHome()
    const launcher = join(binDir, 'harness'), text = `#!/bin/sh\nexec ${quote(old(NODE))} '/opt/dev/cli/dist/cli.js' "$@"\n`
    script(launcher, text)
    const steps = journal()
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, steps, runner(unitFile).run)).toEqual({ launcher: false, hn: false, unit: false })
    expect(readFileSync(launcher, 'utf8')).toBe(text)
    expect(steps.steps).toEqual([])
  })

  it('no launcher, nothing written', () => {
    const { plan, binDir, unitFile, old } = legacyHome()
    const steps = journal(), { run, calls } = runner(unitFile)
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, steps, run)).toEqual({ launcher: false, hn: false, unit: false })
    expect(readdirSync(binDir)).toEqual([])
    expect(existsSync(unitFile)).toBe(false)
    expect(steps.steps).toEqual([])
    expect(calls).toEqual([])
  })

  it('an hn of releases #365 to #500 is rewritten', () => {
    const { plan, binDir, unitFile, old, moved } = legacyHome()
    const hn = join(binDir, 'hn'), shape = (at: (rest: string) => string) => `#!/bin/sh\nexec ${quote(at(NODE))} ${quote(at(CLI))} tui "$@"\n`
    script(hn, shape(old))
    const steps = journal()
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, steps, runner(unitFile).run)).toEqual({ launcher: false, hn: true, unit: false })
    expect(readFileSync(hn, 'utf8')).toBe(shape(moved))
    expect(lstatSync(hn).mode & 0o777).toBe(0o755)
    expect(steps.steps).toEqual([{ did: 'file', path: hn, before: base64(shape(old)) }])
  })

  it('an hn that is a link into bin/ is linked again', () => {
    const { plan, binDir, unitFile, old, moved } = legacyHome()
    const hn = join(binDir, 'hn')
    symlinkSync(old('bin/harness-tui'), hn)
    const steps = journal()
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, steps, runner(unitFile).run)).toEqual({ launcher: false, hn: true, unit: false })
    expect(readlinkSync(hn)).toBe(moved('bin/harness-tui'))
    expect(steps.steps).toEqual([{ did: 'link', path: hn, before: old('bin/harness-tui') }])
    expect(readdirSync(binDir)).toEqual(['hn'])
  })

  it('today\'s hn, which names only the launcher, is not touched', () => {
    const { plan, binDir, unitFile, old, moved } = legacyHome()
    const launcher = join(binDir, 'harness'), hn = join(binDir, 'hn'), today = `#!/bin/sh\nexec ${quote(launcher)} tui "$@"\n`
    script(launcher, `#!/bin/sh\nexec ${quote(old(NODE))} ${quote(old(CLI))} "$@"\n`)
    script(hn, today)
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, journal(), runner(unitFile).run)).toEqual({ launcher: true, hn: false, unit: false })
    expect(readFileSync(hn, 'utf8')).toBe(today)
    expect(readFileSync(launcher, 'utf8')).toBe(`#!/bin/sh\nexec ${quote(moved(NODE))} ${quote(moved(CLI))} "$@"\n`)
  })

  it('this install\'s unit gets its ExecStart, StandardOutput and StandardError rewritten, and daemon-reload runs once', () => {
    const { home, plan, binDir, unitFile, old, moved } = legacyHome()
    writeFileSync(unitFile, unitOf(home, old))
    const steps = journal(), { run, calls, units } = runner(unitFile)
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, steps, run)).toEqual({ launcher: false, hn: false, unit: true })
    expect(readFileSync(unitFile, 'utf8')).toBe(unitOf(home, moved))
    expect(calls).toEqual([RELOAD])
    // systemd reloads the unit as rewritten.
    expect(units).toEqual([unitOf(home, moved)])
    // A rollback past the unit reloads again, once its bytes are back: the reload is journalled before the file.
    expect(steps.steps).toEqual([{ did: 'reload' }, { did: 'file', path: unitFile, before: base64(unitOf(home, old)) }])
  })

  it('XDG_DATA_HOME and XDG_STATE_HOME are added as Environment= lines when set, once', () => {
    const env = { XDG_DATA_HOME: '/srv/u/data', XDG_STATE_HOME: '/srv/u/state' }
    const { home, plan, binDir, unitFile, old, moved } = legacyHome(env)
    // A pinned install's unit, written when the shell had another state folder.
    writeFileSync(unitFile, unitOf(home, old, { ADAPTER_UPDATE_DISABLE: 'true', XDG_STATE_HOME: '/elsewhere' }))
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env }, journal(), runner(unitFile).run).unit).toBe(true)
    expect(moved(CLI)).toBe(`/srv/u/data/harness/${CLI}`)
    expect(readFileSync(unitFile, 'utf8')).toBe(unitOf(home, moved, { ADAPTER_UPDATE_DISABLE: 'true', ...env }))
    // A unit without the platform's line gets them after its ExecStart.
    const platform = `Environment="${PLATFORM_ENV}=systemd"\n`
    writeFileSync(unitFile, unitOf(home, old).replace(platform, ''))
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env }, journal(), runner(unitFile).run).unit).toBe(true)
    expect(readFileSync(unitFile, 'utf8')).toBe(unitOf(home, moved, env).replace(platform, ''))
  })

  it('a unit whose log is another data folder\'s is not touched', () => {
    const { home, plan, binDir, unitFile, old } = legacyHome()
    const theirs = unitOf(home, old, {}, '/srv/other/cli/data/harness.log')
    writeFileSync(unitFile, theirs)
    const steps = journal(), { run, calls } = runner(unitFile)
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, steps, run).unit).toBe(false)
    expect(readFileSync(unitFile, 'utf8')).toBe(theirs)
    expect(steps.steps).toEqual([])
    expect(calls).toEqual([])
  })

  it('a home with a space, a % and a $ in it is rewritten as the unit spells it', () => {
    const { home, plan, binDir, unitFile, old, moved } = legacyHome({}, 'my home%1$x')
    writeFileSync(unitFile, unitOf(home, old))
    // The program, an argument and a log path each escape it their own way.
    expect(readFileSync(unitFile, 'utf8')).toContain('home%%1$$x/.harness/cli/cli.js')
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, journal(), runner(unitFile).run).unit).toBe(true)
    expect(readFileSync(unitFile, 'utf8')).toBe(unitOf(home, moved))
  })

  it('daemon-reload that fails fails the step', () => {
    const { home, plan, binDir, unitFile, old } = legacyHome()
    writeFileSync(unitFile, unitOf(home, old))
    const steps = journal()
    expect(() => rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, steps, runner(unitFile, 1).run)).toThrow(/daemon-reload/)
    // What a rollback needs is journalled.
    expect(steps.steps).toEqual([{ did: 'reload' }, { did: 'file', path: unitFile, before: base64(unitOf(home, old)) }])
  })

  it('restoreOutside puts each file\'s bytes back and reloads again', () => {
    const { home, plan, binDir, unitFile, old } = legacyHome()
    const launcher = join(binDir, 'harness'), hn = join(binDir, 'hn')
    const launcherText = `#!/bin/sh\nexec ${quote(old(NODE))} ${quote(old(CLI))} "$@"\n`
    script(launcher, launcherText)
    symlinkSync(old('bin/harness-tui'), hn)
    writeFileSync(unitFile, unitOf(home, old))
    chmodSync(unitFile, 0o644)
    const steps = journal(), { run, calls, units } = runner(unitFile)
    expect(rewriteOutside(plan, { binDir, unitFile, oldLogFile: old(LOG), env: {} }, steps, run)).toEqual({ launcher: true, hn: true, unit: true })
    for (const done of [...steps.steps].reverse()) restoreOutside(done, run)
    expect(readFileSync(launcher, 'utf8')).toBe(launcherText)
    expect(lstatSync(launcher).mode & 0o777).toBe(0o755)
    expect(readlinkSync(hn)).toBe(old('bin/harness-tui'))
    expect(readFileSync(unitFile, 'utf8')).toBe(unitOf(home, old))
    expect(lstatSync(unitFile).mode & 0o777).toBe(0o644)
    // Reloaded again once the unit's bytes were back.
    expect(calls).toEqual([RELOAD, RELOAD])
    expect(units[1]).toBe(unitOf(home, old))
    expect(readdirSync(binDir).sort()).toEqual(['harness', 'hn'])
  })

  it('a file that was not there is removed again', () => {
    const { unitFile } = legacyHome()
    writeFileSync(unitFile, 'written by the move')
    restoreOutside({ did: 'file', path: unitFile, before: null }, runner(unitFile).run)
    expect(existsSync(unitFile)).toBe(false)
  })
})
