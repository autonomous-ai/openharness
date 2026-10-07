/**
 * Share in a process of its own (services/sharing.ts): the owner signs with a key it does not hold, and the
 * core reads the observers' terminals. The same owner, the same handshake and the same frames as with the
 * identity and the stream manager in its hands (owner.spec.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { b64e, newEphemeral, newIdentity, welcomeSig } from '../lib/e2ee/core.js'
import type { RegisteredSession } from '../lib/registry.js'
import { observerContext, recipientHandshake, signedOwnerHandshake, type OwnerKey } from './crypto.js'
import { HarnessGrantStore } from './grants.js'
import { HarnessShareOwner } from './owner.js'

const identity = newIdentity()
/** The owner's key as the gateway holds it: the identity's private half never leaves it. */
const key: OwnerKey = {
  publicKey: async () => identity.pub,
  signWelcome: async (machineId, shareId, peer, ephemeral) => welcomeSig(identity.priv, observerContext(machineId, shareId), peer, ephemeral),
}

describe('Share with its key and its terminals held elsewhere', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'share-seams-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('signs a welcome the observer verifies against the owner\'s published key', async () => {
    const ephemeral = newEphemeral()
    const { cipher, welcome } = await signedOwnerHandshake(key, 'machine', 'share-1', b64e(ephemeral.pub))
    const theirs = recipientHandshake(ephemeral, 'machine', 'share-1', b64e(identity.pub), welcome)
    expect(theirs.open(cipher.seal({ type: 'hello', payload: {} }))).toEqual({ type: 'hello', payload: {} })
    await expect(signedOwnerHandshake(key, 'machine', 'share-1', b64e(new Uint8Array(3)))).rejects.toThrow('Invalid observer key')
  })

  it('invites under the key\'s public half, welcomes with its signature, and hands terminal frames to the streams it was given', async () => {
    const store = new HarnessGrantStore(join(root, 'grants.json'))
    const frames: Array<{ id: string; type: string; payload: any }> = []
    let targets: { sendTarget(id: string, type: string, payload: Record<string, unknown>): boolean } | null = null
    const streams = { handleFrame: vi.fn(async () => true), closeConnection: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const agent = { agentId: 'agent', sessionId: 's', engine: 'codex', active: true } as unknown as RegisteredSession
    const owner = new HarnessShareOwner({
      machineId: () => 'machine', key, grants: store, resolveAgent: (id) => (id === 'agent' ? agent : undefined),
      send: (id, type, payload) => { frames.push({ id, type, payload }); return true },
      publish: async () => ({ status: 200, body: {} }),
      streams: (given) => { targets = given; return streams as never },
    })
    try {
      await owner.manage('harness_share_invite', { agentId: 'agent', emails: ['ken@example.com'] })
      const grant = store.list('machine', 'agent')[0]
      expect(grant.ownerPublicKey).toBe(b64e(identity.pub))
      const ephemeral = newEphemeral()
      await owner.receive('observer:ken', 'observer_open', { shareId: grant.id, email: 'ken@example.com', ephemeral: b64e(ephemeral.pub) })
      const welcome = frames.find((f) => f.type === 'observer_welcome')!
      const cipher = recipientHandshake(ephemeral, 'machine', grant.id, b64e(identity.pub), welcome.payload)
      await owner.receive('observer:ken', 'observer_frame', cipher.seal({ type: 'terminal_open', payload: { agentId: 'agent', requestId: 'r1' } }) as never)
      expect(streams.handleFrame).toHaveBeenCalledWith('observer:ken', 'terminal_open', { agentId: 'agent', requestId: 'r1' })
      // What the core's streams have for the observer is sealed to it, as the owner's own were.
      expect(targets!.sendTarget('observer:ken', 'terminal_frame', { bytes: 'x' })).toBe(true)
      expect(cipher.open(frames.at(-1)!.payload)).toEqual({ type: 'terminal_frame', payload: { bytes: 'x' } })
      owner.close('observer:ken')
      expect(streams.closeConnection).toHaveBeenCalledWith('observer:ken')
    } finally {
      await owner.stop()
    }
    expect(streams.stop).toHaveBeenCalledOnce()
  })
})
