import { afterEach, describe, expect, it, vi } from 'vitest'
import { UPDATER_RESTART_MS, needsUpdaterBeside, startUpdaterBeside, type UpdaterChild } from './updaterBeside.js'

class FakeChild implements UpdaterChild {
  private messages: Array<(message: unknown) => void> = []
  private exits: Array<() => void> = []
  killed = false
  onMessage(listener: (message: unknown) => void): void { this.messages.push(listener) }
  onExit(listener: () => void): void { this.exits.push(listener) }
  kill(): void { this.killed = true }
  say(message: unknown): void { for (const listener of this.messages) listener(message) }
  exit(): void { for (const listener of this.exits) listener() }
}

describe('the updater beside a core whose master runs none', () => {
  afterEach(() => { vi.useRealTimers() })

  it('is needed only under a master that does not say it runs the updater, for the installed copy with updates on', () => {
    expect(needsUpdaterBeside({}, true, true, false)).toBe(true)
    expect(needsUpdaterBeside({ HARNESSD_UPDATES: 'master' }, true, true, false)).toBe(false)
    expect(needsUpdaterBeside({}, false, true, false)).toBe(false)
    expect(needsUpdaterBeside({}, true, false, false)).toBe(false)
    expect(needsUpdaterBeside({}, true, true, true)).toBe(false)
  })

  const make = () => {
    const children: FakeChild[] = []
    const staged: string[] = []
    const lines: string[] = []
    let pending: (() => void) | null = null
    const stop = startUpdaterBeside({
      spawn: () => { const child = new FakeChild(); children.push(child); return child },
      staged: (version) => staged.push(version),
      log: (line) => lines.push(line),
      setTimer: (run, ms) => { lines.push(`in ${ms}`); pending = run; return 'timer' },
      clearTimer: () => { lines.push('cleared'); pending = null },
    })
    return { children, staged, lines, stop, fire: () => pending!() }
  }

  it('hands over once for what it stages, and ignores what else it says', () => {
    const m = make()
    expect(m.lines).toEqual(['[update] this core\'s master runs no updater — running it beside this core'])
    m.children[0].say({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1 })
    m.children[0].say({ type: 'harnessd:staged', version: 3 })
    m.children[0].say(null)
    expect(m.staged).toEqual([])
    m.children[0].say({ type: 'harnessd:staged', version: '9.9.9' })
    m.children[0].say({ type: 'harnessd:staged', version: '9.9.10' })
    expect(m.staged).toEqual(['9.9.9'])
    expect(m.lines.at(-1)).toBe('[update] the updater staged 9.9.9 — handing over to this core\'s master')
    // It exits to be started again as the new build; this core is leaving instead.
    m.children[0].exit()
    expect(m.children).toHaveLength(1)
  })

  it('starts it again a while after it ends, and stops it, and any restart, on request', () => {
    const m = make()
    m.children[0].exit()
    expect(m.lines.slice(-2)).toEqual([`[update] the updater ended — starting it again in ${UPDATER_RESTART_MS / 1000} s`, `in ${UPDATER_RESTART_MS}`])
    m.fire()
    expect(m.children).toHaveLength(2)
    // A process it let go of says nothing that counts.
    m.children[0].exit()
    expect(m.children).toHaveLength(2)
    m.stop()
    expect(m.children[1].killed).toBe(true)
    m.children[1].exit()
    expect(m.children).toHaveLength(2)
    const waiting = make()
    waiting.children[0].exit()
    waiting.stop()
    expect(waiting.lines.at(-1)).toBe('cleared')
  })

  it('waits on a timer that keeps no process alive by default', () => {
    vi.useFakeTimers()
    const children: FakeChild[] = []
    const stop = startUpdaterBeside({ spawn: () => { const child = new FakeChild(); children.push(child); return child }, staged: () => {}, log: () => {} })
    children[0].exit()
    vi.advanceTimersByTime(UPDATER_RESTART_MS)
    expect(children).toHaveLength(2)
    children[1].exit()
    stop()
    vi.advanceTimersByTime(UPDATER_RESTART_MS)
    expect(children).toHaveLength(2)
  })
})
