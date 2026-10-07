import { describe, expect, it } from 'vitest'
import { b64e, newEphemeral, newIdentity } from '../lib/e2ee/core.js'
import { recipientHandshake, signedOwnerHandshake } from '../sharing/crypto.js'
import { b64d } from '../lib/e2ee/core.js'
import { observerKey } from './observerKey.js'

describe('Share\'s owner\'s key, held by the gateway', () => {
  it('says its public half and signs a welcome the observer verifies, holding the private half to itself', async () => {
    const identity = newIdentity()
    const key = observerKey(() => identity)
    expect(await key.publicKey()).toBe(b64e(identity.pub))
    const ephemeral = newEphemeral()
    // The owner's side, as Share in its own process runs it: the signature asked of the gateway.
    const { welcome } = await signedOwnerHandshake({
      publicKey: async () => b64d(await key.publicKey()),
      signWelcome: async (machineId, shareId, peer, ours) => b64d(await key.signWelcome(machineId, shareId, b64e(peer), b64e(ours))),
    }, 'machine', 'share-1', b64e(ephemeral.pub))
    expect(() => recipientHandshake(ephemeral, 'machine', 'share-1', b64e(identity.pub), welcome)).not.toThrow()
    // Bound to its share: another share's observer refuses it.
    expect(() => recipientHandshake(ephemeral, 'machine', 'share-2', b64e(identity.pub), welcome)).toThrow()
  })

  it('signs nothing that is not a welcome to an observer', async () => {
    const key = observerKey(() => newIdentity())
    const key32 = b64e(new Uint8Array(32))
    for (const [machineId, shareId, peer, ours] of [['', 's', key32, key32], ['m', '', key32, key32], ['m', 's', b64e(new Uint8Array(3)), key32], ['m', 's', key32, b64e(new Uint8Array(64))]]) {
      await expect(key.signWelcome(machineId, shareId, peer, ours)).rejects.toThrow('not a welcome')
    }
  })
})
