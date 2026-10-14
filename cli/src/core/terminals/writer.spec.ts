import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTerminalWriter } from './writer.js'

const held = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('revokes logical work before cancellation storage without releasing a physical write', async () => {
  const writer = createTerminalWriter(), physical = held(), effect = vi.fn(async () => {})
  writer.revoke('absent')
  const original = writer.ticket('a')
  const active = writer.run('a', original, write => write.dispatch(() => physical.promise))
  const queued = writer.run('a', original, effect)
  const cancelled = [expect(active).rejects.toThrow('cancelled'), expect(queued).rejects.toThrow('cancelled')]
  writer.revoke('a'); await Promise.all(cancelled)
  expect(original.allowed()).toBe(false)
  const next = writer.run('a', writer.ticket('a'), write => write.dispatch(effect))
  await flush(); expect(effect).not.toHaveBeenCalled()
  physical.resolve(); await next
  expect(effect).toHaveBeenCalledOnce()
})

it('aborts one running preparation without interrupting queued epochs or releasing its actual allocation', async () => {
  const writer = createTerminalWriter({ maxPreparing: 1 }), preparation = held(), abort = new AbortController()
  let allowed!: () => boolean
  const effect = vi.fn(async () => {})
  const original = writer.run('a', writer.ticket('a'), async write => {
    allowed = write.allowed; await preparation.promise; await write.dispatch(effect)
  }, abort.signal)
  const refused = expect(original).rejects.toThrow('cancelled before completion')
  const epoch = writer.ticket('a')
  abort.abort(); await refused
  expect(allowed()).toBe(false)
  expect(epoch.allowed()).toBe(true)
  await expect(writer.run('a', epoch, effect)).rejects.toThrow('capacity')
  preparation.resolve(); await flush()
  expect(effect).not.toHaveBeenCalled()
  await expect(writer.run('a', epoch, effect)).resolves.toBeUndefined()
})

it('removes an aborted queued request and ignores abort after a completed run', async () => {
  const writer = createTerminalWriter(), preparation = held(), abort = new AbortController(), effect = vi.fn(async () => {})
  const active = writer.run('a', writer.ticket('a'), () => preparation.promise)
  const queued = writer.run('a', writer.ticket('a'), effect, abort.signal)
  const refused = expect(queued).rejects.toThrow('cancelled before completion')
  abort.abort(); await refused
  preparation.resolve(); await active
  expect(effect).not.toHaveBeenCalled()
  await expect(writer.run('a', writer.ticket('a'), effect, abort.signal)).rejects.toThrow('cancelled before completion')
  const completed = new AbortController()
  await writer.run('a', writer.ticket('a'), effect, completed.signal)
  completed.abort()
  expect(effect).toHaveBeenCalledOnce()
})

it('keeps an aborted physical write leased until it really settles', async () => {
  const writer = createTerminalWriter(), physical = held(), abort = new AbortController(), effect = vi.fn(async () => {})
  const active = writer.run('a', writer.ticket('a'), write => write.dispatch(() => physical.promise), abort.signal)
  const refused = expect(active).rejects.toThrow('cancelled before completion')
  abort.abort(); await refused
  const next = writer.run('a', writer.ticket('a'), write => write.dispatch(effect))
  await flush(); expect(effect).not.toHaveBeenCalled()
  physical.resolve(); await next
  expect(effect).toHaveBeenCalledOnce()
})

it('retains a queued epoch against eviction until its last reservation releases', async () => {
  const writer = createTerminalWriter({ maxLanes: 1 }), first = writer.reserve('a')!, second = writer.reserve('a')!
  expect(writer.reserve('other')).toBeUndefined()
  first.release(); first.release()
  expect(first.write.allowed()).toBe(false)
  expect(second.write.allowed()).toBe(true)
  expect(writer.ticket('other').allowed()).toBe(false)
  second.release()
  expect(writer.reserve('other')!.write.allowed()).toBe(true)
})

