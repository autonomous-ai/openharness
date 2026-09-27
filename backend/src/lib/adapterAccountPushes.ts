import { subscribeDeskChanged, subscribeDeviceMachineListChanged, subscribeZooChanged } from './bus.js'

/**
 * The pushes a daemon socket carries for its ACCOUNT rather than for its machine: something the
 * signed-in user can see changed on some worker, so this computer's app should re-read it.
 *
 * Each is a connection-less down frame with only enough payload to decide whether to fetch — the
 * daemon (backendSocket.ts) relays it to the window, which re-reads through the daemon's proxy. A burst
 * of changes therefore collapses into reads, and a missed push costs a stale view until the next one.
 *
 *  - `desk_changed`     — the account's tabs.
 *  - `zoo_changed`      — the account's daemons and eggs (routes/zoo.ts). Its own frame, so a desk
 *    change never re-fetches the zoo and the other way round.
 *  - `machines_changed` — the account's machine list: a machine created / renamed / deleted, or a
 *    shared harness invited / taken back (routes/harnessShares.ts pokes the recipient). This is what
 *    lets the app discover invitations without polling `/api/machines` + `/api/harness-shares`.
 *
 * `zoo` is the server's daemons switch (lib/daemonsSwitch.ts): off, the zoo channel is not even listened
 * on, since nothing publishes it.
 *
 * Resolves to the unsubscribe for all of them.
 */
export async function relayAccountPushes(userId: string, send: (frame: unknown) => unknown, opts: { zoo: boolean }): Promise<() => void> {
  const unsubs: Array<() => void> = []
  const stop = (): void => { for (const unsub of unsubs.splice(0)) unsub() }
  try {
    unsubs.push(await subscribeDeskChanged(userId, (msg) => {
      send({ t: 'down', connId: '', frame: { type: 'desk_changed', payload: { revision: msg.revision } } })
    }))
    if (opts.zoo) {
      unsubs.push(await subscribeZooChanged(userId, (msg) => {
        send({ t: 'down', connId: '', frame: { type: 'zoo_changed', payload: { revision: msg.revision } } })
      }))
    }
    unsubs.push(await subscribeDeviceMachineListChanged(userId, (msg) => {
      send({ t: 'down', connId: '', frame: { type: 'machines_changed', payload: { reason: msg.reason } } })
    }))
  } catch (err) {
    stop()
    throw err
  }
  return stop
}
