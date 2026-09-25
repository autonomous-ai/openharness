// The machine list, and the one comparison the whole feature hangs on.
//
// `local` is derived, not declared, and getting it wrong is invisible: every machine — including this
// computer's own — silently reads as remote, so the dial's own row goes missing and the daemon opens a
// cloud socket to reach agents that are in this very process.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { MachineListCache, sameComputer, withStaleMarker } from './machineList.js'

const DIR = (): string => mkdtempSync(join(tmpdir(), 'machines-'))

/** The machine row a session belongs to — per (user, computer), so it is what tells two accounts apart. */
const OWNER = 'machine-of-user-a'

/** The shape `GET /api/machines` actually answers with (MachineService.toOwner). */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { machineId: 'm1', computerId: 'aabbccdd', name: 'office-imac', status: 'running', authMode: 'remote', ...over }
}

function ok(machines: Record<string, unknown>[]) {
  return async () => ({ status: 200, body: { machines } as Record<string, unknown> })
}

describe('sameComputer', () => {
  it('matches across the dash-and-case difference between the two sides', () => {
    // The CLI mints a dashed randomUUID; the backend de-dashes and lowercases before storing. A raw ===
    // never matches, and the symptom is that this computer never recognises itself.
    expect(sameComputer('7C9E6679-7425-40DE-944B-E07FC1F90AE7', '7c9e6679742540de944be07fc1f90ae7')).toBe(true)
  })

  it('is false for two different computers, and for nothing at all', () => {
    expect(sameComputer('aaaa', 'bbbb')).toBe(false)
    expect(sameComputer('', '')).toBe(false)          // two blanks are not the same computer
    expect(sameComputer(undefined, 'aaaa')).toBe(false)
  })
})

describe('MachineListCache', () => {
  it('tells a listener every list it takes, and a sign-out as null — a failed read tells nothing', async () => {
    const told: Array<Record<string, unknown> | null> = []
    let answer: () => Promise<{ status: number; body: Record<string, unknown> }> = ok([row()])
    const cache = new MachineListCache(() => answer(), () => 'z', () => {}, DIR())
    cache.listen((body) => told.push(body))

    await cache.refresh()
    answer = async () => { throw new Error('offline') }
    await cache.refresh()
    answer = async () => ({ status: 401, body: {} })
    await cache.refresh()

    expect(told).toEqual([{ machines: [row()] }, null])
  })

  it('marks the row whose computerId is this computer as local', async () => {
    const cache = new MachineListCache(
      ok([row({ machineId: 'mine', computerId: 'AA-BB-CC-DD' }), row({ machineId: 'other', computerId: 'ffff' })]),
      () => 'aabbccdd',
      () => {},
      DIR(),
    )
    await cache.refresh()
    expect(cache.find('mine')?.local).toBe(true)
    expect(cache.find('other')?.local).toBe(false)
  })

  it('reads `status` as liveness', async () => {
    const cache = new MachineListCache(
      ok([row({ machineId: 'up', status: 'running' }), row({ machineId: 'down', status: 'stopped' }), row({ machineId: 'huh', status: '' })]),
      () => 'zzzz', () => {}, DIR(),
    )
    await cache.refresh()
    expect(cache.find('up')?.state).toBe('ready')
    expect(cache.find('down')?.state).toBe('offline')
    expect(cache.find('huh')?.state).toBe('unknown')
  })

  it('keeps the last known rows when the backend goes away, and stops calling them live', async () => {
    // The dial must still show the machines the user saw; what it must NOT do is keep claiming they are
    // reachable. Emptying the wheel on a network blip would read as "your machines are gone".
    let fail = false
    const cache = new MachineListCache(
      async () => { if (fail) throw new Error('ECONNREFUSED'); return { status: 200, body: { machines: [row()] } } },
      () => 'zzzz', () => {}, DIR(),
    )
    await cache.refresh()
    expect(cache.list().source).toBe('backend')

    fail = true
    await cache.refresh()
    expect(cache.list().machines).toHaveLength(1)
    expect(cache.list().source).toBe('local')
    expect(cache.find('m1')?.state).toBe('unknown')
  })

  it('reports signed-out on a 401, with no rows', async () => {
    const cache = new MachineListCache(async () => ({ status: 401, body: {} }), () => 'z', () => {}, DIR())
    await cache.refresh()
    expect(cache.list()).toEqual({ machines: [], source: 'signed-out' })
  })

  it('survives a daemon restart offline by reloading its cache — as unknown, never as live', async () => {
    const dir = DIR()
    const first = new MachineListCache(ok([row()]), () => 'zzzz', () => {}, dir)
    await first.refresh()

    const second = new MachineListCache(async () => { throw new Error('offline') }, () => 'zzzz', () => {}, dir)
    expect(second.find('m1')?.name).toBe('office-imac')
    expect(second.find('m1')?.state).toBe('unknown')
  })

  it('falls back to hostname, then to a short id, for a machine with no name', async () => {
    const cache = new MachineListCache(
      ok([row({ machineId: 'a', name: '', hostname: 'thinkpad' }), row({ machineId: 'bcdef0123', name: '', hostname: '' })]),
      () => 'z', () => {}, DIR(),
    )
    await cache.refresh()
    expect(cache.find('a')?.name).toBe('thinkpad')
    expect(cache.find('bcdef0123')?.name).toBe('machine-bcdef0')
  })

  it('drops a row with no machineId rather than carrying a blank one onto the wheel', async () => {
    const cache = new MachineListCache(ok([row(), row({ machineId: undefined })]), () => 'z', () => {}, DIR())
    await cache.refresh()
    expect(cache.list().machines).toHaveLength(1)
  })

  it('does not reject when the response is nonsense', async () => {
    const log = vi.fn()
    const cache = new MachineListCache(async () => ({ status: 200, body: { nope: true } }), () => 'z', log, DIR())
    await expect(cache.refresh()).resolves.toBeUndefined()
    expect(cache.list().source).toBe('local')
  })
})

