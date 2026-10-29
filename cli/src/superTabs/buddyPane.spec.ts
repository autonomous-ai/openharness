import { expect, it, vi } from 'vitest'
import { buddyRefusal } from './buddyPane.js'

const where = { port: 14001, dataDir: '/fixture', machineId: 'machine' }
const BUDDY = 'A Buddy talks with its owner in its own chat: it may not send to, start, tell or close other sessions.'
const UNSURE = 'Harness could not confirm this harness\'s Swarm role just now, so it did not run this. Try again in a moment.'

/** The daemon of this machine: harness `buddy-harness` runs in pane %42, and the Swarm answers `role` for it. */
function daemon(role: Record<string, unknown>) {
  const close = vi.fn()
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    if (type === 'agents_list') return { agents: [{ id: 'buddy-harness', engine: 'claude', tmuxPane: '%42', status: 'active' }] }
    if (type === 'super_tabs' && payload.action === 'swarmRole' && payload.harnessId === 'buddy-harness') return role
    return { error: 'UNSUPPORTED' }
  })
  return { close, request, deps: { where: () => where, open: async () => ({ request, close, machineId: 'machine' }) } }
}

// Security review of #2087: a Buddy's pane could reach the person's other sessions with harness send, new, tell and close.
it('refuses a Buddy\'s pane', async () => {
  const d = daemon({ ok: true, role: 'buddy', mode: 'orchestration' })
  expect(await buddyRefusal({ ...d.deps, pane: '%42' })).toBe(BUDDY)
  expect(d.close).toHaveBeenCalledOnce()
})

it('lets Leads, Builders, Reviewers and harnesses in no Swarm go on', async () => {
  for (const role of [{ ok: true, role: 'lead', mode: 'orchestration' }, { ok: true, role: 'dev', mode: 'default' }, { ok: true, role: 'review' }, { ok: true, role: null }]) {
    expect(await buddyRefusal({ ...daemon(role).deps, pane: '%42' })).toBeNull()
  }
})

it('asks nothing for a person\'s terminal or a pane that is no harness', async () => {
  const d = daemon({ ok: true, role: 'buddy' })
  expect(await buddyRefusal({ ...d.deps, pane: undefined })).toBeNull()
  expect(await buddyRefusal({ ...d.deps, pane: '%9' })).toBeNull()
  expect(d.request.mock.calls.some(([type]) => type === 'super_tabs')).toBe(false)
})

it('lets a computer with the Swarm off, or a daemon from before it, go on', async () => {
  expect(await buddyRefusal({ ...daemon({ error: 'SERVICE_UNAVAILABLE', service: 'superTabs', retryable: false }).deps, pane: '%42' })).toBeNull()
  expect(await buddyRefusal({ ...daemon({ error: 'UNSUPPORTED' }).deps, pane: '%42' })).toBeNull()
})

it('refuses when the Swarm is on but cannot say in time, or the daemon cannot be asked', async () => {
  // The role lookup's own deadline passed: the answer carries no role.
  for (const role of [{ ok: true }, { error: 'SERVICE_UNAVAILABLE', service: 'superTabs', retryable: true }, { error: 'SERVICE_FAILED' }]) {
    expect(await buddyRefusal({ ...daemon(role).deps, pane: '%42' })).toBe(UNSURE)
  }
  expect(await buddyRefusal({ where: () => where, pane: '%42', open: async () => { throw new Error('no daemon') } })).toBe(UNSURE)
})

it('refuses a command that names another pane than the one it runs in', async () => {
  const d = daemon({ ok: true, role: 'dev' })
  const probe = { panes: () => [{ pane: '%7', pid: 500 }, { pane: '%42', pid: 700 }], ancestors: () => [900, 700, 1] }
  expect(await buddyRefusal({ ...d.deps, probe, env: { TMUX_PANE: '%7' } }))
    .toBe('This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.')
  // TMUX_PANE unset: the pane is still the one it runs in.
  const buddy = daemon({ ok: true, role: 'buddy' })
  expect(await buddyRefusal({ ...buddy.deps, probe, env: {} })).toBe(BUDDY)
})
