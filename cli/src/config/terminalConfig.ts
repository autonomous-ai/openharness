import type { TerminalBackendName } from '../lib/terminalTypes.js'

/** Every backend the daemon drives. Herdr is local to this machine; absent binary is a probe miss, not a boot failure. */
export const ALL_TERMINAL_BACKENDS: readonly TerminalBackendName[] = ['tmux', 'herdr']

function strictList(value: string, field: string): string[] {
  const parts = value.split(',').map((part) => part.trim())
  if (!parts.length || parts.some((part) => !part)) {
    throw new Error(`${field} must be a non-empty comma-separated list`)
  }
  if (new Set(parts).size !== parts.length) throw new Error(`${field} must not contain duplicates`)
  return parts
}

/** A pin. Unset means both backends. An unknown name is still an error. */
export function parseTerminalBackends(value = 'tmux,herdr'): TerminalBackendName[] {
  const values = strictList(value, 'TERMINAL_BACKENDS')
  const kept: TerminalBackendName[] = []
  for (const backend of values) {
    if (backend === 'tmux' || backend === 'herdr') { kept.push(backend); continue }
    throw new Error(`TERMINAL_BACKENDS contains unsupported backend "${backend}"; expected tmux, herdr, or tmux,herdr`)
  }
  return kept
}
