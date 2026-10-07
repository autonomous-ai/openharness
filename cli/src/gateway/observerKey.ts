/**
 * Share's owner's key, held here with this machine's E2EE identity (`core.account.observerKey`): its public
 * half, and the signature on a welcome to one observer of one share, with the context Share's handshake binds
 * to that share (sharing/crypto.ts `observerContext`). Share, in a process of its own, holds no credential and
 * asks the gateway for each welcome, as the fleet's lane asks it to seal (gateway/lane.ts).
 */
import type { ObserverKey } from '../core/api.js'
import { b64d, b64e, welcomeSig, type Identity } from '../lib/e2ee/core.js'
import { observerContext } from '../sharing/crypto.js'

export function observerKey(identity: () => Identity): ObserverKey {
  return {
    publicKey: async () => b64e(identity().pub),
    signWelcome: async (machineId, shareId, peer, ephemeral) => {
      const theirs = b64d(peer), ours = b64d(ephemeral)
      // A welcome is two X25519 keys; anything else is not one, and is not signed.
      if (!machineId || !shareId || theirs.length !== 32 || ours.length !== 32) throw new Error('not a welcome to an observer')
      return b64e(welcomeSig(identity().priv, observerContext(machineId, shareId), theirs, ours))
    },
  }
}
