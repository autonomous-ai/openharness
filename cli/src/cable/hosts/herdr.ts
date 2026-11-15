/**
 * A herdr pane (docs/specs/2026-11-15-device-host-adapter.md): a tap focuses its agent by `herdr agent focus`, then the
 * app around herdr comes forward as every app does. The pane id came from a hook, so it is checked against its form
 * before the command, which runs with no shell.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

/** herdr's pane id, `w1:p1` (its own guide). */
const HERDR_PANE = /^w[0-9]{1,9}:p[0-9]{1,9}$/

export function createHerdrAdapter(deps: OrcaDeps): HostAdapter {
  return {
    id: 'herdr',
    tap: 'before',
    paneOf(place: Place): Pane | undefined {
      const id = place.hints.HERDR_PANE_ID
      return id && HERDR_PANE.test(id) ? { adapter: 'herdr', id } : undefined
    },
    canFocus: () => true,
    async focus(pane) {
      if (!HERDR_PANE.test(pane.id)) return false
      const herdr = deps.onPath('herdr')
      return herdr ? (await deps.run(herdr, ['agent', 'focus', pane.id], RUN_TIMEOUT_MS)).code === 0 : false
    },
  }
}
