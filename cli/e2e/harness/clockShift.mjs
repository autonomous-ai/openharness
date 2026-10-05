// Preloaded (`node --import`) into every Node process of a test that moves the wall clock: the daemon's
// master and core, and the fake engines, which inherit NODE_OPTIONS through tmux. `Date` reads the
// offset in E2E_CLOCK_SHIFT_FILE (milliseconds; re-read when the file changes), so a test can jump the
// wall clock forward, as a laptop's sleep does, or back, as an NTP correction does. The monotonic
// clocks (`performance.now`, timers) are untouched: on macOS they do not count a sleep either.
import { readFileSync, statSync } from 'node:fs'

const file = process.env.E2E_CLOCK_SHIFT_FILE
const RealDate = Date
const realNow = RealDate.now.bind(RealDate)
let offset = 0
let seen = -1
let checkedAt = 0

function shift() {
  const now = realNow()
  if (file && now - checkedAt >= 50) {
    checkedAt = now
    try {
      const changed = statSync(file).mtimeMs
      if (changed !== seen) { seen = changed; offset = Number(readFileSync(file, 'utf8').trim()) || 0 }
    } catch { /* no file yet: no shift */ }
  }
  return offset
}

globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return args.length ? Reflect.construct(target, args, newTarget) : Reflect.construct(target, [realNow() + shift()], newTarget)
  },
  apply() {
    return new RealDate(realNow() + shift()).toString()
  },
  get(target, property, receiver) {
    if (property === 'now') return () => realNow() + shift()
    return Reflect.get(target, property, receiver)
  },
})
