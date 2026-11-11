import { describe, expect, it } from 'vitest'
// @ts-expect-error — the tool server's helpers are plain ESM, run by Node inside the browser's container.
import { humanInput, keyDelays, modeOf, mousePath } from '../../../assets/browser/human-input.mjs'

type Point = { x: number; y: number; delayMs: number }

/** mulberry32: a small seeded rng, so every draw in these tests is exact. */
function seeded(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const box = { x: 600, y: 400, width: 120, height: 40 }

describe('mousePath', () => {
  it('mousePath ends inside the box and is not a straight line', () => {
    const from = { x: 100, y: 100 }
    const path: Point[] = mousePath(from, box, seeded(1))
    const end = path.at(-1)!
    expect(end.x).toBeGreaterThanOrEqual(box.x)
    expect(end.x).toBeLessThanOrEqual(box.x + box.width)
    expect(end.y).toBeGreaterThanOrEqual(box.y)
    expect(end.y).toBeLessThanOrEqual(box.y + box.height)
    expect(path.length).toBeGreaterThanOrEqual(12)
    // Distance of each point from the straight line from → end.
    const off = (p: Point) => Math.abs((end.x - from.x) * (from.y - p.y) - (from.x - p.x) * (end.y - from.y)) / Math.hypot(end.x - from.x, end.y - from.y)
    expect(Math.max(...path.map(off))).toBeGreaterThan(5)
    for (const p of path) expect(p.delayMs).toBeGreaterThan(0)
  })

  it('the same rng gives the same path', () => {
    expect(mousePath({ x: 0, y: 0 }, box, seeded(7))).toEqual(mousePath({ x: 0, y: 0 }, box, seeded(7)))
    expect(mousePath({ x: 0, y: 0 }, box, seeded(7))).not.toEqual(mousePath({ x: 0, y: 0 }, box, seeded(8)))
  })

  it('stays inside the viewport', () => {
    const viewport = { width: 800, height: 600 }
    for (let seed = 1; seed < 20; seed += 1) {
      for (const p of mousePath({ x: 790, y: 5 }, { x: 5, y: 560, width: 30, height: 30 }, seeded(seed), { viewport }) as Point[]) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(viewport.width - 1)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeLessThanOrEqual(viewport.height - 1)
      }
    }
  })
})

describe('keyDelays', () => {
  it('keyDelays are log-normal within the speed\'s range, and exact for a fixed rng', () => {
    const text = 'a'.repeat(2000)
    const ranges = { slow: [70, 700, 190], normal: [40, 450, 110], fast: [25, 250, 60] } as const
    for (const [speed, [lo, hi, median]] of Object.entries(ranges)) {
      const delays: number[] = keyDelays(text, speed, seeded(3))
      expect(delays).toHaveLength(text.length)
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(lo)
      expect(Math.max(...delays)).toBeLessThanOrEqual(hi)
      // Log-normal: the logs average to the log of the median, and the draws are uneven.
      const meanLog = delays.reduce((sum, d) => sum + Math.log(d), 0) / delays.length
      expect(Math.exp(meanLog)).toBeGreaterThan(median * 0.9)
      expect(Math.exp(meanLog)).toBeLessThan(median * 1.1)
      expect(new Set(delays.map(Math.round)).size).toBeGreaterThan(50)
    }
    // rng 0.5 draws the normal deviate sqrt(-2 ln 0.5) * cos(pi); the session tempo scales the median and the range.
    const z = Math.sqrt(-2 * Math.log(0.5)) * Math.cos(Math.PI)
    expect(keyDelays('ab', 'normal', () => 0.5)).toEqual([110 * Math.exp(0.35 * z), 110 * Math.exp(0.35 * z)])
    expect(keyDelays('é', 'fast', () => 0.5, 1.2)).toEqual([60 * 1.2 * Math.exp(0.35 * z)])
  })
})

describe('modeOf', () => {
  it('reads the mode of the call; anything else is normal, since human input is on by default', () => {
    expect(modeOf({ human: 'off' })).toBe('off')
    expect(modeOf({ human: 'slow' })).toBe('slow')
    expect(modeOf({ human: 'fast' })).toBe('fast')
    expect(modeOf(undefined)).toBe('normal')
    expect(modeOf({ human: 'turbo' })).toBe('normal')
  })
})

