import type { TerminalBackendName } from '../lib/terminalTypes.js'

/** The backends the daemon drives when none are configured: the pty host on Windows, tmux everywhere else. */
export function defaultTerminalBackends(platform: NodeJS.Platform = process.platform): TerminalBackendName[] {
  return platform === 'win32' ? ['ptyhost'] : ['tmux']
}

function strictList(value: string, field: string): string[] {
  const parts = value.split(',').map((part) => part.trim())
  if (!parts.length || parts.some((part) => !part)) {
    throw new Error(`${field} must be a non-empty comma-separated list`)
  }
  if (new Set(parts).size !== parts.length) throw new Error(`${field} must not contain duplicates`)
  return parts
}

/**
 * The backends `value` names, or this platform's defaults when it is unset.
 *
 * `herdr` — a backend earlier builds supported — is dropped with a warning rather than rejected.
 *
 * Rejecting it would be the consistent thing to do — an unknown backend is an error — but the daemon
 * SELF-UPDATES. A machine whose environment still says `TERMINAL_BACKENDS=tmux,herdr` would install a
 * build that then refuses to start, and it would happen unattended, on a computer nobody is watching.
 * Dropping the retired name keeps that machine running on tmux, which is exactly what it would have
 * got by editing the variable by hand. A genuinely unknown backend is still an error.
 */
export function parseTerminalBackends(value?: string, platform: NodeJS.Platform = process.platform): TerminalBackendName[] {
  if (value === undefined) return defaultTerminalBackends(platform)
  const values = strictList(value, 'TERMINAL_BACKENDS')
  const kept: TerminalBackendName[] = []
  for (const backend of values) {
    if (backend === 'tmux' || backend === 'ptyhost') { kept.push(backend); continue }
    if (backend === 'herdr') {
      console.warn('[terminal] TERMINAL_BACKENDS names "herdr", which is no longer a supported backend — ignoring it')
      continue
    }
    throw new Error(`TERMINAL_BACKENDS contains unsupported backend "${backend}"; expected tmux or ptyhost`)
  }
  if (!kept.length) {
    const fallback = defaultTerminalBackends(platform)
    console.warn(`[terminal] TERMINAL_BACKENDS named no supported backend — falling back to ${fallback.join(', ')}`)
    return fallback
  }
  return kept
}
