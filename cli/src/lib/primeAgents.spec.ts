import { afterEach, describe, expect, it } from 'vitest'
import { isAttachedRoot, listPrimeAgents, parsePrimeList, primeAttachTarget, primeAttachedSession, primeSessionAttached, setPrimeListRunner } from './primeAgents.js'

// Shapes as `prime-agent list --json` printed them (prime-agent 0.9.5), trimmed to the fields read.
const ROOT = { id: 'a342e86e1ec6', sessionId: '01a15135-c442-71eb-ab4c-34771f76c342', sessionFile: '/h/.prime/agent/sessions/01a15135-c442-71eb-ab4c-34771f76c342.jsonl',
  cwd: '/tmp/ws', rlmDepth: 0, runtimeKind: 'top-level', lifecycle: 'live', attachedClients: 1, isStreaming: false, workerPid: 82731 }
const CHILD = { ...ROOT, id: 'af7d0673da46', sessionId: '01a15136-8d70-745f-a3ae-0538ec515c20', rlmDepth: 1, runtimeKind: 'subagent',
  sessionFile: '/h/.prime/agent/session-artifacts/01a15135/sub-c2314faa/01a15136-8d70-745f-a3ae-0538ec515c20.jsonl' }
const DETACHED = { ...ROOT, id: '703314d28b83', sessionId: '01a15133-97de-726e-b801-82ae04e9e9ba', attachedClients: 0 }
const list = (...sessions: object[]) => JSON.stringify({ sessions })

afterEach(() => setPrimeListRunner(null))

describe('prime-agent list', () => {
  it('parses rows and refuses anything that is not the list', () => {
    expect(parsePrimeList(list(ROOT, CHILD))?.map((r) => r.id)).toEqual(['a342e86e1ec6', 'af7d0673da46'])
    expect(parsePrimeList('Error: daemon unavailable')).toBeNull()
    expect(parsePrimeList('{"agents":[]}')).toBeNull()
  })

  it('counts only a live, attached, top-level root as what a pane shows', () => {
    const [root, child, detached] = parsePrimeList(list(ROOT, CHILD, DETACHED))!
    expect([isAttachedRoot(root), isAttachedRoot(child), isAttachedRoot(detached)]).toEqual([true, false, false])
  })

  it('answers no evidence when Prime cannot be asked', async () => {
    setPrimeListRunner(async () => { throw new Error('ENOENT') })
    expect(await listPrimeAgents()).toBeNull()
    expect(await primeSessionAttached(ROOT.sessionId)).toBe(false)
  })

  it('verifies a hook session only while it is attached (a -p run is not listed at all)', async () => {
    setPrimeListRunner(async () => list(ROOT, CHILD, DETACHED))
    expect(await primeSessionAttached(ROOT.sessionId)).toBe(true)
    expect(await primeSessionAttached(CHILD.sessionId)).toBe(false)
    expect(await primeSessionAttached(DETACHED.sessionId)).toBe(false)
    expect(await primeSessionAttached('01a1513b-e73e-73ee-9b88-979099afb594')).toBe(false)
    expect(await primeSessionAttached(undefined)).toBe(false)
  })
})

describe('which conversation a Prime client shows', () => {
  it('reads `attach <agent>` off the command line', () => {
    expect(primeAttachTarget('prime-agent attach a342e86e1ec6')).toBe('a342e86e1ec6')
    expect(primeAttachTarget('prime-agent -e /tmp/probe.ts')).toBeNull()
    expect(primeAttachTarget('prime-agent attach')).toBeNull()
  })

  it('maps an attached agent id to its session, and a folder to its one attached root', async () => {
    setPrimeListRunner(async () => list(ROOT, CHILD, DETACHED))
    expect(await primeAttachedSession('/elsewhere', 'prime-agent attach a342e86e1ec6')).toEqual({ sessionId: ROOT.sessionId, transcriptPath: ROOT.sessionFile })
    expect(await primeAttachedSession('/tmp/ws')).toEqual({ sessionId: ROOT.sessionId, transcriptPath: ROOT.sessionFile })
    expect(await primeAttachedSession('/tmp/other')).toBeNull()
  })

  it('does not break a tie between two attached roots in one folder', async () => {
    setPrimeListRunner(async () => list(ROOT, { ...ROOT, id: 'bbbbbbbbbbbb', sessionId: '01a15199-0000-7000-8000-000000000000' }))
    expect(await primeAttachedSession('/tmp/ws')).toBeNull()
  })
})
