/**
 * The named state an OpenClaw pane's screen is in when its TUI cannot work for Harness (read off 2026.11.2,
 * `__fixtures__/screen-*.txt`). With no Gateway the TUI stays open, shows `gateway disconnected`, and reconnects by
 * itself once one is back; with no token it exits; on a Gateway at another host its database is not on this machine.
 */
import { OPENCLAW_STATES } from './contract.js'
import { openclawPaneState, type OpenclawPaneState } from './runtimeProfile.js'

const NAMED: Partial<Record<OpenclawPaneState, string>> = {
  'no-gateway': OPENCLAW_STATES.noGateway,
  'no-token': OPENCLAW_STATES.noToken,
  remote: OPENCLAW_STATES.remote,
}

/** The named state the capture shows, or null for a TUI that works (or a screen that is not OpenClaw's yet). */
export function openclawScreenState(capture: string): string | null {
  const state = openclawPaneState(capture)
  return state ? NAMED[state] ?? null : null
}
