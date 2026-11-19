import { describe, expect, it } from 'vitest'
import { RECORDED_HYPRLAND } from '../../testing/recordedHyprland.js'
import { createHyprlandRaise } from './linuxRaiseHyprland.js'
import type { RaiseRun, RaiseTarget } from './linuxRaise.js'

const HYPRCTL = '/usr/bin/hyprctl'
const SIGNATURE = RECORDED_HYPRLAND.signature.value
const { agent: AGENT, other: OTHER } = RECORDED_HYPRLAND.pids
const OTHER_ADDRESS = 'address:0xaaab1c9d4e10'

type Reply = { code: number | null; stdout: string }
type Answer = Reply | (() => Promise<Reply>)
type Window = Record<string, unknown>

const recordedWindows = (): Window[] => JSON.parse(RECORDED_HYPRLAND.clients.stdout) as Window[]
const listingOf = (windows: Window[]): Reply => ({ code: 0, stdout: JSON.stringify(windows) })
const focusArgs = (target: string) => ['hyprctl', '-i', SIGNATURE, 'dispatch', 'focuswindow', target]
const OK: Reply = { code: RECORDED_HYPRLAND.focusByPid.code, stdout: RECORDED_HYPRLAND.focusByPid.stdout }

/** A made-up Hyprland: the listing answers [listing], a focus answers from [focus] by its target, else as recorded,
 *  and an argv nobody recorded answers as a hyprctl that could not start. Nothing runs the developer's own hyprctl. */
function hyprland({ listing = { code: 0, stdout: RECORDED_HYPRLAND.clients.stdout } as Answer,
  focus = {} as Record<string, Answer>, onPath = HYPRCTL as string | null } = {}) {
  const calls: { args: string[]; timeoutMs: number }[] = []
  const recorded = [RECORDED_HYPRLAND.focusByPid, RECORDED_HYPRLAND.focusByAddress, RECORDED_HYPRLAND.focusNoMatch]
  const answer = (a: Answer) => (typeof a === 'function' ? a() : Promise.resolve(a))
  const deps: RaiseRun = {
    onPath: (name) => (name === 'hyprctl' ? onPath : null),
    run: async (file, args, timeoutMs) => {
      expect(file).toBe(HYPRCTL)
      calls.push({ args, timeoutMs })
      const argv = JSON.stringify(['hyprctl', ...args])
      if (argv === JSON.stringify(RECORDED_HYPRLAND.clients.args)) return answer(listing)
      const target = Object.keys(focus).find((t) => JSON.stringify(focusArgs(t)) === argv)
      if (target !== undefined) return answer(focus[target])
      const reply = recorded.find((r) => JSON.stringify(r.args) === argv)
      return reply === undefined ? { code: null, stdout: '' } : { code: reply.code, stdout: reply.stdout }
    },
  }
  const backend = createHyprlandRaise(deps, SIGNATURE)
  return {
    calls,
    focused: () => calls.filter((c) => c.args.includes('dispatch')).map((c) => c.args.at(-1)),
    raise: (target: Partial<RaiseTarget>) => backend.raise({ pids: [], classes: [], ...target }),
  }
}

