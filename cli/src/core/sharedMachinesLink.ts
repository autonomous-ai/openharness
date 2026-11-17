/**
 * Shared machines in their own process (the edge host; services/sharedMachinesProcess.ts), as the core
 * reaches it: a guest's harness (`guestLaunch`), asked when a guest's New Harness arrives and never in a
 * connection's line. An answer that does not come (the process is down, or slower than its wait,
 * core/api.ts `LONG_ANSWERS`), or one not shaped as a launch, is the fallback: guest access unavailable.
 * The fixed command must match the request's guest, engine, permissions and prompt before a pane can run it.
 */
import { GUEST_LAUNCH_UNAVAILABLE, type GuestLaunch, type GuestLaunchInput, type SharedMachinesCorePort } from './api.js'
import { guestUserFor, guestWorkspaceFor } from '../lib/guestUser.js'
import { GUEST_HELPER_PATH, GUEST_PANE_BOOTSTRAP, guestEngineArgv } from '../lib/guestLaunchWire.js'
import { launchContributionIn, launchRecord, launchText } from '../lib/launchContribution.js'
import { isAbsolute, resolve, win32 } from 'node:path'

/** Ask shared machines' process (core/serviceLinks.ts `call`, for `sharedMachines`): never rejects. */
export type CallSharedMachines = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>

/** Only the requested guest's declared command is admitted, including the inline compatibility path. */
export function guestLaunchIn(value: unknown, input: GuestLaunchInput): GuestLaunch | null {
  if (!launchRecord(value)) return null
  if (value.ok === false) return launchText(value.error) && (value.detail === undefined || launchText(value.detail))
    ? { ok: false, error: value.error, ...(value.detail !== undefined ? { detail: value.detail } : {}) } : null
  if (value.ok !== true || !launchText(value.workspace) || (input.engine !== 'claude' && input.engine !== 'codex')) return null
  const windows = value.guestHostUser !== undefined
  if (process.platform === 'win32' && !windows) return null
  const user = guestUserFor(input.email)
  if (windows && value.guestHostUser !== user) return null
  const fallback = guestWorkspaceFor(input.email, windows ? 'win32' : process.platform)
  const requested = input.cwd && (windows ? win32.isAbsolute(input.cwd) : isAbsolute(input.cwd))
    ? (windows ? win32.resolve(input.cwd) : resolve(input.cwd)) : null
  const workspace = value.workspace
  if (workspace !== fallback && workspace !== requested) return null
  const contribution = launchContributionIn({ args: value.argv, env: value.env })
  if (!contribution) return null
  const { env, args } = contribution
  const engine = guestEngineArgv({ ...input, engine: input.engine })
  let expected: string[]
  if (windows) {
    if (Object.keys(env).length) return null
    expected = engine
  } else {
    if (Object.keys(env).length !== 3 || env.TERM !== 'xterm-256color' || env.COLORTERM !== 'truecolor' || !env.LANG) return null
    expected = ['/bin/sh', '-c', GUEST_PANE_BOOTSTRAP, 'harness-guest', GUEST_HELPER_PATH, user, workspace, input.engine,
      'sudo', '-n', GUEST_HELPER_PATH, 'run', user, '--cwd', workspace, '--pass', 'TERM', '--pass', 'COLORTERM', '--pass', 'LANG', '--', ...engine]
  }
  if (args.length !== expected.length || args.some((arg, index) => arg !== expected[index])) return null
  return { ok: true, workspace, argv: args, env, ...(windows ? { guestHostUser: user } : {}) }
}

export function createSharedMachinesLink(call: CallSharedMachines): SharedMachinesCorePort {
  return {
    guestLaunch: async (input): Promise<GuestLaunch> => {
      const captured = { ...input, ...(input.permissionFlags ? { permissionFlags: [...input.permissionFlags] } : {}) }
      const answer = guestLaunchIn(await call('guestLaunch', { ...input }), captured)
      if (!answer) console.warn('[shared-machines] LAUNCH_CONTRIBUTION_REFUSED')
      return answer ?? GUEST_LAUNCH_UNAVAILABLE
    },
    // The process stops its own relay.
    stop: () => {},
  }
}
