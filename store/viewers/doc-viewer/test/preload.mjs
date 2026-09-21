// Loaded into the viewer under test with `node --import`, so the server itself carries no test hooks.
// Everything is driven by the environment the test starts it with:
//
//   TEST_TIMERS="20000=50,3000=40"   those exact setTimeout/setInterval delays run faster
//   TEST_WATCH=throw                 fs.watch is unavailable, as on filesystems that cannot watch
//   TEST_WATCH_EMIT='["a", null]'    the real watcher also reports these names (null: no filename)
//   TEST_PLATFORM=linux|win32        process.platform, for the per-OS branches
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const timers = new Map(String(process.env.TEST_TIMERS ?? '').split(',').filter(Boolean).map((pair) => pair.split('=').map(Number)))
for (const name of ['setTimeout', 'setInterval']) {
  const original = globalThis[name]
  globalThis[name] = (fn, ms, ...args) => original(fn, timers.get(ms) ?? ms, ...args)
}

if (process.env.TEST_PLATFORM) Object.defineProperty(process, 'platform', { value: process.env.TEST_PLATFORM })

const realWatch = fs.watch
if (process.env.TEST_WATCH === 'throw') {
  fs.watch = () => { throw new Error('watch unavailable here') }
} else if (process.env.TEST_WATCH_EMIT) {
  const names = JSON.parse(process.env.TEST_WATCH_EMIT)
  fs.watch = (...args) => {
    const watcher = realWatch(...args)
    setTimeout(() => { for (const name of names) watcher.emit('change', 'change', name) }, 30)
    return watcher
  }
}
syncBuiltinESMExports()
