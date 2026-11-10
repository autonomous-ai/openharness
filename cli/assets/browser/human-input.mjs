// Human-like mouse and keyboard for the tool server, ported from the prior art's human-input.ts. Every duration is
// log-normal, resampled inside its range rather than clamped (so draws do not pile up at the bounds), and scaled by
// one tempo per tool server. All randomness comes through `rng`, so tests are exact.

// Typing stops being per key after this long, so a long text still ends inside the tool's 20 s limit.
const TYPE_MS = 10_000

const KEYS = {
  slow: { median: 190, lo: 70, hi: 700 },
  normal: { median: 110, lo: 40, hi: 450 },
  fast: { median: 60, lo: 25, hi: 250 },
}
const KEY_SIGMA = 0.35

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function gaussian(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng())
}

function logNormal(median, sigma, lo, hi, rng) {
  let v = median
  for (let i = 0; i < 8; i += 1) {
    v = median * Math.exp(sigma * gaussian(rng))
    if (v >= lo && v <= hi) return v
  }
  return clamp(v, lo, hi)
}

const logNormalRange = (lo, hi, rng, tempo) => logNormal(Math.sqrt(lo * hi) * tempo, 0.3, lo * tempo, hi * tempo, rng)

/** The call's `params._harness`: its human mode. Human input is on by default, so anything else is normal. */
export function modeOf(harness) {
  return ['off', 'slow', 'fast'].includes(harness?.human) ? harness.human : 'normal'
}

/**
 * A cubic Bezier from `from` to a random point in the middle half of `box`, with two control points offset to one
 * side and a little jitter, in 12 to 60 steps. Each point carries the wait before it: short mid-path, longer at the
 * ends. With `viewport`, every point but the last stays inside it, since a mouse event off the page is a tell.
 */
export function mousePath(from, box, rng, { tempo = 1, viewport } = {}) {
  const to = { x: box.x + box.width * (0.25 + 0.5 * rng()), y: box.y + box.height * (0.25 + 0.5 * rng()) }
  const inside = p => (viewport
    ? { x: clamp(p.x, 0, viewport.width - 1), y: clamp(p.y, 0, viewport.height - 1) }
    : p)
  const delay = t => logNormal((11 - 5.5 * Math.sin(Math.PI * t ** 0.8)) * tempo, 0.2, 4 * tempo, 14 * tempo, rng)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)
  if (dist < 0.5) return [{ ...to, delayMs: delay(1) }]
  const steps = clamp(Math.round(dist / 12), 12, 60)
  const ux = dx / dist
  const uy = dy / dist
  const control = t => {
    const side = (rng() * 2 - 1) * dist * 0.2
    const along = (rng() * 2 - 1) * dist * 0.05
    return inside({ x: from.x + dx * t - uy * side + ux * along, y: from.y + dy * t + ux * side + uy * along })
  }
  const c1 = control(1 / 3)
  const c2 = control(2 / 3)
  const jitter = Math.min(1, dist / 4)
  const path = []
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    const u = 1 - t
    const point = i === steps ? to : inside({
      x: u ** 3 * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * to.x + (rng() * 2 - 1) * jitter,
      y: u ** 3 * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * to.y + (rng() * 2 - 1) * jitter,
    })
    path.push({ ...point, delayMs: delay(t) })
  }
  return path
}

/** One wait per code point of `text`, before its key, log-normal around the speed's median and inside its range. */
export function keyDelays(text, speed, rng, tempo = 1) {
  const { median, lo, hi } = KEYS[speed]
  return Array.from(text, () => logNormal(median * tempo, KEY_SIGMA, lo * tempo, hi * tempo, rng))
}

/**
 * Clicks and typing on Playwright's page and locator, as a person would, or at once when the mode is `off`. One
 * tempo for the tool server's life: a person is a little faster or slower than the table all session, not per key.
 */
export function humanInput(rng, sleep) {
  const tempo = 1 + 0.25 * clamp(gaussian(rng) / 2, -1, 1)
  // Where the mouse was left, per page: the next path starts there.
  const last = new WeakMap()

  async function click(page, target, mode, timeout) {
    if (mode === 'off') return target.click({ timeout })
    await target.scrollIntoViewIfNeeded({ timeout })
    const box = await target.boundingBox({ timeout })
    if (!box) return target.click({ timeout })
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const from = last.get(page) ?? { x: viewport.width / 2, y: viewport.height / 2 }
    const path = mousePath(from, box, rng, { tempo, viewport })
    for (const point of path) {
      await sleep(point.delayMs)
      await page.mouse.move(point.x, point.y)
    }
    last.set(page, path.at(-1))
    await sleep(logNormalRange(60, 220, rng, tempo))
    await page.mouse.down()
    await sleep(logNormalRange(40, 120, rng, tempo))
    await page.mouse.up()
  }

  async function type(page, target, text, submit, mode, timeout) {
    if (mode === 'off') {
      await target.fill(text, { timeout })
      if (submit) await target.press('Enter', { timeout })
      return
    }
    await click(page, target, mode, timeout)
    await target.fill('', { timeout })
    const keys = Array.from(text)
    const delays = keyDelays(`${text}${submit ? '\n' : ''}`, mode, rng, tempo)
    let spent = 0
    for (const [n, key] of keys.entries()) {
      if (spent + delays[n] > TYPE_MS) {
        await page.keyboard.insertText(keys.slice(n).join(''))
        break
      }
      spent += delays[n]
      await sleep(delays[n])
      await page.keyboard.type(key)
    }
    if (submit) {
      await sleep(delays.at(-1))
      await page.keyboard.press('Enter')
    }
  }

  return { click, type }
}
