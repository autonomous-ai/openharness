/**
 * The raise on GNOME Shell, through the Activate Window By Title extension (docs/plans/2026-11-19-dial-linux-design.md
 * § 2.3): the shell offers no other way to activate a window from outside, and the extension matches by class only
 * (`get_wm_class()`: a native window's Wayland app id, an XWayland window's WM_CLASS class), so the pids go unused and
 * each spelling of the app's class is asked in turn (RECORDED_GNOME_SHELL).
 */
import { isSessionBus, isWindowClass } from './linuxDesktop.js'
import type { RaiseBackend, RaiseRun } from './linuxRaise.js'
import { RUN_TIMEOUT_MS } from './orca.js'

const HIT = '(true,)'
const MISS = '(false,)'

export function createGnomeRaise(deps: RaiseRun, bus: string): RaiseBackend {
  return {
    async raise({ classes }) {
      if (!isSessionBus(bus)) return false
      const wanted = classes.filter(isWindowClass)
      if (wanted.length === 0) return false
      const gdbus = deps.onPath('gdbus')
      if (!gdbus) return false
      for (const cls of wanted) {
        const { code, stdout } = await deps.run(gdbus, [
          'call', '--address', bus, '--dest', 'org.gnome.Shell', '--object-path', '/de/lucaswerkmeister/ActivateWindowByTitle',
          '--method', 'de.lucaswerkmeister.ActivateWindowByTitle.activateByWmClass', cls,
        ], RUN_TIMEOUT_MS).catch(() => ({ code: null, stdout: '' }))
        if (code === 0 && stdout.trim() === HIT) return true
        // Anything but a plain miss (the extension turned off, the shell gone, a timeout) fails the next spelling too.
        if (code !== 0 || stdout.trim() !== MISS) return false
      }
      return false
    },
  }
}
