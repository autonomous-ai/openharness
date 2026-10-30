/**
 * The fleet's lane's sessions, held by the gateway (docs/design/2026-10-06-core-boundary-next.md, step 10,
 * R3). The lane (device/deviceLink.ts) is the daemon's socket to its owner's other machines on the dial's
 * behalf; it used to hold this machine's E2EE identity to seal what it sent them, and a service holds no
 * credential. The identity stays here with every other key: the lane asks for a session per machine,
 * and for each frame to be sealed or opened under it (`core.account.lane`, `LaneSeal`).
 *
 * The same sessions the lane ran itself (lib/e2ee/relayClient.ts), one per machine, keyed by its id: a
 * new hello replaces the machine's session, as the lane's own map did. No session, or one not yet up,
 * seals nothing: `lost`, never the frame as it came, so a frame for a linked machine is never sent in
 * the clear because the gateway restarted under the lane.
 */
import type { LaneOpened, LaneSeal, LaneSealed } from '../core/api.js'
import { b64d, type Identity } from '../lib/e2ee/core.js'
import { GROUP_EPOCHS_KEPT, RelaySessionCrypto } from '../lib/e2ee/relayClient.js'

type Frame = Record<string, unknown>

export class LaneSessions implements LaneSeal {
  private readonly sessions = new Map<string, RelaySessionCrypto>()
  /**
   * Every group epoch a session with each machine has held, oldest first, kept past the session itself.
   *
   * WHY AN UNKNOWN EPOCH IS NOT "UNREADABLE". A far daemon that restarts (every CLI release updates it)
   * comes back with a new group key and epoch, and replays its agents and open questions under them at
   * once. The session here is with the process that is gone, so none of it opens — and read as merely
   * unreadable it was dropped and the session kept: 1,130 frames in a day on Diego's Mac, 9 bursts, each
   * a few minutes after a release, and the questions in them never shown. An epoch NO session here ever
   * held means the far process is new. One a session here did hold is a late frame from an old process
   * and stays unreadable: it must not throw away the session that replaced it.
   */
  private readonly epochs = new Map<string, string[]>()
  /**
   * Each machine's group counters (epoch → highest counter read), shared by every session with it, as the
   * windows' relay shares them (lib/remoteRelay.ts). A session that started from nothing would open again
   * a card an earlier session already read: a relay could force a renewal (a made-up epoch, an offline
   * notice) and then replay an old question or turn card from the same far process (security review 2
   * on #2356). Bounded per machine by the session (GROUP_EPOCHS_KEPT epochs).
   */
  private readonly groupSeen = new Map<string, Map<string, number>>()

  /** `identity` is read when a session starts: the one on disk, as the gateway's own store holds it. */
  constructor(private readonly identity: () => Identity) {}

  async hello(machineId: string, peerPub: string): Promise<Frame> {
    let groupSeen = this.groupSeen.get(machineId)
    if (!groupSeen) { groupSeen = new Map(); this.groupSeen.set(machineId, groupSeen) }
    const session = new RelaySessionCrypto({ machineId, selfIdentity: this.identity(), peerPub: b64d(peerPub), groupSeen })
    this.sessions.set(machineId, session)
    return session.helloFrame()
  }

  async welcome(machineId: string, payload: Frame): Promise<boolean> {
    const session = this.sessions.get(machineId)
    if (!session?.handleWelcome(payload)) return false
    this.remember(machineId, session.groupEpoch)
    return true
  }

  async rekey(machineId: string, payload: Frame): Promise<void> {
    const session = this.sessions.get(machineId)
    if (session?.handleRekey(payload)) this.remember(machineId, session.groupEpoch)
  }

  async seal(machineId: string, frame: Frame): Promise<LaneSealed> {
    const session = this.sessions.get(machineId)
    if (!session?.ready) return { lost: true }
    return { frame: session.wrapOutgoing(frame) }
  }

  async open(machineId: string, frame: Frame): Promise<LaneOpened> {
    const session = this.sessions.get(machineId)
    if (!session?.ready) return { lost: true }
    const env = (frame.payload as { __e2e?: { k?: unknown; epoch?: unknown } } | undefined)?.__e2e
    if (env?.k === 'g' && typeof env.epoch === 'string' && env.epoch !== session.groupEpoch
      && !this.epochs.get(machineId)?.includes(env.epoch)) return { unknownEpoch: true }
    const plain = session.unwrapIncoming(frame)
    return plain ? { frame: plain } : { unreadable: true }
  }

  drop(machineId: string): void {
    this.sessions.delete(machineId)
  }

  /** The gateway is stopping: every session goes with it. */
  clear(): void {
    this.sessions.clear()
    this.epochs.clear()
    this.groupSeen.clear()
  }

  private remember(machineId: string, epoch: string): void {
    const seen = this.epochs.get(machineId) ?? []
    if (!epoch || seen.includes(epoch)) return
    seen.push(epoch)
    // As many as a session keeps counters for (relayClient.ts): a few restarts' worth, the oldest let go.
    if (seen.length > GROUP_EPOCHS_KEPT) seen.shift()
    this.epochs.set(machineId, seen)
  }
}
