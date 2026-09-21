// Loaded into the viewer under test with --import, never in production. It lets a test see what
// otherwise takes a clock or an operating system to happen:
//
//   TEST_TIMERS="20000=60,1500=40"   setTimeout / setInterval delays, mapped exactly (others unchanged)
//   TEST_WATCH=nameless              fs.watch reports changes without a file name, as it may on some
//                                    platforms, and nothing else
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const delays = new Map(String(process.env.TEST_TIMERS ?? '').split(',').filter(Boolean).map((pair) => pair.split('=').map(Number)))
for (const name of ['setTimeout', 'setInterval']) {
  const original = globalThis[name]
  globalThis[name] = (fn, ms, ...args) => original(fn, delays.get(ms) ?? ms, ...args)
}

if (process.env.TEST_WATCH === 'nameless') {
  fs.watch = (_path, _options, listener) => {
    const watcher = new EventEmitter()
    watcher.on('change', listener)
    const tick = setInterval(() => watcher.emit('change', 'rename', null), 500) // slower than the settle, or it never settles

    tick.unref()
    watcher.close = () => clearInterval(tick)
    return watcher
  }
  syncBuiltinESMExports()
}
