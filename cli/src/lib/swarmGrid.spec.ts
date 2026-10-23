import { describe, expect, it, vi } from 'vitest'
import { syncSwarmGrid, type SwarmGridDeps } from './swarmGrid.js'
import type { GridResult } from './gridExec.js'

const GRID = 'swarm-0123456789ab'
const ok: GridResult = { code: 'OK', exitCode: 0, stdout: '', stderr: '', message: '' }
const failed = (stderr: string, message = ''): GridResult => ({ ...ok, code: 'GRID_FAILED', exitCode: 1, stderr, message })

function deps(listed: unknown, patch: Partial<SwarmGridDeps> = {}) {
  const exec = vi.fn(async (_args: readonly string[]) => ok)
  const json = vi.fn(async () => ({ value: listed, result: ok })) as unknown as SwarmGridDeps['json']
  return { ensure: vi.fn(async () => ({ status: 'existed' as const, message: '' })), exec, json, ...patch }
}

describe('a Swarm\'s grid', () => {
  it('adds the people it lacks as both, removes those the Swarm no longer has, and never its admin', async () => {
    const d = deps([{ email: 'Owner@Example.com', roles: ['admin'] }, { email: 'gone@example.com', roles: ['both'] }, { email: 'kept@example.com' }, { roles: [] }, null])
    expect(await syncSwarmGrid(GRID, [' Kept@example.com', 'new@example.com', ''], d)).toEqual({ ready: true, added: ['new@example.com'], removed: ['gone@example.com'] })
    expect(d.ensure).toHaveBeenCalledWith(GRID)
    expect(d.json).toHaveBeenCalledWith(['--remote', 'members', 'list', GRID])
    expect(vi.mocked(d.exec).mock.calls).toEqual([[['--remote', 'members', 'add', GRID, 'new@example.com', '--role', 'both']], [['--remote', 'members', 'remove', GRID, 'gone@example.com']]])
  })
  it('reads a member list wrapped in an object, and treats anything else as empty', async () => {
    expect(await syncSwarmGrid(GRID, ['a@example.com'], deps({ members: [{ email: 'a@example.com' }] }))).toEqual({ ready: true, added: [], removed: [] })
    expect(await syncSwarmGrid(GRID, ['a@example.com'], deps(null))).toMatchObject({ ready: true, added: ['a@example.com'] })
  })
  it('counts a grid made, found or adopted as there, and says why otherwise', async () => {
    for (const status of ['created', 'adopted'] as const) expect((await syncSwarmGrid(GRID, [], deps([], { ensure: async () => ({ status, message: '' }) }))).ready).toBe(true)
    expect(await syncSwarmGrid(GRID, [], deps([], { ensure: async () => ({ status: 'refused', message: 'Free plan limit.' }) })))
      .toEqual({ ready: false, error: 'Free plan limit.', final: true, added: [], removed: [] })
    expect(await syncSwarmGrid(GRID, [], deps([], { ensure: async () => ({ status: 'failed', message: '' }) })))
      .toEqual({ ready: false, error: 'The grid could not be set up.', added: [], removed: [] })
  })
  it('stops at the first refusal, in grid\'s own words', async () => {
    const unlisted = deps([], { json: (async () => ({ value: null, result: failed('', 'grid is not signed in.') })) as unknown as SwarmGridDeps['json'] })
    expect(await syncSwarmGrid(GRID, [], unlisted)).toEqual({ ready: false, error: 'grid is not signed in.', added: [], removed: [] })
    const silent = deps([], { json: (async () => ({ value: null, result: failed('') })) as unknown as SwarmGridDeps['json'] })
    expect((await syncSwarmGrid(GRID, [], silent)).error).toBe('grid refused the request.')
    const adding = deps([], { exec: vi.fn(async () => failed('not an admin\n')) })
    expect(await syncSwarmGrid(GRID, ['a@example.com'], adding)).toEqual({ ready: false, error: 'Could not add a@example.com: not an admin', added: [], removed: [] })
    const removing = deps([{ email: 'b@example.com' }], { exec: vi.fn(async () => failed('busy')) })
    expect(await syncSwarmGrid(GRID, [], removing)).toEqual({ ready: false, error: 'Could not remove b@example.com: busy', added: [], removed: [] })
  })
})
