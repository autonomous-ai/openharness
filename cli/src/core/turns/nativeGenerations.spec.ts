import { describe, expect, it, vi } from 'vitest'
import { createNativeGenerations, type NativeGenerationFact, type NativeGenerationOwner, type NativeGenerationSource } from './nativeGenerations.js'

const owner: NativeGenerationOwner = { agentId: 'agent', sessionId: 'conversation', processKey: 'original-engine-incarnation' }
const fact = (id: string, generationId: string, kind: 'submitted' | 'activity' | 'cancelled'): NativeGenerationFact => ({ id, generationId, kind })
const stop = (id: string, generationId: string, status: 'completed' | 'aborted' | 'error' = 'completed'): NativeGenerationFact =>
  ({ id, generationId, kind: 'stopped', status })
const cancellation = () => ({ requestId: 'fixture-cancel-request', nonce: 'fixture-cancel-nonce',
  agentId: owner.agentId, conversationId: owner.sessionId, frontier: { index: -1, digest: null } })
function setup(facts: readonly NativeGenerationFact[] = []) {
  let current = true
  const source: NativeGenerationSource = { owner: { ...owner }, facts, verify: vi.fn() }
  const read = vi.fn(async () => source)
  const control = createNativeGenerations({ owner: { ...owner }, current: () => current, read })
  return { source, read, control, revoke: () => { current = false } }
}
const all = async (facts: readonly NativeGenerationFact[]) => (await setup(facts).control.inspect()).generations

