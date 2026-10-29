import { expect, it, vi } from 'vitest'
import { buddyRefusal, WINDOWS_BUDDY } from './buddyPane.js'

const where = { port: 14001, dataDir: '/fixture', machineId: 'machine' }
const BUDDY = 'A Buddy talks with its owner in its own chat: it may not send to, start, tell or close other sessions.'
// This command runs in pane %42 (its process 700 is an ancestor, under the tmux server 600); %7 is another harness's.
const probe = () => ({ panes: vi.fn(() => [{ pane: '%7', pid: 500 }, { pane: '%42', pid: 700 }]), ancestors: vi.fn(() => [{ pid: 900, command: 'node' }, { pid: 700, command: '/bin/zsh' }, { pid: 600, command: 'tmux' }, { pid: 1, command: '/sbin/launchd' }]) })

/** This machine's daemon: harness `pane-harness` runs in pane %42, and the Swarm's service answers [check] for whether it,
 *  or any harness here, is a Buddy. */
function daemon(check: (payload: Record<string, unknown>) => Record<string, unknown>) {
  const close = vi.fn()
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    if (type === 'agents_list') return { agents: [{ id: 'pane-harness', engine: 'claude', tmuxPane: '%42', status: 'active' }] }
    if (type === 'super_tabs' && payload.action === 'buddyCheck') return check(payload)
    // The daemon's own pane %42 is process 700, this command's ancestor.
    if (type === 'terminal_info' && payload.agentId === 'pane-harness') return { command: 'claude', path: '/work', pid: 700, tty: '/dev/ttys001' }
    return { error: 'UNSUPPORTED' }
  })
  return { close, request, deps: { where: () => where, open: async () => ({ request, close, machineId: 'machine' }), probe: probe(), env: {} } }
}
const swarm = (buddy: boolean, buddiesHere = buddy) => (payload: Record<string, unknown>) =>
  payload.harnessId === undefined ? { ok: true, buddiesHere } : { ok: true, buddy: payload.harnessId === 'pane-harness' && buddy }

// Security review of #2087: a Buddy's pane could reach the person's other sessions with harness send, new, tell and close.
it('refuses a Buddy\'s pane, as this computer\'s launch record says', async () => {
  const d = daemon(swarm(true))
  expect(await buddyRefusal(d.deps, 'darwin')).toBe(BUDDY)
  expect(d.request).toHaveBeenCalledWith('super_tabs', { action: 'buddyCheck', harnessId: 'pane-harness' }, 10_000)
  expect(d.close).toHaveBeenCalledOnce()
})

it('lets Leads, Builders, Reviewers, harnesses in no Swarm and a person\'s terminal go on', async () => {
  expect(await buddyRefusal(daemon(swarm(false)).deps, 'darwin')).toBeNull()
  const outside = daemon(swarm(true))
  expect(await buddyRefusal({ ...outside.deps, probe: { panes: () => [], ancestors: () => [{ pid: 900, command: 'node' }, { pid: 1, command: '/sbin/launchd' }] } }, 'darwin')).toBeNull()
})

// The second review: with the Swarm off nothing may change, so whether it is on is settled before any pane is looked at.
it('changes nothing with the Swarm off, or on a daemon from before the check: no pane is looked at, nobody refused', async () => {
  for (const answer of [{ error: 'SERVICE_UNAVAILABLE', service: 'superTabs', retryable: false }, { error: 'UNSUPPORTED' }, { error: 'INVALID_REQUEST' }]) {
    const d = daemon(() => answer)
    expect(await buddyRefusal({ ...d.deps, env: { TMUX_PANE: '%7' } }, 'darwin')).toBeNull()
    expect(d.deps.probe.panes).not.toHaveBeenCalled()
  }
})

it('leaves a daemon that is not running to the command, which says so as it always has', async () => {
  expect(await buddyRefusal({ where: () => where, probe: probe(), env: {}, open: async () => { throw new Error('no daemon') } }, 'darwin')).toBeNull()
})

it('refuses a command that names another pane than the one it runs in, and finds the Buddy with TMUX_PANE unset', async () => {
  const d = daemon(swarm(false))
  expect(await buddyRefusal({ ...d.deps, env: { TMUX_PANE: '%7' } }, 'darwin'))
    .toBe('This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.')
  expect(await buddyRefusal(daemon(swarm(true)).deps, 'darwin')).toBe(BUDDY)
})

// Windows has no cheap check of a pty host pane: while a Buddy runs on that computer, an agent's shell may not.
it('fails closed on Windows while this computer runs a Buddy, for an agent\'s shell, and leaves a person\'s terminal alone', async () => {
  const agentShells = [{ HARNESS_PANE: 'p1:%3' }, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }, { CODEX_THREAD_ID: 't' }]
  for (const env of agentShells) {
    expect(await buddyRefusal({ ...daemon(swarm(false, true)).deps, env }, 'win32')).toBe(WINDOWS_BUDDY)
    expect(await buddyRefusal({ ...daemon(swarm(false, false)).deps, env }, 'win32')).toBeNull()
  }
  expect(await buddyRefusal({ ...daemon(swarm(false, true)).deps, env: {} }, 'win32')).toBeNull()
})

// Re-check 1 of #2093 (minor 7): with the Swarm on, an error on the harness's own question read as "no Buddy".
it('refuses when the Swarm is on but cannot answer for this harness', async () => {
  for (const failed of [{ error: 'SERVICE_FAILED', service: 'superTabs' }, { error: 'SERVICE_UNAVAILABLE', retryable: true }, { ok: true }]) {
    const d = daemon(payload => payload.harnessId === undefined ? { ok: true, buddiesHere: false } : failed)
    expect(await buddyRefusal(d.deps, 'darwin'))
      .toBe('Harness could not confirm whether this harness is a Buddy just now, so it did not run this. Try again in a moment.')
  }
})

// Re-check 2 of #2093 (important 6): a private tmux server's pane that has another harness's pane id is not that harness.
it('refuses a pane whose harness\'s own pane, as the daemon reads it, is not among the command\'s parents', async () => {
  const d = daemon(swarm(false))
  const request = d.request.getMockImplementation()!
  d.request.mockImplementation(async (type: string, payload: Record<string, unknown> = {}) =>
    type === 'terminal_info' ? { command: 'claude', path: '/work', pid: 555, tty: '/dev/ttys001' } : request(type, payload))
  expect(await buddyRefusal(d.deps, 'darwin'))
    .toBe('This command does not run in the Harness pane it names, so it did not run. Run it as your harness gave it, in its own pane.')
})

// Re-check 2 of #2093 at 0648a8690 (minor 8): a failed Swarm answer read as "the Swarm is off", which skipped the Buddy check
// and Windows' backstop. Off is only a daemon without the request, or a Swarm switched off for good.
it('refuses when the Swarm cannot say whether it is on, on every platform', async () => {
  const UNSURE = 'Harness could not reach this computer\'s Swarm just now, so it did not run this. Try again in a moment.'
  for (const platform of ['darwin', 'win32'] as const) {
    for (const answer of [{ error: 'SERVICE_FAILED', service: 'superTabs' }, { error: 'SERVICE_UNAVAILABLE', service: 'superTabs', retryable: true },
      { error: 'INTERNAL' }, { ok: false }]) {
      expect(await buddyRefusal({ ...daemon(() => answer).deps, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' } }, platform)).toBe(UNSURE)
    }
    // No answer in time.
    const d = daemon(() => { throw new Error('Harness did not answer super_tabs in time. Try again.') })
    expect(await buddyRefusal({ ...d.deps, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' } }, platform)).toBe(UNSURE)
  }
})
