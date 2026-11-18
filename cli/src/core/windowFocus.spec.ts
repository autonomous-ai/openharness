import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { createWindowFocus } from './windowFocus.js'

function fixture() {
  let target: RegisteredSession | undefined = { agentId: 'agent', sessionId: 'session', engine: 'claude', active: true,
    processIdentity: { pid: 42, startMarker: 'birth', executable: 'claude' }, evidenceRevision: 1,
    runtimes: [{ backend: 'tmux', paneId: '%1' }] } as RegisteredSession
  let validator: object | null = {}
  let machineId = 'local'
  const validate = vi.fn(async (_revision: string, _connection: string) => true), changed = vi.fn()
  const owner = createWindowFocus({ machineId: () => machineId, byAgent: id => id === 'agent' ? target : undefined,
    validator: () => validator, validate, changed })
  const conditional = () => owner.select('local', 'agent', 'window', 'current')
  const choose = async () => {
    const apply = await conditional()
    return typeof apply === 'function' ? apply() : apply
  }
  return { owner, target: () => target!, validate, changed, conditional, choose,
    replaceValidator: (value: object | null) => { validator = value }, deleted: () => { target = undefined },
    machine: (value: string) => { machineId = value } }
}

describe('the core owns final window focus', () => {
  it('applies explicit local and remote choices immediately and isolates its state from consumers', () => {
    const f = fixture()
    expect(f.owner.state()).toEqual({ form: null, voice: null })
    expect(f.owner.select('remote', 'remote-agent', 'remote-window')).toBe(true)
    expect(f.validate).not.toHaveBeenCalled()
    const state = f.owner.state()
    state.voice!.agentId = 'consumer mutation'
    state.form!.connId = 'consumer mutation'
    expect(f.owner.state()).toEqual({ form: { machineId: 'remote', connId: 'remote-window' },
      voice: { machineId: 'remote', agentId: 'remote-agent', connId: 'remote-window' } })
    f.owner.select('local', null, 'other-window')
    expect(f.owner.state().voice?.agentId).toBe('remote-agent')
    f.owner.select('remote', null, 'remote-window')
    expect(f.owner.state().voice).toBeNull()
    expect(f.changed).toHaveBeenCalledTimes(3)
  })

  it('applies an accepted conditional choice only when its final closure runs', async () => {
    const f = fixture()
    const apply = await f.conditional()
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.validate).toHaveBeenCalledExactlyOnceWith('current', 'window')
    expect(typeof apply === 'function' && apply()).toBe(true)
    expect(f.owner.state()).toEqual({ form: { machineId: 'local', connId: 'window' },
      voice: { machineId: 'local', agentId: 'agent', connId: 'window' } })
  })

  it('keeps rejected or failed validation from changing state', async () => {
    const f = fixture()
    f.validate.mockResolvedValueOnce(false)
    expect(await f.choose()).toBe(false)
    f.validate.mockRejectedValueOnce(new Error('validator unavailable'))
    await expect(f.conditional()).rejects.toThrow('validator unavailable')
    expect(f.changed).not.toHaveBeenCalled()
  })

  it.each(['missing-validator', 'missing-target', 'held-target', 'remote', 'empty', 'long', 'null-target'] as const)('refuses %s conditional authority before making a request', async kind => {
    const f = fixture()
    if (kind === 'missing-validator') f.replaceValidator(null)
    if (kind === 'missing-target') f.deleted()
    if (kind === 'held-target') f.target().identityHold = 'held'
    expect(f.owner.select(kind === 'remote' ? 'remote' : 'local', kind === 'null-target' ? null : 'agent', 'window',
      kind === 'empty' ? '' : kind === 'long' ? 'r'.repeat(129) : 'current')).toBe(false)
    expect(f.validate).not.toHaveBeenCalled()
    expect(f.changed).not.toHaveBeenCalled()
  })

  it.each(['validator', 'machine', 'deleted', 'held', 'session', 'birth', 'route', 'explicit', 'empty-window', 'disconnect'] as const)('refuses an accepted answer after a later %s change', async kind => {
    const f = fixture()
    f.owner.select('local', 'agent', 'window')
    const apply = await f.conditional()
    if (kind === 'validator') f.replaceValidator({})
    if (kind === 'machine') f.machine('replacement')
    if (kind === 'deleted') f.deleted()
    if (kind === 'held') f.target().identityHold = 'held'
    if (kind === 'session') f.target().sessionId = 'replacement'
    if (kind === 'birth') f.target().processIdentity!.startMarker = 'replacement'
    if (kind === 'route') f.target().runtimes[0]!.paneId = '%2'
    if (kind === 'explicit') f.owner.select('remote', 'explicit', 'other-window')
    if (kind === 'empty-window') f.owner.select('local', null, 'other-window')
    if (kind === 'disconnect') f.owner.disconnected('window')
    f.changed.mockClear()
    expect(typeof apply === 'function' && apply()).toBe(false)
    expect(f.changed).not.toHaveBeenCalled()
  })

  it('lets only the first of two delayed acknowledgments apply and preserves a newer window on old disconnect', async () => {
    const f = fixture()
    const first = await f.conditional(), second = await f.conditional()
    expect(typeof first === 'function' && first()).toBe(true)
    expect(typeof second === 'function' && second()).toBe(false)
    f.owner.select('remote', 'newer', 'other-window')
    f.changed.mockClear()
    expect(f.owner.disconnected('window')).toEqual(f.owner.state())
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.owner.state().voice?.agentId).toBe('newer')
    expect(f.owner.state().form?.connId).toBe('other-window')
  })
})