// The desktop app reads this same endpoint through the daemon, so an outage must leave it with the last
// known list rather than nothing — see `machinesListWithFallback` in cli.ts.
describe('MachineListCache last-known-good body', () => {
  it('keeps the successful response verbatim, so a fallback cannot change the wire shape', async () => {
    const dir = DIR()
    // A row carries fields the dial's ListedMachine projection drops (computerId, hostname) but the
    // desktop reads. Serving the projection back would silently break it.
    const body = { success: true, data: { machines: [row({ hostname: 'imac-office' })] } } as Record<string, unknown>
    const cache = new MachineListCache(async () => ({ status: 200, body }), () => 'aabbccdd', () => {}, dir, () => OWNER)
    await cache.refresh()

    const kept = cache.lastResponse()
    expect(kept?.body).toEqual(body)
    expect(kept!.fetchedAt).toBeGreaterThan(0)
    // And it survives a restart: the body is on disk beside the rows.
    const onDisk = JSON.parse(readFileSync(join(dir, 'machines.json'), 'utf8')) as Record<string, unknown>
    expect(onDisk.body).toEqual(body)
  })

  it('has nothing to serve until a read succeeds', async () => {
    const cache = new MachineListCache(async () => ({ status: 502, body: {} }), () => 'z', () => {}, DIR())
    await cache.refresh()
    expect(cache.lastResponse()).toBeNull()
  })

  it('reads a cache file written before this field existed, without throwing', () => {
    const dir = DIR()
    // The shape an older daemon wrote: rows only.
    writeFileSync(join(dir, 'machines.json'), JSON.stringify({ machines: [{ machineId: 'm1', name: 'old', state: 'ready', authMode: 'remote', local: false }] }))
    const cache = new MachineListCache(ok([]), () => 'z', () => {}, dir)
    expect(cache.find('m1')?.name).toBe('old')   // the wheel still draws
    expect(cache.lastResponse()).toBeNull()       // but there is no body to answer with yet
  })

  it('restores the body from disk so a daemon that starts offline can still answer', async () => {
    const dir = DIR()
    const body = { success: true, data: { machines: [row()] } } as Record<string, unknown>
    await new MachineListCache(async () => ({ status: 200, body }), () => 'aabbccdd', () => {}, dir, () => OWNER).refresh()

    const restarted = new MachineListCache(async () => ({ status: 502, body: {} }), () => 'aabbccdd', () => {}, dir, () => OWNER)
    expect(restarted.lastResponse()?.body).toEqual(body)
  })

  it('forgets the body when the session ends, so no list outlives its owner', async () => {
    const dir = DIR()
    const body = { success: true, data: { machines: [row()] } } as Record<string, unknown>
    let status = 200
    const cache = new MachineListCache(async () => ({ status, body }), () => 'aabbccdd', () => {}, dir, () => OWNER)
    await cache.refresh()
    expect(cache.lastResponse()).not.toBeNull()

    status = 401
    await cache.refresh()
    expect(cache.lastResponse()).toBeNull()
    expect(cache.list().machines).toHaveLength(0)
    // Cleared on disk too — a restart must not resurrect it.
    expect(JSON.parse(readFileSync(join(dir, 'machines.json'), 'utf8')).body).toBeNull()
  })

  it('adopt() takes a body the caller already has, and refuses one with no machines', () => {
    const cache = new MachineListCache(ok([]), () => 'aabbccdd', () => {}, DIR())
    expect(cache.adopt({ machines: [row()] })).toBe(true)
    expect(cache.find('m1')?.local).toBe(true)
    expect(cache.adopt({ nope: true })).toBe(false)
  })
})