/** A page and a target that record every call, in order. */
function fakes() {
  const log: unknown[][] = []
  const rec = (name: string) => async (...args: unknown[]) => { log.push([name, ...args]) }
  const page = {
    mouse: { move: rec('move'), down: rec('down'), up: rec('up') },
    keyboard: { type: rec('key'), press: rec('press'), insertText: rec('insert') },
    viewportSize: () => ({ width: 1280, height: 800 }),
  }
  const target = {
    click: rec('click'), fill: rec('fill'), press: rec('field.press'), scrollIntoViewIfNeeded: rec('scroll'),
    boundingBox: async () => box,
  }
  const sleep = async (ms: number) => { log.push(['sleep', ms]) }
  return { log, page, target, sleep }
}

describe('humanInput', () => {
  it('human mode off clicks and types at once', async () => {
    const { log, page, target, sleep } = fakes()
    const human = humanInput(seeded(1), sleep)
    await human.click(page, target, 'off', 20_000)
    await human.type(page, target, 'hello', true, 'off', 20_000)
    expect(log).toEqual([
      ['click', { timeout: 20_000 }],
      ['fill', 'hello', { timeout: 20_000 }],
      ['field.press', 'Enter', { timeout: 20_000 }],
    ])
  })

  it('a human click moves along a curve, then presses and releases inside the box', async () => {
    const { log, page, target, sleep } = fakes()
    await humanInput(seeded(2), sleep).click(page, target, 'normal', 20_000)
    const names = log.map(([name]) => name)
    expect(names[0]).toBe('scroll')
    expect(names.filter(n => n === 'move').length).toBeGreaterThanOrEqual(12)
    expect(names.slice(-4)).toEqual(['sleep', 'down', 'sleep', 'up'])
    // Every move waits first, and every wait is a drawn duration, not zero.
    for (let n = 1; n < log.length; n += 1) if (log[n]![0] === 'move') expect(log[n - 1]![0]).toBe('sleep')
    for (const [name, ms] of log) if (name === 'sleep') expect(ms).toBeGreaterThan(0)
    const [, x, y] = log.filter(([name]) => name === 'move').at(-1)! as [string, number, number]
    expect(x).toBeGreaterThanOrEqual(box.x)
    expect(x).toBeLessThanOrEqual(box.x + box.width)
    expect(y).toBeGreaterThanOrEqual(box.y)
    expect(y).toBeLessThanOrEqual(box.y + box.height)
  })

  it('a target without a box gets Playwright\'s own click, which waits and says why', async () => {
    const { log, page, target, sleep } = fakes()
    await humanInput(seeded(2), sleep).click(page, { ...target, boundingBox: async () => null }, 'normal', 20_000)
    expect(log).toEqual([['scroll', { timeout: 20_000 }], ['click', { timeout: 20_000 }]])
  })

  it('human typing clears the field and types each key after its delay, then Enter', async () => {
    const { log, page, target, sleep } = fakes()
    await humanInput(seeded(4), sleep).type(page, target, 'hé!', true, 'slow', 20_000)
    const after = log.slice(log.findIndex(([name]) => name === 'up') + 1)
    expect(after.map(([name, value]) => (name === 'sleep' ? 'sleep' : `${name}:${value}`))).toEqual([
      'fill:', 'sleep', 'key:h', 'sleep', 'key:é', 'sleep', 'key:!', 'sleep', 'press:Enter',
    ])
  })

  it('a long text types for at most 10 s and inserts the rest at once', async () => {
    const { log, page, target, sleep } = fakes()
    const text = 'x'.repeat(500)
    await humanInput(seeded(5), sleep).type(page, target, text, false, 'slow', 20_000)
    const after = log.slice(log.findIndex(([name]) => name === 'up') + 1)
    const typed = after.filter(([name]) => name === 'key').length
    const waited = after.filter(([name]) => name === 'sleep').reduce((sum, [, ms]) => sum + (ms as number), 0)
    expect(typed).toBeGreaterThan(10)
    expect(typed).toBeLessThan(text.length)
    expect(waited).toBeLessThanOrEqual(10_000)
    expect(after.at(-1)).toEqual(['insert', 'x'.repeat(text.length - typed)])
  })
})
