// Loaded into a viewer under test with `--import`, never in production. Two hooks, both off unless
// the test's environment asks:
//
//   TEST_TIMERS="20000=40"     setTimeout/setInterval with exactly that delay run after the other one
//                              instead, so a test sees the keep-alive ping without waiting 20 s
//   TEST_WATCH=error|null-name the workspace watcher, as the OS sometimes hands it over: failing after
//                              it started, or reporting changes (every 50 ms) without saying which path
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'

const timers = new Map(String(process.env.TEST_TIMERS ?? '').split(',').filter(Boolean).map((pair) => pair.split('=').map(Number)))
if (timers.size) {
  for (const name of ['setTimeout', 'setInterval']) {
    const original = globalThis[name]
    globalThis[name] = (fn, ms, ...args) => original(fn, timers.get(ms) ?? ms, ...args)
  }
}

const mode = process.env.TEST_WATCH
if (mode) {
  const watch = fs.watch
  fs.watch = (...args) => {
    if (mode === 'null-name') {
      // Isolate the event under test. A real macOS watcher can also announce the
      // newly created workspace itself, even though this test changes no files.
      const watcher = new EventEmitter()
      const listener = args.at(-1)
      if (typeof listener === 'function') watcher.on('change', listener)
      const timer = setInterval(() => watcher.emit('change', 'rename', null), 50)
      timer.unref()
      watcher.close = () => clearInterval(timer)
      return watcher
    }
    const watcher = watch(...args)
    if (mode === 'error') setTimeout(() => watcher.emit('error', new Error('the watcher stopped')), 50)
    return watcher
  }
  syncBuiltinESMExports()
}
