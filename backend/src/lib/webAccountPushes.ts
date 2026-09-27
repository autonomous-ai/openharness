import { subscribeDeskChanged, subscribeZooChanged } from './bus.js'

/**
 * The account documents a WEB socket hears about — the desk and the zoo — forwarded to the clients
 * that have no daemon to relay them: the phone and the browser. The same invalidations every adapter
 * socket hears (lib/adapterAccountPushes.ts), as plain frames: one carrying the revision, the document
 * itself re-read over REST, so a burst of edits collapses into one GET.
 *
 *  - `desk_changed` — the account's tabs.
 *  - `zoo_changed`  — the account's daemons and eggs (routes/zoo.ts), its own frame: a desk change
 *    never re-fetches the zoo and the other way round.
 *
 * ⚠️ A phone holds one of these sockets PER MACHINE, so it hears each change once per machine. The
 * revision is what makes that harmless: an app already at that revision fetches nothing.
 *
 * `zoo` is the server's daemons switch (lib/daemonsSwitch.ts): off, only the desk is listened on.
 *
 * Resolves to the unsubscribe for both.
 */
export async function relayWebDocumentPushes(userId: string, send: (frame: unknown) => unknown, opts: { zoo: boolean }): Promise<() => void> {
  const unsubs: Array<() => void> = []
  const stop = (): void => { for (const unsub of unsubs.splice(0)) unsub() }
  try {
    unsubs.push(await subscribeDeskChanged(userId, (msg) => { send({ type: 'desk_changed', payload: { revision: msg.revision } }) }))
    if (opts.zoo) unsubs.push(await subscribeZooChanged(userId, (msg) => { send({ type: 'zoo_changed', payload: { revision: msg.revision } }) }))
  } catch (err) {
    stop()
    throw err
  }
  return stop
}