describe('native generation control', () => {
  it('retains an incarnation barrier for an empty Cancel, late unknown activity and a conversation rebind', async () => {
    const t = setup(), original = cancellation()
    Object.assign(t.source, { cancellations: [original] })
    expect((await t.control.inspect()).selection).toBe('cancelled')
    Object.assign(t.source, { facts: [fact('late-activity', 'previously-unknown', 'activity')] })
    const late = await t.control.inspect()
    expect(late.running.map(turn => turn.id)).toEqual(['previously-unknown'])
    expect(late.selection).toBe('cancelled')
    Object.assign(original, { conversationId: 'a different original conversation' })
    const rebound = await t.control.inspect()
    expect(rebound.selection).toBe('cancelled')
    expect(late.cancellations[0].conversationId).toBe(owner.sessionId)
    expect(Object.isFrozen(late.cancellations)).toBe(true)
    expect(Object.isFrozen(late.cancellations[0].frontier)).toBe(true)
  })

  it.each([null, Array.from({ length: 4097 }, cancellation)])('refuses an incomplete or oversized cancellation collection', async cancellations => {
    const t = setup()
    Object.assign(t.source, { cancellations })
    await expect(t.control.inspect()).rejects.toThrow('cancellation capacity')
  })

  it('refuses a malformed retained cancellation barrier', async () => {
    const t = setup()
    Object.assign(t.source, { cancellations: [{ ...cancellation(), nonce: '' }] })
    await expect(t.control.inspect()).rejects.toThrow('barrier is invalid')
  })

  it('treats queued or rejected submissions as pending, not executing turns', async () => {
    const view = await setup([fact('submit-1', 'one', 'submitted'), fact('submit-2', 'two', 'submitted')]).control.inspect()
    expect(view.selection).toBe('idle')
    expect(view.running).toEqual([])
    expect(view.pending.map(turn => turn.id)).toEqual(['one', 'two'])
    expect(view.pending.every(turn => turn.submitted && !turn.executed && !turn.running)).toBe(true)
  })

  it('admits execution without a submission, as automatic continuations do', async () => {
    const view = await setup([fact('tool', 'continuation', 'activity')]).control.inspect()
    expect(view.selection).toBe('one')
    expect(view.running).toEqual([{ id: 'continuation', submitted: false, executed: true, running: true, factIds: ['tool'] }])
    expect(view.pending).toEqual([])
  })

  it.each(['completed', 'aborted', 'error'] as const)('retains a %s Stop before any start', async status => {
    const events = [stop('stop', 'one', status), fact('late-submit', 'one', 'submitted'), fact('late-output', 'one', 'activity')]
    expect(await all(events)).toEqual([{ id: 'one', submitted: true, executed: true, running: false,
      terminal: status, factIds: ['late-output', 'late-submit', 'stop'] }])
    expect(await all([...events].reverse())).toEqual(await all(events))
  })

  it('settles overlapping generations independently with reversed Stops', async () => {
    const starts = [fact('start-z', 'z', 'activity'), fact('start-a', 'a', 'activity')]
    const overlapping = await setup(starts).control.inspect()
    expect(overlapping.selection).toBe('ambiguous')
    expect(overlapping.running.map(turn => turn.id)).toEqual(['a', 'z'])
    const next = await setup([...starts, stop('end-a', 'a')]).control.inspect()
    expect(next.selection).toBe('one')
    expect(next.running.map(turn => turn.id)).toEqual(['z'])
    const finished = await setup([...starts, stop('end-a', 'a'), stop('end-z', 'z')]).control.inspect()
    expect(finished.selection).toBe('idle')
    expect(finished.running).toEqual([])
    expect(finished.generations.map(turn => turn.terminal)).toEqual(['completed', 'completed'])
  })

  it('late output belongs to its completed generation while its successor keeps running', async () => {
    const events = [fact('first', 'first', 'activity'), stop('first-stop', 'first'), fact('second', 'second', 'activity')]
    const before = await setup(events).control.inspect()
    const after = await setup([...events, fact('late-response', 'first', 'activity')]).control.inspect()
    expect(after.running).toEqual(before.running)
    expect(after.generations[0]).toMatchObject({ id: 'first', running: false, terminal: 'completed', factIds: ['first', 'first-stop', 'late-response'] })
  })

  it('restores Cancel tombstones and never lets replay reopen the cancelled generation', async () => {
    const retained = JSON.parse(JSON.stringify([fact('cancel', 'one', 'cancelled'), fact('old-start', 'one', 'activity'), stop('old-stop', 'one')]))
    const first = await setup(retained).control.inspect()
    const restarted = await setup(JSON.parse(JSON.stringify(retained))).control.inspect()
    expect(restarted.generations).toEqual(first.generations)
    expect(restarted.generations[0]).toMatchObject({ terminal: 'cancelled', running: false })
    expect(await all([fact('cancel-before-start', 'queued', 'cancelled')])).toEqual([
      { id: 'queued', submitted: false, executed: false, running: false, terminal: 'cancelled', factIds: ['cancel-before-start'] },
    ])
  })

  it('keeps conflicting terminal outcomes closed and unresolved until an explicit Cancel', async () => {
    const conflicting = [stop('success', 'one'), stop('failure', 'one', 'error')]
    expect((await all(conflicting))[0]).toMatchObject({ terminal: 'unresolved', running: false })
    expect((await all([...conflicting, fact('cancel', 'one', 'cancelled')]))[0].terminal).toBe('cancelled')
  })

  it('deduplicates exact delivery identities without deduplicating distinct native observations', async () => {
    const event = fact('original', 'one', 'activity')
    expect((await all([event, { ...event }, fact('distinct', 'one', 'activity')]))[0].factIds).toEqual(['distinct', 'original'])
  })

  it.each([
    fact('same', 'another-generation', 'activity'), fact('same', 'one', 'submitted'), stop('same', 'one'),
  ])('holds a conflicting reuse of a delivery identity: %j', async conflicting => {
    await expect(all([fact('same', 'one', 'activity'), conflicting])).rejects.toThrow('conflicting content')
  })

  it('provides immutable observations and keeps the original source proof', async () => {
    const input = fact('activity', 'one', 'activity')
    const t = setup([input]), originalProof = t.source.verify
    const view = await t.control.inspect()
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.owner)).toBe(true)
    expect(Object.isFrozen(view.generations)).toBe(true)
    expect(Object.isFrozen(view.generations[0])).toBe(true)
    expect(Object.isFrozen(view.generations[0].factIds)).toBe(true)
    Object.assign(input, { kind: 'submitted', generationId: 'replacement' })
    const substitute = vi.fn()
    t.source.verify = substitute
    view.verify()
    expect(view.generations[0]).toMatchObject({ id: 'one', executed: true, running: true })
    expect(originalProof).toHaveBeenCalledTimes(3)
    expect(substitute).not.toHaveBeenCalled()
  })

  it('never grants another engine incarnation authority over these facts', async () => {
    const t = setup([fact('activity', 'one', 'activity')])
    Object.assign(t.source.owner, { processKey: 'replacement' })
    await expect(t.control.inspect()).rejects.toThrow('another engine incarnation')
    expect(t.source.verify).not.toHaveBeenCalled()
  })

  it.each(['agentId', 'sessionId', 'processKey'] as const)('revokes a view when its source %s changes', async key => {
    const t = setup(), view = await t.control.inspect()
    Object.assign(t.source.owner, { [key]: 'replacement' })
    expect(() => view.verify()).toThrow('source owner changed')
  })

  it.each([2, 3])('rejects source-owner replacement inside full proof %i', async call => {
    const t = setup()
    let calls = 0
    vi.mocked(t.source.verify).mockImplementation(() => {
      if (++calls === call) Object.assign(t.source.owner, { sessionId: 'replacement' })
    })
    if (call === 2) await expect(t.control.inspect()).rejects.toThrow('source owner changed')
    else { const view = await t.control.inspect(); expect(() => view.verify()).toThrow('source owner changed') }
  })

  it.each([
    stop('later-stop', 'one'), fact('later-cancel', 'one', 'cancelled'), fact('later-activity', 'two', 'activity'),
  ])('invalidates a former running view when its complete native frontier advances: %j', async later => {
    const retained: NativeGenerationFact[] = [fact('activity', 'one', 'activity')]
    const control = createNativeGenerations({ owner, current: () => true, read: async () => {
      const length = retained.length
      return { owner: { ...owner }, facts: [...retained], verify: () => {
        if (retained.length !== length) throw Error('the complete native frontier changed')
      } }
    } })
    const before = await control.inspect()
    retained.push(later)
    expect(() => before.verify()).toThrow('complete native frontier changed')
    const after = await control.inspect()
    expect(() => after.verify()).not.toThrow()
    expect(after.selection).toBe(later.kind === 'activity' ? 'ambiguous' : 'idle')
    expect(after.generations[0].running).toBe(later.kind === 'activity')
  })

  it('does not adopt mutations to the supplied original owner', async () => {
    const original = { ...owner }, source = { owner: { ...owner }, facts: [], verify: vi.fn() }
    const control = createNativeGenerations({ owner: original, current: () => true, read: async () => source })
    original.sessionId = 'replacement'
    expect((await control.inspect()).owner).toEqual(owner)
  })

  it('holds an unavailable source without retaining a partial projection', async () => {
    const t = setup([fact('activity', 'one', 'activity')])
    t.read.mockRejectedValueOnce(Error('native journal unavailable'))
    await expect(t.control.inspect()).rejects.toThrow('native journal unavailable')
    expect((await t.control.inspect()).running).toHaveLength(1)
  })

  it('checks ownership before reading, after the read, and at actual effect time', async () => {
    const before = setup(); before.revoke()
    await expect(before.control.inspect()).rejects.toThrow('incarnation changed')
    expect(before.read).not.toHaveBeenCalled()
    const during = setup()
    during.read.mockImplementationOnce(async () => { during.revoke(); return during.source })
    await expect(during.control.inspect()).rejects.toThrow('incarnation changed')
    expect(during.source.verify).not.toHaveBeenCalled()
    const after = setup(), view = await after.control.inspect()
    after.revoke()
    expect(() => view.verify()).toThrow('incarnation changed')
  })

  it('checks ownership again when the final source proof itself revokes the owner', async () => {
    const t = setup()
    vi.mocked(t.source.verify).mockImplementationOnce(() => {}).mockImplementationOnce(t.revoke)
    await expect(t.control.inspect()).rejects.toThrow('incarnation changed')
  })

  it.each([1, 2, 3])('preserves source proof failure at verification %i', async call => {
    const t = setup()
    let calls = 0
    vi.mocked(t.source.verify).mockImplementation(() => { if (++calls === call) throw Error('retained source changed') })
    if (call < 3) await expect(t.control.inspect()).rejects.toThrow('retained source changed')
    else { const view = await t.control.inspect(); expect(() => view.verify()).toThrow('retained source changed') }
  })

  it('bounds both complete source facts and independent generations', async () => {
    const maximum = Array.from({ length: 4608 }, (_, n) => fact(`event-${n}`, `generation-${n % 512}`, 'activity'))
    expect((await setup(maximum).control.inspect()).running).toHaveLength(512)
    await expect(setup([...maximum, fact('over', 'generation-0', 'activity')]).control.inspect()).rejects.toThrow('fact capacity')
    await expect(setup(Array.from({ length: 513 }, (_, n) => fact(`event-${n}`, `generation-${n}`, 'activity'))).control.inspect()).rejects.toThrow('generation capacity')
    const t = setup(); Object.assign(t.source, { facts: null })
    await expect(t.control.inspect()).rejects.toThrow('fact capacity')
  })

  it.each([
    null, { id: '', generationId: 'one', kind: 'activity' }, { id: 1, generationId: 'one', kind: 'activity' },
    { id: 'x'.repeat(201), generationId: 'one', kind: 'activity' }, { id: 'event', generationId: 'bad\nidentity', kind: 'activity' },
    { id: 'event', generationId: 'one', kind: 'unknown' }, { id: 'event', generationId: 'one', kind: 'stopped', status: 'unknown' },
    { id: 'event', generationId: 'one', kind: 'activity', status: 'completed' },
  ])('holds invalid retained control facts without publishing a partial result: %j', async invalid => {
    await expect(setup([fact('valid', 'valid', 'activity'), invalid as NativeGenerationFact]).control.inspect()).rejects.toThrow('Waiting for native turn ownership')
  })

  it('preserves the native boot/engine/PID/birth key, including its NUL separators', async () => {
    const nativeOwner = { ...owner, processKey: ['fixture-boot', 'cursor', '123', 'precise-birth'].join('\0') }
    const control = createNativeGenerations({ owner: nativeOwner, current: () => true,
      read: async () => ({ owner: { ...nativeOwner }, facts: [], verify() {} }) })
    expect((await control.inspect()).owner.processKey).toBe(nativeOwner.processKey)
  })

  it.each([123, 'x'.repeat(513)])('rejects an invalid or unbounded native process key', processKey => {
    expect(() => createNativeGenerations({ owner: { ...owner, processKey: processKey as string }, current: () => true,
      read: async () => ({ owner, facts: [], verify() {} }) })).toThrow('incarnation is incomplete')
  })

  it.each(['agentId', 'sessionId', 'processKey'] as const)('requires the original %s', key => {
    expect(() => createNativeGenerations({ owner: { ...owner, [key]: '' }, current: () => true,
      read: async () => ({ owner, facts: [], verify() {} }) })).toThrow('incarnation is incomplete')
  })
})