it('revokes preparation immediately without letting its late cleanup free the replacement owner', async () => {
  const writer = createTerminalWriter(), preparation = held(), replacement = held(), calls: string[] = []
  const original = writer.ticket('a')
  const old = writer.run('a', original, async write => { await preparation.promise; await write.dispatch(async () => { calls.push('old') }) })
  let settled = false
  void old.catch(() => { settled = true })
  const cancelled = expect(old).rejects.toThrow('cancelled before completion')
  const pending = writer.run('a', original, async () => { calls.push('queued-old') })
  const rejected = expect(pending).rejects.toThrow('cancelled before completion')
  await expect(writer.interrupt('a', write => write.dispatch(async () => { calls.push('C-c') }))).resolves.toBeUndefined()
  await flush(); expect(settled).toBe(true)
  await cancelled; await rejected
  expect(original.allowed()).toBe(false)
  const next = writer.run('a', writer.ticket('a'), async () => { calls.push('new'); await replacement.promise })
  const queued = writer.run('a', writer.ticket('a'), async () => { calls.push('queued-new') })
  preparation.resolve(); await flush()
  expect(calls).toEqual(['C-c', 'new'])
  replacement.resolve(); await next; await queued
  expect(calls).toEqual(['C-c', 'new', 'queued-new'])
})

it('drains only actual pane I/O before interrupting, while another pane remains independent', async () => {
  const writer = createTerminalWriter(), physical = held(), calls: string[] = []
  const old = writer.run('a', writer.ticket('a'), write => write.dispatch(() => physical.promise))
  const cancelled = expect(old).rejects.toThrow('cancelled before completion')
  const stop = writer.interrupt('a', write => write.dispatch(async () => { calls.push('C-c') }))
  await writer.run('b', writer.ticket('b'), async () => { calls.push('other') })
  expect(calls).toEqual(['other'])
  physical.resolve(); await stop; await cancelled
  expect(calls).toEqual(['other', 'C-c'])
})

it('refuses a second physical command and retains a failed operation only until it settles', async () => {
  const writer = createTerminalWriter(), write = writer.ticket('a'), physical = held()
  const active = write.dispatch(() => physical.promise)
  const failed = expect(active).rejects.toThrow('tmux failed')
  await expect(write.dispatch(async () => {})).rejects.toThrow('still occupied')
  physical.reject(Error('tmux failed')); await failed
  await expect(write.dispatch(async () => 'new')).resolves.toBe('new')
  await expect(writer.run('a', write, async () => { throw Error('read failed') })).rejects.toThrow('read failed')
  await expect(writer.run('a', write, async () => 'next')).resolves.toBe('next')
})

it('does not reacquire authority when an already revoked queued ticket reaches the writer', async () => {
  const writer = createTerminalWriter(), old = writer.ticket('a'), write = vi.fn(async () => {})
  await writer.interrupt('a', async () => {})
  await expect(writer.run('a', old, write)).rejects.toThrow('cancelled before completion')
  await expect(old.dispatch(write)).rejects.toThrow('terminal control revoked')
  expect(write).not.toHaveBeenCalled()
})

it('keeps the interrupt reservation and physical command after the caller deadline', async () => {
  const writer = createTerminalWriter(), physical = held(), calls: string[] = []
  let permitted!: () => boolean
  const stop = writer.interrupt('a', write => { permitted = write.allowed; return write.dispatch(() => physical.promise) })
  const expired = expect(stop).rejects.toThrow('deadline expired')
  const later = writer.run('a', writer.ticket('a'), async () => { calls.push('later') })
  await vi.advanceTimersByTimeAsync(5000); await expired
  expect(permitted()).toBe(false)
  await expect(writer.interrupt('a', async () => {})).rejects.toThrow('previous terminal interrupt')
  expect(calls).toEqual([])
  physical.resolve(); await later
  expect(calls).toEqual(['later'])
})

it('abandons an interrupt that expires before physical ownership becomes available', async () => {
  const writer = createTerminalWriter(), physical = held(), command = vi.fn(async () => {})
  const active = writer.ticket('a').dispatch(() => physical.promise)
  const expired = expect(writer.interrupt('a', command)).rejects.toThrow('deadline expired')
  await vi.advanceTimersByTimeAsync(5000); await expired
  physical.resolve(); await active
  expect(command).not.toHaveBeenCalled()
  await expect(writer.interrupt('a', async () => 'new')).resolves.toBe('new')
})

