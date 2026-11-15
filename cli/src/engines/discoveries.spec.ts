/**
 * A Codex's home from the rollout its process holds open (decision 8 of docs/plans/2026-11-15-process-env-secrets-design.md):
 * never from its environment. What the reader lists and how is lib/processHeldFiles.spec.ts's; this pins what
 * discovery asks of it and what it makes of the answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import type { ProcessIdentity } from '../lib/terminalTypes.js'

const heldHome = vi.hoisted(() => vi.fn())
vi.mock('../lib/processHeldFiles.js', () => ({ heldHome }))

const { discoveryContract, probeProfileHome } = await import('./discoveries.js')

const identity: ProcessIdentity = { pid: 4242, executable: 'codex', startMarker: 'Sun Nov 15 10:00:00 2026' }
const children = (): ProcessIdentity[] => []

beforeEach(() => {
  heldHome.mockReset()
})

describe('probeProfileHome', () => {
  it('names a Codex home from the rollout its process holds open, and never the default', async () => {
    heldHome.mockResolvedValue('/home/u/.codex-work')
    expect(await probeProfileHome(identity, 'codex', children)).toBe('/home/u/.codex-work')
    expect(heldHome).toHaveBeenCalledWith(identity, discoveryContract('codex')!.profile!.held, children)
    heldHome.mockResolvedValue(env.CODEX_HOME)
    expect(await probeProfileHome(identity, 'codex')).toBeNull()
    heldHome.mockResolvedValue(undefined)
    expect(await probeProfileHome(identity, 'codex')).toBeUndefined()
    // An engine with no such profile has no process listed.
    expect(await probeProfileHome(identity, 'claude')).toBeNull()
    expect(heldHome).toHaveBeenCalledTimes(3)
  })

  it('the pattern takes a rollout under sessions, at any depth, and nothing else', () => {
    const held = discoveryContract('codex')!.profile!.held
    expect(held.exec('/c/sessions/2026/11/15/rollout-2026-11-15T00-00-00-a.jsonl')?.[1]).toBe('/c')
    expect(held.exec('/c/sessions/rollout-a.jsonl')?.[1]).toBe('/c')
    for (const path of ['/c/archived_sessions/rollout-a.jsonl', '/c/sessions/a/history.jsonl', '/c/sessions/rollout-a.jsonl (deleted)', '/c/rollout-a.jsonl']) {
      expect(held.test(path), path).toBe(false)
    }
  })
})
