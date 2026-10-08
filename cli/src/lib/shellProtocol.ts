import { isAbsolute } from 'node:path'
/** Always sealed over the relay; replies go only to the requester. */
export const SHELL_REQUESTS = ['shell_capabilities', 'shell_open', 'shell_open_status', 'shell_context_reply', 'shell_visit_status'] as const

/** Checked on both sides of the service link: shell syntax is never accepted as a program. */
export function terminalOpenError(payload: Record<string, unknown>): 'INVALID_ARGV' | 'INVALID_CWD' | null {
  const { argv, cwd } = payload
  if (payload.command !== undefined || !Array.isArray(argv) || argv.length === 0 || argv.length > 256
    || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !argv[0]
    || Buffer.byteLength(JSON.stringify(argv)) > 32 * 1024) return 'INVALID_ARGV'
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0') || Buffer.byteLength(cwd) > 4096) return 'INVALID_CWD'
  return null
}