describe('createHyprlandRaise', () => {
  it('lists the clients, then focuses the agent window by its pid', async () => {
    const { raise, calls } = hyprland()
    expect(await raise({ pids: [AGENT] })).toBe(true)
    expect(calls).toEqual([
      { args: RECORDED_HYPRLAND.clients.args.slice(1), timeoutMs: 10_000 },
      { args: RECORDED_HYPRLAND.focusByPid.args.slice(1), timeoutMs: 10_000 },
    ])
  })

  it('takes the first of the pids that owns a window over a nearer one that owns none', async () => {
    const { raise, focused } = hyprland({ focus: { [`pid:${OTHER}`]: OK } })
    expect(await raise({ pids: [4300, OTHER, AGENT], classes: ['foot'] })).toBe(true)
    expect(focused()).toEqual([`pid:${OTHER}`])
  })

  it('focuses the first window of the class by its address when no pid owns one, comparing without case', async () => {
    const { raise, calls } = hyprland()
    expect(await raise({ pids: [4300], classes: ['Alacritty', 'FOOT'] })).toBe(true)
    expect(calls.at(-1)).toEqual({ args: RECORDED_HYPRLAND.focusByAddress.args.slice(1), timeoutMs: 10_000 })
  })

  it('reads the initial class of a window whose class is empty', async () => {
    const windows = recordedWindows()
    windows[1] = { ...windows[1], class: '', initialClass: 'Code' }
    const { raise, focused } = hyprland({ listing: listingOf(windows), focus: { [OTHER_ADDRESS]: OK } })
    expect(await raise({ classes: ['code'] })).toBe(true)
    expect(focused()).toEqual([OTHER_ADDRESS])
  })

  it('answers false with no second command when neither a pid nor a class matches', async () => {
    const { raise, calls } = hyprland()
    expect(await raise({ pids: [4300], classes: ['Code'] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('answers false when hyprctl says the window was not found, though it exits 0', async () => {
    const notFound = { code: RECORDED_HYPRLAND.focusNoMatch.code, stdout: RECORDED_HYPRLAND.focusNoMatch.stdout }
    const { raise, focused } = hyprland({ focus: { [`pid:${AGENT}`]: notFound } })
    expect(await raise({ pids: [AGENT] })).toBe(false)
    expect(focused()).toEqual([`pid:${AGENT}`])
  })

  it('answers false when the focus fails, and does not throw when its runner rejects', async () => {
    const failed = hyprland({ focus: { [`pid:${AGENT}`]: { code: 1, stdout: '' } } })
    expect(await failed.raise({ pids: [AGENT] })).toBe(false)
    const rejected = hyprland({ focus: { [`pid:${AGENT}`]: () => Promise.reject(new Error('spawn EACCES')) } })
    expect(await rejected.raise({ pids: [AGENT] })).toBe(false)
    expect(rejected.focused()).toEqual([`pid:${AGENT}`])
  })

  it.each([
    ['no Hyprland on the socket', { code: RECORDED_HYPRLAND.noSocket.code, stdout: RECORDED_HYPRLAND.noSocket.stdout }],
    ['a signature it takes for an index', { code: RECORDED_HYPRLAND.signatureWithoutUnderscore.code, stdout: RECORDED_HYPRLAND.signatureWithoutUnderscore.stdout }],
    ['text that is not JSON', { code: 0, stdout: 'ok\n' }],
    ['JSON that is not a list', { code: 0, stdout: '{"pid": 4101}' }],
    ['a list of what are not windows', { code: 0, stdout: '[4101, "foot", null]' }],
    // execFile's maxBuffer: the child is killed, there is no exit code, and stdout is cut short.
    ['more than the runner holds', { code: null, stdout: RECORDED_HYPRLAND.clients.stdout.slice(0, 400) }],
  ])('answers false with no second command when the listing is %s', async (_, listing) => {
    const { raise, calls } = hyprland({ listing })
    expect(await raise({ pids: [AGENT], classes: ['foot'] })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('answers false and does not throw when the listing runner rejects', async () => {
    const { raise, focused } = hyprland({ listing: () => Promise.reject(new Error('spawn EACCES')) })
    expect(await raise({ pids: [AGENT], classes: ['foot'] })).toBe(false)
    expect(focused()).toEqual([])
  })

  it('answers false with no command when hyprctl is not on PATH', async () => {
    const { raise, calls } = hyprland({ onPath: null })
    expect(await raise({ pids: [AGENT], classes: ['foot'] })).toBe(false)
    expect(calls).toEqual([])
  })

  it('never puts a pid out of form on a command line', async () => {
    const windows = recordedWindows()
    const odd = [0, 1, 1.5, -4101].map((pid) => ({ ...windows[0], pid }))
    const { raise, focused } = hyprland({ listing: listingOf(odd) })
    expect(await raise({ pids: [0, 1, 1.5, -4101, Number.NaN] })).toBe(false)
    expect(focused()).toEqual([])
  })

  it('never puts an address out of form on a command line, and takes the next window of the class', async () => {
    const windows = recordedWindows()
    windows[0] = { ...windows[0], address: '0xaaab1c8a2f50 pid:1' }
    const { raise, focused } = hyprland({ listing: listingOf(windows), focus: { [OTHER_ADDRESS]: OK } })
    expect(await raise({ classes: ['foot'] })).toBe(true)
    expect(focused()).toEqual([OTHER_ADDRESS])

    const upper = recordedWindows().map((w) => ({ ...w, address: String(w.address).toUpperCase() }))
    const none = hyprland({ listing: listingOf(upper) })
    expect(await none.raise({ classes: ['foot'] })).toBe(false)
    expect(none.focused()).toEqual([])
  })
})