it.each(['waiting', 'running'] as const)('uses the absolute deadline for %s work before its timer runs', async phase => {
  let clock = 0
  const writer = createTerminalWriter({ now: () => clock }), physical = held()
  const active = phase === 'waiting' ? writer.ticket('a').dispatch(() => physical.promise) : Promise.resolve()
  const operation = vi.fn(async () => { clock = 5000 })
  const expired = expect(writer.interrupt('a', operation)).rejects.toThrow('deadline expired')
  clock = 5000; physical.resolve(); await active; await expired
  expect(operation).toHaveBeenCalledTimes(phase === 'waiting' ? 0 : 1)
})

it('releases a rejected interrupt without granting its old ticket again', async () => {
  const writer = createTerminalWriter(), old = writer.ticket('a')
  await expect(writer.interrupt('a', async () => { throw Error('proof lost') })).rejects.toThrow('proof lost')
  expect(old.allowed()).toBe(false)
  await expect(writer.run('a', writer.ticket('a'), async () => 'new')).resolves.toBe('new')
})

it('bounds waiting work and retires idle lanes without reviving their retained tickets', async () => {
  const writer = createTerminalWriter({ maxLanes: 2, maxQueued: 1 }), work = held()
  const old = writer.ticket('idle'), active = writer.run('busy', writer.ticket('busy'), () => work.promise)
  const fresh = writer.ticket('replacement')
  expect(fresh.allowed()).toBe(true)
  expect(old.allowed()).toBe(false)
  await expect(old.dispatch(async () => {})).rejects.toThrow('terminal control revoked')
  const pending = writer.run('busy', writer.ticket('busy'), async () => 'queued')
  await expect(writer.run('busy', writer.ticket('busy'), async () => {})).rejects.toThrow('capacity')
  work.resolve(); await active; await expect(pending).resolves.toBe('queued')
})

it('holds at capacity instead of evicting logical, physical, interrupt or waiting work', async () => {
  const writer = createTerminalWriter({ maxLanes: 1 }), work = held()
  const active = writer.run('busy', writer.ticket('busy'), () => work.promise)
  const denied = writer.ticket('other')
  expect(denied.allowed()).toBe(false)
  await expect(denied.dispatch(async () => {})).rejects.toThrow('capacity')
  await expect(writer.run('other', denied, async () => {})).rejects.toThrow('capacity')
  await expect(writer.interrupt('other', async () => {})).rejects.toThrow('capacity')
  work.resolve(); await active
  const physical = held(), dispatched = writer.ticket('busy').dispatch(() => physical.promise)
  expect(writer.ticket('other').allowed()).toBe(false)
  const interrupt = held(), stopped = writer.interrupt('busy', () => interrupt.promise)
  physical.resolve(); await dispatched
  const queued = writer.run('busy', writer.ticket('busy'), async () => {})
  expect(writer.ticket('other').allowed()).toBe(false)
  interrupt.resolve(); await stopped; await queued
  expect(writer.ticket('other').allowed()).toBe(true)
})

it('bounds actual abandoned preparation while still admitting Cancel and frees it only on settlement', async () => {
  const writer = createTerminalWriter({ maxLanes: 1, maxPreparing: 2 }), reads = [held(), held()]
  for (const read of reads) {
    const old = writer.run('a', writer.ticket('a'), () => read.promise)
    const cancelled = expect(old).rejects.toThrow('cancelled before completion')
    await writer.interrupt('a', write => write.dispatch(async () => {})); await cancelled
  }
  expect(writer.ticket('other').allowed()).toBe(false)
  const extra = vi.fn(async () => {})
  await expect(writer.run('a', writer.ticket('a'), extra)).rejects.toThrow('capacity')
  expect(extra).not.toHaveBeenCalled()
  await expect(writer.interrupt('a', write => write.dispatch(async () => 'C-c'))).resolves.toBe('C-c')
  reads[0].resolve(); await flush()
  await expect(writer.run('a', writer.ticket('a'), extra)).resolves.toBeUndefined()
  reads[1].resolve(); await flush()
  expect(writer.ticket('other').allowed()).toBe(true)
})
