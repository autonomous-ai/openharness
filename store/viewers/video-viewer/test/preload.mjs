// Loaded with --import into a viewer under test (never by the viewer itself):
//
//   TEST_TIMERS="250=1500,20000=100"  a timer asked for with one delay runs with the other, so a test
//                                     sees a ping, a poll or a settled burst without waiting for it
//   TEST_WATCH=null-name              the watcher also reports one change with no file name, which
//                                     fs.watch is allowed to do
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const delays = new Map(String(process.env.TEST_TIMERS ?? '').split(',').filter(Boolean).map((pair) => pair.split('=').map(Number)))
const later = globalThis.setTimeout
for (const name of ['setTimeout', 'setInterval']) {
  const original = globalThis[name]
  globalThis[name] = (fn, ms, ...args) => original(fn, delays.get(ms) ?? ms, ...args)
}

if (process.env.TEST_WATCH === 'null-name') {
  const watch = fs.watch
  fs.watch = (...args) => {
    const watcher = watch(...args)
    later(() => watcher.emit('change', 'rename', null), 50)
    return watcher
  }
  syncBuiltinESMExports()
}
