/**
 * The raise on Hyprland (docs/plans/2026-11-19-dial-linux-design.md § 2.3): `hyprctl clients -j` lists the windows,
 * then `dispatch focuswindow` brings forward the one of the first pid that owns a window, else the first of the class.
 */
import type { RaiseBackend, RaiseRun } from './linuxRaise.js'
import { RUN_TIMEOUT_MS } from './orca.js'

// The window's pointer as Hyprland prints it: anything else could add a second matcher to the dispatch's argument.
const ADDRESS = /^0x[0-9a-f]{1,16}$/
// hyprctl exits 0 for every reply, a miss's error too (RECORDED_HYPRLAND.focusNoMatch): only this one says it focused.
const FOCUSED = 'ok\n'

interface Window { pid: unknown; class: unknown; initialClass: unknown; address: unknown }

export function createHyprlandRaise(deps: RaiseRun, signature: string): RaiseBackend {
  const run = (hyprctl: string, args: string[]) =>
    deps.run(hyprctl, ['-i', signature, ...args], RUN_TIMEOUT_MS).catch(() => ({ code: null, stdout: '' }))
  const windowsIn = (stdout: string): Window[] | undefined => {
    try {
      const parsed: unknown = JSON.parse(stdout)
      return Array.isArray(parsed) && parsed.every((w) => typeof w === 'object' && w !== null) ? parsed as Window[] : undefined
    } catch {
      return undefined
    }
  }
  // `class`, else the one it was made with: a window that has none now is still found by its app.
  const classOf = (w: Window) => (typeof w.class === 'string' && w.class !== '' ? w.class : w.initialClass)
  const targetIn = (windows: Window[], pids: number[], classes: readonly string[]) => {
    const pid = pids.find((p) => windows.some((w) => w.pid === p))
    if (pid !== undefined) return `pid:${pid}`
    for (const spelling of classes.map((c) => c.toLowerCase())) {
      const window = windows.find((w) => {
        const name = classOf(w)
        return typeof name === 'string' && name.toLowerCase() === spelling && typeof w.address === 'string' && ADDRESS.test(w.address)
      })
      if (window !== undefined) return `address:${window.address as string}`
    }
    return undefined
  }

  return {
    async raise({ pids, classes }) {
      const hyprctl = deps.onPath('hyprctl')
      // pid 1 holds every orphan, so it names no agent's window.
      const wanted = pids.filter((p) => Number.isInteger(p) && p > 1)
      if (hyprctl === null || (wanted.length === 0 && classes.length === 0)) return false
      const listing = await run(hyprctl, ['clients', '-j'])
      const windows = listing.code === 0 ? windowsIn(listing.stdout) : undefined
      if (windows === undefined) return false
      const target = targetIn(windows, wanted, classes)
      if (target === undefined) return false
      const focused = await run(hyprctl, ['dispatch', 'focuswindow', target])
      return focused.code === 0 && focused.stdout === FOCUSED
    },
  }
}
