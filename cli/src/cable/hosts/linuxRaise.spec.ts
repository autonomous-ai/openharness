import { describe, expect, it, vi } from 'vitest'
import type { LinuxDesktop } from './linuxDesktop.js'
import { createLinuxRaise, type LinuxRaiseDeps, type RaiseTarget } from './linuxRaise.js'
import { WALK_PARENTS } from './scannedApp.js'

const SWAY: LinuxDesktop = { kind: 'sway', socket: '/run/user/1000/sway-ipc.1000.7.sock' }
const HYPRLAND: LinuxDesktop = { kind: 'hyprland', signature: 'abc_1700000000_x' }
const NONE: LinuxDesktop = { kind: 'none', why: 'gnome without the extension' }
const CLASSES: Record<string, string[]> = { wezterm: ['org.wezfurlong.wezterm'], code: ['Code', 'code'] }

type Process = { pid: number; ppid: number }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** A made-up login: each look answers the next of [desktops] (the last again once they run out), each raise answers
 *  [answer], and the process table is [table]. Nothing reads or runs anything of the developer's own desktop. */
function login({ desktops = [SWAY], answer = async () => true, table = async () => [] }: {
  desktops?: LinuxDesktop[]
  answer?: (target: RaiseTarget) => Promise<boolean>
  table?: () => Promise<readonly Process[]>
} = {}) {
  const lines: string[] = []
  const raised: { desktop: LinuxDesktop; target: RaiseTarget }[] = []
  let looks = 0
  const deps: LinuxRaiseDeps = {
    find: vi.fn(async () => desktops[Math.min(looks++, desktops.length - 1)]),
    backend: (desktop) => ({
      raise: (target) => {
        raised.push({ desktop, target })
        return answer(target)
      },
    }),
    processes: vi.fn(table),
    classes: (app) => CLASSES[app] ?? [],
    log: (line) => lines.push(line),
  }
  return { deps, lines, raised, looks: () => looks, raise: createLinuxRaise(deps) }
}

describe('createLinuxRaise', () => {
  it('logs the desktop it found once, and again only when a later look differs', async () => {
    const { raise, lines, looks } = login({ desktops: [SWAY, SWAY, HYPRLAND], answer: async () => false })
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · sway']))
    expect(await raise.raise({ app: 'wezterm' })).toBe(false)
    await vi.waitFor(() => expect(looks()).toBe(2))
    expect(await raise.raise({ app: 'wezterm' })).toBe(false)
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · sway', '[device] raise · hyprland']))
  })

  it('is not ready before the first look lands, and is ready once it found a desktop', async () => {
    const look = deferred<LinuxDesktop>()
    const { deps } = login()
    deps.find = () => look.promise
    const raise = createLinuxRaise(deps)
    expect(raise.ready()).toBe(false)
    look.resolve(SWAY)
    await vi.waitFor(() => expect(raise.ready()).toBe(true))
  })

  it('is not ready when the look found no desktop, and raises nothing', async () => {
    const { raise, lines, raised } = login({ desktops: [NONE] })
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · none · gnome without the extension']))
    expect(raise.ready()).toBe(false)
    expect(await raise.raise({ pid: 4242, app: 'wezterm' })).toBe(false)
    expect(raised).toEqual([])
  })

  it('waits for the look under way before it raises', async () => {
    const look = deferred<LinuxDesktop>()
    const { deps, raised } = login()
    deps.find = () => look.promise
    const raise = createLinuxRaise(deps)
    const answer = raise.raise({ app: 'code' })
    look.resolve(HYPRLAND)
    expect(await answer).toBe(true)
    expect(raised).toEqual([{ desktop: HYPRLAND, target: { pids: [], classes: ['Code', 'code'] } }])
  })

  it("passes the agent's process and its parents, nearest first, as far as parentChain walks", async () => {
    // 100 → 101 → … → 139 → 1: longer than a walk goes.
    const table = Array.from({ length: 40 }, (_, i) => ({ pid: 100 + i, ppid: i === 39 ? 1 : 101 + i }))
    const { raise, raised } = login({ table: async () => table })
    expect(await raise.raise({ pid: 100, app: 'wezterm' })).toBe(true)
    const pids = Array.from({ length: WALK_PARENTS + 1 }, (_, i) => 100 + i)
    expect(raised).toEqual([{ desktop: SWAY, target: { pids, classes: ['org.wezfurlong.wezterm'] } }])
  })

  it.each([1, 0, -5, 2.5, Number.NaN, 999])('takes no process for the pid %s, and raises by class', async (pid) => {
    const { raise, raised } = login({ table: async () => [{ pid: 100, ppid: 1 }] })
    expect(await raise.raise({ pid, app: 'code' })).toBe(true)
    expect(raised.map(({ target }) => target)).toEqual([{ pids: [], classes: ['Code', 'code'] }])
  })

  it('raises by class when the process table cannot be read', async () => {
    const { raise, raised } = login({ table: () => Promise.reject(new Error('ps')) })
    expect(await raise.raise({ pid: 4242, app: 'wezterm' })).toBe(true)
    expect(raised.map(({ target }) => target)).toEqual([{ pids: [], classes: ['org.wezfurlong.wezterm'] }])
  })

  it.each([
    ['no pid and no app', {}],
    ['no pid and an app with no class', { app: 'herdr' }],
    ['a pid not in the table and no app', { pid: 4242 }],
  ])('runs no backend for %s', async (_, window) => {
    const { raise, raised } = login({ table: async () => [{ pid: 100, ppid: 1 }] })
    expect(await raise.raise(window)).toBe(false)
    expect(raised).toEqual([])
  })

  it('looks again after a failed raise, and the next raise uses the new desktop', async () => {
    const { raise, raised, looks } = login({ desktops: [SWAY, HYPRLAND], answer: async () => raised.length > 1 })
    expect(await raise.raise({ app: 'code' })).toBe(false)
    expect(await raise.raise({ app: 'code' })).toBe(true)
    expect(raised.map(({ desktop }) => desktop)).toEqual([SWAY, HYPRLAND])
    expect(looks()).toBe(2)
  })

  it('does not look again after a raise that worked', async () => {
    const { raise, looks } = login()
    expect(await raise.raise({ app: 'code' })).toBe(true)
    expect(await raise.raise({ app: 'code' })).toBe(true)
    expect(looks()).toBe(1)
  })

  it('answers false when the backend throws, and looks again', async () => {
    const { raise, looks } = login({ answer: () => Promise.reject(new Error('boom')) })
    expect(await raise.raise({ app: 'code' })).toBe(false)
    await vi.waitFor(() => expect(looks()).toBe(2))
  })

  it('runs two raises at once', async () => {
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    const pending = [first, second]
    const { raise, raised } = login({ answer: () => pending[raised.length - 1].promise })
    const both = [raise.raise({ app: 'code' }), raise.raise({ app: 'wezterm' })]
    await vi.waitFor(() => expect(raised).toHaveLength(2))
    second.resolve(true)
    first.resolve(true)
    expect(await Promise.all(both)).toEqual([true, true])
  })
})
