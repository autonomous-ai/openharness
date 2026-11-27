import { describe, expect, it } from 'vitest'
import { RECORDED_GNOME_SHELL } from '../../testing/recordedGnomeShell.js'
import { createGnomeRaise } from './linuxRaiseGnome.js'
import type { RaiseRun } from './linuxRaise.js'

const BUS = 'unix:path=/run/user/1000/bus'
const GDBUS = '/usr/bin/gdbus'
const { activateHit, activateMiss, activateWithout, wmClassOf } = RECORDED_GNOME_SHELL

type Answer = { code: number | null; stdout: string }

/** The recorded call for [cls], on [bus] as the backend names it (the recording used `--session`). */
function call(cls: string, bus = BUS): string[] {
  return [...activateHit.args.slice(0, -1).flatMap((arg) => (arg === '--session' ? ['--address', bus] : [arg])), cls]
}

/** A made-up GNOME Shell with the recording's two windows, foot and the XWayland xterm: the recorded call answers the
 *  recorded hit for a class one of them has and the recorded miss for any other. [answer] stands in for it when given; any other
 *  command fails. */
function shell({ answer, gdbus = GDBUS, bus = BUS }: {
  answer?: (cls: string) => Answer | Promise<Answer>
  gdbus?: string | null
  bus?: string
} = {}) {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = []
  const deps: RaiseRun = {
    onPath: (name) => (name === 'gdbus' ? gdbus : null),
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const cls = args.at(-1) ?? ''
      if (file !== GDBUS || JSON.stringify(args) !== JSON.stringify(call(cls, bus))) return { code: 1, stdout: '' }
      if (answer) return answer(cls)
      return Object.values(wmClassOf).includes(cls as never)
        ? { code: 0, stdout: activateHit.stdout }
        : { code: 0, stdout: activateMiss.stdout }
    },
  }
  return { deps, calls, classes: () => calls.map((c) => c.args.at(-1)) }
}

describe('createGnomeRaise', () => {
  it('activates the app by its class through the recorded call, on the bus it was given', async () => {
    const { deps, calls } = shell()
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [], classes: [wmClassOf.wayland] })).toBe(true)
    expect(calls).toEqual([{ file: GDBUS, args: call(wmClassOf.wayland), timeoutMs: 10_000 }])
  })

  it('tries each spelling in turn and stops at the first the shell activates', async () => {
    const { deps, classes } = shell()
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [], classes: ['nope', wmClassOf.xwayland, wmClassOf.wayland] })).toBe(true)
    expect(classes()).toEqual(['nope', wmClassOf.xwayland])
  })

  it('matches an XWayland window by its WM_CLASS class as the shell does: the instance part misses', async () => {
    const { deps, classes } = shell()
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [], classes: ['xterm'] })).toBe(false)
    expect(classes()).toEqual(['xterm'])
  })

  it('is false after the last spelling misses, with one call each', async () => {
    const { deps, calls } = shell()
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [], classes: ['nope', 'Nope'] })).toBe(false)
    expect(calls.map((c) => c.args)).toEqual([call('nope'), call('Nope')])
    expect(calls.every((c) => c.timeoutMs === 10_000)).toBe(true)
  })

  it('never uses the pids: with no class it is false and runs nothing', async () => {
    const { deps, calls } = shell()
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [4242, 100], classes: [] })).toBe(false)
    expect(calls).toEqual([])
  })

  it('raises by class alone when pids are given too', async () => {
    const { deps, calls } = shell()
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [4242], classes: [wmClassOf.wayland] })).toBe(true)
    expect(calls.map((c) => c.args)).toEqual([call(wmClassOf.wayland)])
  })

  it('is false with no second call when the extension went away since it was found', async () => {
    const { deps, calls } = shell({ answer: () => ({ code: activateWithout.code, stdout: '' }) })
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [], classes: [wmClassOf.wayland, wmClassOf.xwayland] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it.each<[string, Answer]>([
    ['an answer that is neither the hit nor the miss', { code: 0, stdout: 'Error: something else\n' }],
    ['the hit with a failing exit', { code: 1, stdout: activateHit.stdout }],
    ['a call over the runner\'s buffer or past its timeout', { code: null, stdout: activateHit.stdout }],
  ])('is false with no second call for %s', async (_, answer) => {
    const { deps, calls } = shell({ answer: () => answer })
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [], classes: [wmClassOf.wayland, wmClassOf.xwayland] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('is false and does not throw when the runner rejects', async () => {
    const { deps } = shell({ answer: () => Promise.reject(new Error('spawn failed')) })
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [], classes: [wmClassOf.wayland] })).toBe(false)
  })

  it('never puts a class out of form on a command line', async () => {
    const { deps, classes } = shell()
    const bad = ['', '-foot', '--help', 'fo ot', 'foot;x', "fo'ot", 'fo\not', 'a'.repeat(65), 'fööt']
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [], classes: [...bad, wmClassOf.wayland] })).toBe(true)
    expect(classes()).toEqual([wmClassOf.wayland])
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [], classes: bad })).toBe(false)
    expect(classes()).toEqual([wmClassOf.wayland])
  })

  it.each([
    'unix:path=/run/user/1000/bus;tcp:host=example.com,port=1',
    'unix:path=/run/user/1000/bus,guid=0123',
    'tcp:host=example.com,port=1',
    '--session',
    'unix:path=',
    '',
  ])('never runs a command for the bus %j, out of form', async (bus) => {
    const { deps, calls } = shell()
    expect(await createGnomeRaise(deps, bus).raise({ pids: [], classes: [wmClassOf.wayland] })).toBe(false)
    expect(calls).toEqual([])
  })

  it('takes an abstract bus address', async () => {
    const bus = 'unix:abstract=/tmp/dbus-AbCdEf0123'
    const { deps, calls } = shell({ bus })
    expect(await createGnomeRaise(deps, bus).raise({ pids: [], classes: [wmClassOf.wayland] })).toBe(true)
    expect(calls.map((c) => c.args)).toEqual([call(wmClassOf.wayland, bus)])
  })

  it('is false with no command when gdbus is not on PATH', async () => {
    const { deps, calls } = shell({ gdbus: null })
    expect(await createGnomeRaise(deps, BUS).raise({ pids: [], classes: [wmClassOf.wayland] })).toBe(false)
    expect(calls).toEqual([])
  })
})
