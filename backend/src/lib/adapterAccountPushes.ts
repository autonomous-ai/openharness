import { subscribeDeskChanged, subscribeDeviceMachineListChanged } from './bus.js'

/**
 * The pushes a daemon socket carries for its ACCOUNT rather than for its machine: something the
 * signed-in user can see changed on some worker, so this computer's app should re-read it.
 *
 * Each is a connection-less down frame with only enough payload to decide whether to fetch — the
 * daemon (backendSocket.ts) relays it to the window, which re-reads through the daemon's proxy. A burst
 * of changes therefore collapses into reads, and a missed push costs a stale view until the next one.
 *
 *  - `desk_changed`     — the account's tabs.
 *  - `machines_changed` — the account's machine list: a machine created / renamed / deleted, or a
 *    shared harness invited / taken back (routes/harnessShares.ts pokes the recipient). This is what
 *    lets the app discover invitations without polling `/api/machines` + `/api/harness-shares`.
 *
 * Resolves to the unsubscribe for both.
 */
export async function relayAccountPushes(userId: string, send: (frame: unknown) => unknown): Promise<() => void> {
  const deskUnsub = await subscribeDeskChanged(userId, (msg) => {
    send({ t: 'down', connId: '', frame: { type: 'desk_changed', payload: { revision: msg.revision } } })
  })
  let machinesUnsub: () => void
  try {
    machinesUnsub = await subscribeDeviceMachineListChanged(userId, (msg) => {
      send({ t: 'down', connId: '', frame: { type: 'machines_changed', payload: { reason: msg.reason } } })
    })
  } catch (err) {
    deskUnsub()
    throw err
  }
  return () => { deskUnsub(); machinesUnsub() }
}
