/**
 * The pane's one render loop. It runs only while the tab is visible, and only while the scene says
 * something moves: draw(now, dt) returns false to sleep until wake(). Everything that touches the page
 * comes in as an option, so the rules are tested without a browser.
 */
export function createLoop({
  frame = (fn) => globalThis.requestAnimationFrame(fn),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
  hidden = () => globalThis.document?.visibilityState === 'hidden',
  report = (error) => { queueMicrotask(() => { throw error }) },
} = {}) {
  let draw = null
  let handle = null
  let last = 0
  let running = false

  function tick(now) {
    handle = null
    if (!running || !draw || hidden()) return
    const dt = last ? Math.min(0.1, Math.max(0, (now - last) / 1000)) : 0
    last = now
    let more
    try { more = draw(now, dt) } catch (error) { report(error); more = false }
    if (more !== false && running && handle === null) handle = frame(tick)
  }
  function wake() {
    if (handle !== null || !running || !draw || hidden()) return
    last = 0
    handle = frame(tick)
  }

  return {
    /** What to draw each frame. */
    set(fn) { draw = typeof fn === 'function' ? fn : null; wake() },
    wake,
    /** The tab is visible: draw again. */
    start() { running = true; wake() },
    /** The tab is hidden: draw nothing. */
    stop() { running = false; if (handle !== null) { cancelFrame(handle); handle = null } },
    get running() { return running && handle !== null },
  }
}
