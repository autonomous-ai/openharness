import { subscribeConnectorsChanged, subscribeDeskChanged, subscribeDeviceKeysChanged, subscribeDeviceMachineListChanged, subscribeZooChanged } from './bus.js'
import { relaySwarmChanges } from './swarmClientPushes.js'

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
 *  - `device_keys_changed` — the account's device key log grew (lib/deviceKeyLog.ts). Unlike the rest it
 *    is for the DAEMON itself, which trusts the keys the log holds: it re-reads from its own head.
 *  - `connectors_changed` — the account's sealed connections changed (routes/connectorVault.ts). Also
 *    for the daemon: it re-reads the envelope and merges it into this computer's connections.
 *  - `swarm_changed`    — a Swarm the account is in changed (lib/swarmClientPushes.ts, off unless
 *    SWARM_CLIENT_PUSH=on): the windows read it again instead of every 3 s.
 *
 * `zoo` is the server's daemons switch (lib/daemonsSwitch.ts): off, the zoo channel is not even listened
 * on, since nothing publishes it.
 *
 * `team`: the socket is a Mac's team account (lib/teamSession.ts), which reads none of the account's desk,
 * zoo, machine list or connections. It hears only `device_keys_changed`, which its own trust needs.
 *
 * Resolves to the unsubscribe for all of them.
 */
export async function relayAccountPushes(userId: string, send: (frame: unknown) => unknown, opts: { zoo: boolean; team?: boolean }): Promise<() => void> {
  const unsubs: Array<() => void> = []
  const stop = (): void => { for (const unsub of unsubs.splice(0)) unsub() }
  const deviceKeys = (msg: { seq: number; hash: string }): void => {
    send({ t: 'down', connId: '', frame: { type: 'device_keys_changed', payload: { seq: msg.seq, hash: msg.hash } } })
  }
  if (opts.team) {
    unsubs.push(await subscribeDeviceKeysChanged(userId, deviceKeys))
    return stop
  }
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
    unsubs.push(await subscribeDeviceKeysChanged(userId, deviceKeys))
    unsubs.push(await subscribeConnectorsChanged(userId, (msg) => {
      send({ t: 'down', connId: '', frame: { type: 'connectors_changed', payload: { revision: msg.revision } } })
    }))
    unsubs.push(await relaySwarmChanges(userId, (frame) => send({ t: 'down', connId: '', frame })))
  } catch (err) {
    stop()
    throw err
  }
  return stop
}