describe('withStaleMarker', () => {
  it('marks inside `data`, which is where a local client unwraps to', () => {
    const at = Date.parse('2026-09-15T12:00:00.000Z')
    const out = withStaleMarker({ success: true, data: { machines: [row()] } }, at)
    const data = out.data as Record<string, unknown>
    expect(data.stale).toBe(true)
    expect(data.staleSince).toBe('2026-09-15T12:00:00.000Z')
    expect(out.stale).toBeUndefined()            // not at the top level, where nobody looks
    expect((data.machines as unknown[])).toHaveLength(1)   // the payload itself is untouched
  })

  it('falls back to the top level for a body that has no `data`', () => {
    const out = withStaleMarker({ machines: [row()] }, Date.parse('2026-09-15T12:00:00.000Z'))
    expect(out.stale).toBe(true)
    expect(out.staleSince).toBe('2026-09-15T12:00:00.000Z')
  })
})

// `harness logout` deletes this file, but a session can also be replaced in place — signing in as someone
// else without logging out first. Answering that with the previous account's machines would disclose them.
describe('MachineListCache account guard', () => {
  const body = { success: true, data: { machines: [row()] } } as Record<string, unknown>

  it('will not answer a different account from the list it cached for the previous one', async () => {
    const dir = DIR()
    let owner = 'machine-of-user-a';
    const cache = new MachineListCache(async () => ({ status: 200, body }), () => 'aabbccdd', () => {}, dir, () => owner)
    await cache.refresh()
    expect(cache.lastResponse()).not.toBeNull()

    owner = 'machine-of-user-b'   // same computer, different account
    expect(cache.lastResponse()).toBeNull()
  })

  it('will not answer when this session has no machine of its own to compare', async () => {
    const dir = DIR()
    const cache = new MachineListCache(async () => ({ status: 200, body }), () => 'aabbccdd', () => {}, dir, () => null)
    await cache.refresh()
    // Nothing to prove ownership with is not the same as proving it: stay quiet.
    expect(cache.lastResponse()).toBeNull()
  })

  it('will not answer from a cache written before the stamp existed', () => {
    const dir = DIR()
    writeFileSync(join(dir, 'machines.json'), JSON.stringify({ machines: [], body, fetchedAt: 1 }))
    const cache = new MachineListCache(ok([]), () => 'aabbccdd', () => {}, dir, () => OWNER)
    expect(cache.lastResponse()).toBeNull()
  })
})

describe('MachineListCache disk writes', () => {
  it('does not rewrite the file when the list has not changed', async () => {
    const dir = DIR()
    const path = join(dir, 'machines.json')
    const cache = new MachineListCache(ok([row()]), () => 'aabbccdd', () => {}, dir, () => OWNER)
    await cache.refresh()
    const first = statSync(path).mtimeMs

    // The desktop asking again is the common case; an unchanged answer must cost no synchronous write.
    for (let i = 0; i < 5; i++) cache.adopt({ machines: [row()] })
    expect(statSync(path).mtimeMs).toBe(first)

    cache.adopt({ machines: [row({ machineId: 'm2' })] })   // a real change still lands
    expect(statSync(path).mtimeMs).not.toBe(first)
  })
})
