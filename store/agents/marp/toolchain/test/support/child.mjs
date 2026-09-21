// Preloaded (`node --import`) into the viewer processes the tests start and stop. V8 writes coverage
// only when a process exits cleanly, so SIGTERM exits; and the viewer's 20-second keep-alive ping is
// sent every 50 ms here, so a test can see one without waiting.
process.on('SIGTERM', () => process.exit(0))
const setIntervalOriginal = globalThis.setInterval
globalThis.setInterval = (fn, ms, ...args) => setIntervalOriginal(fn, ms === 20_000 ? 50 : ms, ...args)
