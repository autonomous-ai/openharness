import { describe, expect, it, vi } from 'vitest'
import { ENGINE_PROBE_REQUESTS } from '../core/api.js'
import { ENGINES } from '../engines/types.js'
import { supportsFirstPrompt } from '../lib/engineLaunch.js'
import type { EngineAvailability, probeEngines } from '../lib/engineProbe.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startEngineProbe } from './engineProbe.js'

const OWNER = { local: true, owner: true }
const GUEST = { local: false, owner: false, guest: 'kim@acme.io' }

function started(found: EngineAvailability[] | Error = []) {
  const probe = vi.fn<typeof probeEngines>(async () => { if (found instanceof Error) throw found; return found })
  return { probe, requests: startEngineProbe(fakeCore(), { probe }) }
}

describe('which engines this machine has, asked before a create', () => {
  it('answers the one request the core routes to it', () => {
    expect(Object.keys(started().requests)).toEqual([...ENGINE_PROBE_REQUESTS])
  })

  it('says for each engine whether it is installed, how to install it, and what this machine can do with it', async () => {
    const { requests } = started([
      { engine: 'claude', installed: true, command: 'claude', installable: false, signedIn: true, lastUsedAt: 1_794_000_000_000 },
      { engine: 'codex', installed: true, command: 'codex', installable: false, signedIn: null, lastUsedAt: undefined },
      { engine: 'cursor', installed: false, command: 'cursor-agent', installable: true },
      { engine: 'openclaw', installed: true, command: 'openclaw', installable: false, unavailable: 'needs Node 22' },
    ] as EngineAvailability[])
    const reply = await requests.engines_probe!({}, OWNER) as { engines: Array<Record<string, unknown>> }
    expect(reply.engines.map((entry) => entry.engine)).toEqual(['claude', 'codex', 'cursor', 'openclaw'])
    // Whether this machine can hand each a first prompt, read here and not where the caller runs (#1788); and that a
    // pane waits for an engine still downloading rather than installing it again.
    for (const entry of reply.engines) expect(entry).toMatchObject({ firstPrompt: supportsFirstPrompt(entry.engine as never), waitsForDownload: true })
    expect(reply.engines[0]).toEqual({ engine: 'claude', installed: true, command: 'claude', installable: false, installCommand: null,
      signedIn: true, lastUsedAt: 1_794_000_000_000, firstPrompt: true, waitsForDownload: true })
    // A sign-in that could not be read is unknown, with no last use; Codex says it takes a home of its own.
    expect(reply.engines[1]).toMatchObject({ signedIn: null, lastUsedAt: null, supportsCodexHome: true })
    expect(reply.engines[0]).not.toHaveProperty('supportsCodexHome')
    // One that can be installed here comes with the line the app shows first; one that says nothing of a sign-in has none.
    expect(reply.engines[2]).toMatchObject({ installed: false, installable: true })
    expect(typeof reply.engines[2]!.installCommand).toBe('string')
    expect(reply.engines[2]).not.toHaveProperty('signedIn')
    expect(reply.engines[2]).not.toHaveProperty('lastUsedAt')
    // Installed and unable to run here: New shows it and blocks Start.
    expect(reply.engines[3]).toMatchObject({ unavailable: 'needs Node 22' })
    expect(reply.engines[0]).not.toHaveProperty('unavailable')
  })

  it('probes the engines the caller shows, and all of them when it names none it knows', async () => {
    const { probe, requests } = started()
    await requests.engines_probe!({ engines: ['claude', 'no-such-engine', 7, 'codex'] }, OWNER)
    expect(probe).toHaveBeenLastCalledWith(['claude', 'codex'], { accounts: true })
    // An older app sends nothing; a list of nothing it knows, or not a list, is the same.
    for (const engines of [undefined, [], ['no-such-engine'], 'claude']) {
      await requests.engines_probe!({ engines }, OWNER)
      expect(probe).toHaveBeenLastCalledWith(undefined, { accounts: true })
    }
    expect(ENGINES).toContain('claude')
  })

  // A guest starts its own agents on its own sign-in: it needs which engines are installed, never whether the owner
  // is signed in to each or when the owner last used it (#4259, from #4216's security review).
  it('reads nothing of the owner\'s sign-in or last use for a guest', async () => {
    const { probe, requests } = started([{ engine: 'claude', installed: true, command: 'claude', installable: false }] as EngineAvailability[])
    const reply = await requests.engines_probe!({ engines: ['claude'] }, GUEST) as { engines: Array<Record<string, unknown>> }
    expect(probe).toHaveBeenLastCalledWith(['claude'], { accounts: false })
    expect(reply.engines[0]).toMatchObject({ engine: 'claude', installed: true })
    expect(reply.engines[0]).not.toHaveProperty('signedIn')
    expect(reply.engines[0]).not.toHaveProperty('lastUsedAt')
  })

  // The probe answers for every engine whatever fails (lib/engineProbe.ts): one that could not run at all is this
  // service's failure, which its host says and answers SERVICE_FAILED (services/AGENTS.md), never an answer of its own.
  it('leaves a probe that could not run at all to its host', async () => {
    const { requests } = started(new Error('spawn EAGAIN'))
    await expect(requests.engines_probe!({}, OWNER)).rejects.toThrow('spawn EAGAIN')
  })

  it('probes with the real probe unless given one', () => {
    expect(Object.keys(startEngineProbe(fakeCore()))).toEqual(['engines_probe'])
  })
})
