/**
 * Shared tabs' keys, held here with this machine's E2EE identity, as Share's welcome (observerKey.ts) and the
 * fleet's lane (lane.ts) are: Agent Messages runs in the edge host and holds no credential. One session per peer
 * machine of a shared tab, keyed by tab and machine; a new hello or accept replaces it. No session seals nothing:
 * `lost`, never the frame as it came.
 *
 * Everything here may have come off the wire through two processes, so nothing is assumed to be the type it says:
 * a hello or welcome that is not an object is refused, never read.
 */
import type { LaneOpened, LaneSealed, TabKey, TabLink } from '../core/api.js'
import { b64d, b64e, sign, type Identity } from '../lib/e2ee/core.js'
import { acceptTabSession, startTabSession, type TabCipher, type TabHello } from '../lib/e2ee/tabSession.js'
import { keyChangeBytes, rosterBytes } from '../messages/roster.js'

type Frame = Record<string, unknown>
type Pending = ReturnType<typeof startTabSession>
const TAB = /^[a-f0-9]{24}$/
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const record = (v: unknown): Frame => (v && typeof v === 'object' && !Array.isArray(v) ? v as Frame : {})

export class TabSessions implements TabKey {
  private readonly pending = new Map<string, Pending>()
  private readonly ciphers = new Map<string, TabCipher>()
  constructor(private readonly identity: () => Identity, private readonly machineId: () => string) {}
  private id = (link: TabLink) => `${link.sharedTabId}:${link.machineId}`

  async publicKey(): Promise<string> { return b64e(this.identity().pub) }

  async signRoster(sharedTabId: string, version: number, body: string): Promise<string> {
    if (typeof sharedTabId !== 'string' || !TAB.test(sharedTabId) || !Number.isSafeInteger(version) || version < 1
      || typeof body !== 'string') throw new Error('not a roster')
    return b64e(sign(this.identity().priv, rosterBytes(sharedTabId, version, body)))
  }

  /** `b64d` throws for what is not a string on Node and skips what is not base64 in one, so a key is a string that
   *  decodes to exactly 32 bytes. */
  async signKeyChange(sharedTabId: string, nextPub: string): Promise<string> {
    if (typeof sharedTabId !== 'string' || !TAB.test(sharedTabId) || typeof nextPub !== 'string' || b64d(nextPub).length !== 32) {
      throw new Error('not a key')
    }
    return b64e(sign(this.identity().priv, keyChangeBytes(sharedTabId, nextPub)))
  }

  async hello(link: TabLink): Promise<Frame> {
    const start = startTabSession(this.identity(), link.sharedTabId, this.machineId(), link.machineId)
    this.ciphers.delete(this.id(link))
    this.pending.set(this.id(link), start)
    return { ...start.hello }
  }

  /** A session's finish is one-shot (tabSession.ts): a welcome that fails spends it too, so the hello goes with it
   *  and the caller starts again with a new one. */
  async welcome(link: TabLink, payload: Frame): Promise<boolean> {
    const pending = this.pending.get(this.id(link))
    if (!pending) return false
    this.pending.delete(this.id(link))
    const welcome = record(payload)
    const cipher = pending.finish({ ephemeral: str(welcome.ephemeral), signature: str(welcome.signature) }, link.peerPub)
    if (!cipher) return false
    this.ciphers.set(this.id(link), cipher)
    return true
  }

  /** A hello that is refused leaves the session there was: a stranger's hello must not end a peer's. */
  async accept(link: TabLink, hello: Frame): Promise<{ welcome: Frame } | { refused: true }> {
    const theirs = record(hello)
    const accepted = acceptTabSession(this.identity(), link.sharedTabId, link.machineId, this.machineId(),
      { ephemeral: str(theirs.ephemeral), signature: str(theirs.signature) } satisfies TabHello, link.peerPub)
    if (!accepted) return { refused: true }
    this.pending.delete(this.id(link))
    this.ciphers.set(this.id(link), accepted.cipher)
    return { welcome: { ...accepted.welcome } }
  }

  async seal(link: TabLink, frame: Frame): Promise<LaneSealed> {
    const cipher = this.ciphers.get(this.id(link))
    return cipher ? { frame: cipher.seal(frame) as unknown as Frame } : { lost: true }
  }

  async open(link: TabLink, frame: Frame): Promise<LaneOpened> {
    const cipher = this.ciphers.get(this.id(link))
    if (!cipher) return { lost: true }
    const plain = cipher.open(frame)
    return plain ? { frame: plain } : { unreadable: true }
  }

  drop(link: TabLink): void { this.pending.delete(this.id(link)); this.ciphers.delete(this.id(link)) }

  /** The gateway is stopping: every session goes with it. */
  clear(): void { this.pending.clear(); this.ciphers.clear() }
}
