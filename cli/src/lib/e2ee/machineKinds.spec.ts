import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MACHINE_KINDS_MAX_AGE_MS, MACHINE_KINDS_REFRESH_MS, MachineKinds, machineKindsOf } from './machineKinds.js'

describe('machineKindsOf', () => {
  it('reads each machine\'s sessionKind, taking a row from before team sessions as the person\'s own', () => {
    const kinds = machineKindsOf({ success: true, data: { machines: [
      { machineId: 'm-team', sessionKind: 'team' }, { machineId: 'm-own', sessionKind: 'computer' },
      { machineId: 'm-old', sessionKind: null }, { machineId: 'm-older' }, { machineId: 'm-odd', sessionKind: 'phone' },
      { machineId: '' }, null, 'm-text',
    ] } })
    expect(kinds).toEqual(new Map([['m-team', 'team'], ['m-own', 'computer'], ['m-old', 'computer'], ['m-older', 'computer']]))
    expect(machineKindsOf({ machines: [{ machineId: 'x', sessionKind: 'team' }] })).toEqual(new Map([['x', 'team']]))
  })

  it('takes a machine listed twice at its stricter kind, and a body with no list as nothing', () => {
    expect(machineKindsOf({ machines: [{ machineId: 'x', sessionKind: 'team' }, { machineId: 'x', sessionKind: 'computer' }] })?.get('x')).toBe('team')
    expect(machineKindsOf({ machines: [{ machineId: 'x', sessionKind: 'computer' }, { machineId: 'x', sessionKind: 'team' }] })?.get('x')).toBe('team')
    for (const body of [null, undefined, 'x', {}, { data: null }, { data: { machines: {} } }]) expect(machineKindsOf(body)).toBeNull()
  })
})

describe('MachineKinds', () => {
  const list = (kind: unknown) => ({ data: { machines: [{ machineId: 'm1', sessionKind: kind }] } })

  it('knows nothing until a list is read, then goes by it until it is too old', async () => {
    let now = 1_000
    const read = vi.fn(async (): Promise<unknown> => list('computer'))
    const kinds = new MachineKinds({ file: null, read, now: () => now })
    expect(kinds.kind('m1')).toBeNull()
    await kinds.fresh()
    expect(kinds.kind('m1')).toBe('computer')
    expect(kinds.kind('m2')).toBeNull()
    now += MACHINE_KINDS_MAX_AGE_MS + 1
    expect(kinds.kind('m1')).toBeNull()
  })

  it('reads again only once the list is old, one read at a time, and keeps the last list when a read fails', async () => {
    let now = 1_000
    const read = vi.fn(async (): Promise<unknown> => list('computer'))
    const kinds = new MachineKinds({ file: null, read, now: () => now })
    await Promise.all([kinds.fresh(), kinds.fresh()])
    expect(read).toHaveBeenCalledTimes(1)
    await kinds.fresh()
    expect(read).toHaveBeenCalledTimes(1)
    now += MACHINE_KINDS_REFRESH_MS
    read.mockRejectedValueOnce(new Error('offline'))
    await kinds.fresh()
    expect(read).toHaveBeenCalledTimes(2)
    expect(kinds.kind('m1')).toBe('computer')
    read.mockResolvedValueOnce(null)
    await kinds.fresh()
    expect(kinds.kind('m1')).toBe('computer')
    read.mockResolvedValueOnce(list('team'))
    await kinds.fresh()
    expect(kinds.kind('m1')).toBe('team')
  })

  it('takes a list the gateway read for the apps, and forgets the list on a sign-out, a read on its way included', async () => {
    let release: (body: unknown) => void = () => {}
    const kinds = new MachineKinds({ file: null, read: () => new Promise((resolve) => { release = resolve }) })
    kinds.adopt(list('computer'))
    expect(kinds.kind('m1')).toBe('computer')
    kinds.adopt({ nothing: true })
    expect(kinds.kind('m1')).toBe('computer')
    kinds.clear()
    expect(kinds.kind('m1')).toBeNull()
    const reading = kinds.fresh()
    kinds.clear()
    release(list('computer'))
    await reading
    expect(kinds.kind('m1')).toBeNull()
    // A team machine is remembered past a sign-out: it is still one.
    kinds.adopt(list('team'))
    kinds.clear()
    expect(kinds.kind('m1')).toBe('team')
  })

  it('is team-free, as every regular user is, until a list shows a team machine; remembered on disk until a list shows it as a computer', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kinds-')), 'e2e', 'team-machines.json')
    const kinds = new MachineKinds({ file, read: async () => null })
    expect(kinds.teamFree()).toBe(true)
    kinds.adopt({ machines: [{ machineId: 'own', sessionKind: 'computer' }, { machineId: 'old' }] })
    expect(kinds.teamFree()).toBe(true)
    expect(existsSync(file)).toBe(false)
    kinds.adopt({ machines: [{ machineId: 'own', sessionKind: 'computer' }, { machineId: 'team-1', sessionKind: 'team' }] })
    expect(kinds.teamFree()).toBe(false)
    // A restart, signed out or offline: the team machine is still known.
    const restarted = new MachineKinds({ file, read: async () => null })
    expect(restarted.teamFree()).toBe(false)
    expect(restarted.kind('team-1')).toBe('team')
    expect(restarted.kind('own')).toBeNull()
    // `harness team off`: the list shows it as the person's own again.
    restarted.adopt({ machines: [{ machineId: 'team-1', sessionKind: 'computer' }] })
    expect(restarted.teamFree()).toBe(true)
    expect(new MachineKinds({ file, read: async () => null }).teamFree()).toBe(true)
    // An unreadable file is no team machine.
    writeFileSync(file, 'not json')
    expect(new MachineKinds({ file, read: async () => null }).teamFree()).toBe(true)
  })
})
