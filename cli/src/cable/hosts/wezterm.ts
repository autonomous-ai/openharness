/**
 * A WezTerm pane (docs/specs/2026-11-15-device-host-adapter.md): a tap activates it by `wezterm cli`, then WezTerm comes
 * forward as every app does. The pane id came from a hook, so it is checked against its form before the command, which
 * runs with no shell.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

const APP_WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm'
const WEZTERM_PANE = /^[0-9]{1,9}$/

export function createWeztermAdapter(deps: OrcaDeps): HostAdapter {
  const mac = deps.platform === 'darwin'
  return {
    id: 'wezterm',
    tap: 'before',
    paneOf(place: Place): Pane | undefined {
      const id = place.hints.WEZTERM_PANE
      return id && WEZTERM_PANE.test(id) ? { adapter: 'wezterm', id } : undefined
    },
    // `wezterm cli` runs on every platform.
    canFocus: () => true,
    async focus(pane) {
      if (!WEZTERM_PANE.test(pane.id)) return false
      const wezterm = deps.onPath('wezterm') ?? (mac && deps.exists(APP_WEZTERM) ? APP_WEZTERM : null)
      return wezterm ? (await deps.run(wezterm, ['cli', 'activate-pane', '--pane-id', pane.id], RUN_TIMEOUT_MS)).code === 0 : false
    },
  }
}
