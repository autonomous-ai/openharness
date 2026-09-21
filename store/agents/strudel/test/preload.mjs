// Loaded with `node --import` into the viewer under test, never in production (see viewer.test.mjs).
// SIGTERM exits through process.exit, so V8 coverage is written when a test stops the viewer; and
// with VIEWER_TEST_FAST_TIMERS set, timers of 10 s or more run 50 times sooner, so the 20-second
// keep-alive ping is reached in a test instead of after a wait.
process.on('SIGTERM', () => process.exit(0))

if (process.env.VIEWER_TEST_FAST_TIMERS) {
  const { setTimeout: later, setInterval: every } = globalThis
  const scale = (ms) => (ms >= 10_000 ? ms / 50 : ms)
  globalThis.setTimeout = (fn, ms, ...args) => later(fn, scale(ms), ...args)
  globalThis.setInterval = (fn, ms, ...args) => every(fn, scale(ms), ...args)
}
