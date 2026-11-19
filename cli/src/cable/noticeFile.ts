// The pending notices, kept on disk so a card the person has not acted on outlives a restart of the devices' process
// (a crash, a CLI update): the desk (notices.ts) holds the cards, and this file is their copy, read once at the start.
// It is this computer's, so it lives in the daemon's data folder beside dial-notify.json. One writer: the devices'
// process.
import { closeSync, openSync, readSync } from 'node:fs'
import { errorKind } from '../lib/log.js'
import { atomicWriteFile, jsonObject, readState } from '../lib/secureState.js'
import { SHOWN_ONLY_PREFIX } from './cableSession.js'
import {
  NOTICE_KEY_MAX_CHARS, NOTICE_KEYS_MAX, NOTICE_LINE_MAX_BYTES, NOTICES_PENDING_MAX, type StoredNotice,
} from './notices.js'

export const NOTICES_FILE = 'dial-notices.json'
/** Twenty cards are about 10 KB; anything much larger is not ours, and reading it whole would cost the start. */
export const NOTICES_FILE_MAX_BYTES = 32 * 1024
/** Changes that come close together (a card ended and the next shown, an agent's lists) are one write. */
export const NOTICES_WRITE_MS = 1_000

export interface NoticeFileDeps {
  file: string
  /** The pending set, oldest first, read as a write runs. */
  cards(): readonly StoredNotice[]
  /** Runs [run] after [ms]; answers its cancel. */
  after(ms: number, run: () => void): () => void
  log(line: string): void
}

/** Why a file is dropped: one fixed word, never the path or what the file says. */
type Dropped = 'long' | 'json' | 'version' | 'shape' | 'unreadable'

const sized = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max

const isWho = (who: unknown): boolean => {
  if (typeof who !== 'object' || who === null) return false
  const { name, engine, machine } = who as Record<string, unknown>
  return sized(name, 1, 256) && sized(engine, 0, 32) && sized(machine, 0, 256)
}

/** The reader's and the writer's one check, so a card written is a card read back. */
const isStoredNotice = (card: unknown): card is StoredNotice => {
  if (typeof card !== 'object' || card === null) return false
  const { agentId, keys, id, line, host, who, at } = card as Record<string, unknown>
  return sized(agentId, 1, 64)
    && Array.isArray(keys) && keys.length <= NOTICE_KEYS_MAX && keys.every((key) => sized(key, 1, NOTICE_KEY_MAX_CHARS))
    && sized(id, 0, 64) && id.startsWith(SHOWN_ONLY_PREFIX)
    && typeof line === 'string' && line !== '' && Buffer.byteLength(line) <= NOTICE_LINE_MAX_BYTES
    && sized(host, 0, 32)
    && (who === undefined || isWho(who))
    && typeof at === 'number' && Number.isSafeInteger(at) && at >= 0
}

/** A card of its known fields only: what another build added is not carried. */
const known = ({ agentId, keys, id, line, host, who, at }: StoredNotice): StoredNotice => ({
  agentId, keys: [...keys], id, line, host,
  ...(who && { who: { name: who.name, engine: who.engine, machine: who.machine } }),
  at,
})

/** The file's cards; none when there is no file; or the word that says why it is dropped whole. */
const read = (file: string): StoredNotice[] | Dropped => {
  let text: string
  try {
    const fd = openSync(file, 'r')
    try {
      // One byte past the limit tells a file at the limit from a longer one.
      const buffer = Buffer.alloc(NOTICES_FILE_MAX_BYTES + 1)
      const length = readSync(fd, buffer, 0, buffer.length, 0)
      if (length > NOTICES_FILE_MAX_BYTES) return 'long'
      text = buffer.toString('utf8', 0, length)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : 'unreadable'
  }
  let parsed: Record<string, unknown>
  try {
    parsed = jsonObject(text)
  } catch {
    return 'json'
  }
  if (parsed.v !== 1) return 'version'
  const { cards } = parsed
  if (!Array.isArray(cards) || cards.length > NOTICES_PENDING_MAX || !cards.every(isStoredNotice)) return 'shape'
  // One card an agent, as the desk keeps them.
  if (new Set(cards.map((card) => card.agentId)).size < cards.length) return 'shape'
  return cards.map(known)
}

const textOf = (cards: readonly StoredNotice[]): string => `${JSON.stringify({ v: 1, cards })}\n`

export class NoticeFile {
  private cancel: (() => void) | undefined
  private closed = false

  constructor(private readonly deps: NoticeFileDeps) {}

  /** The cards the file keeps. A file that cannot be trusted is dropped whole, in one line, and the next write
   *  replaces it: nothing in it may stop the devices' process from starting, so this never throws. */
  load(): StoredNotice[] {
    let cards = read(this.deps.file)
    // One that cannot be read or parsed goes to the shared reader, which tries again and sets it aside, so the next
    // write cannot replace it unseen. The bounded read stays first: it keeps a large file from being read whole.
    if (cards === 'json' || cards === 'unreadable') {
      if (readState(this.deps.file, 'cache', jsonObject).state !== 'ok') return []
      cards = read(this.deps.file)
    }
    if (Array.isArray(cards)) return cards
    this.deps.log(`[device] notices · file dropped · ${cards}`)
    return []
  }

  /** The pending set changed: it is written once NOTICES_WRITE_MS has passed, as it is then. */
  changed(): void {
    if (this.cancel || this.closed) return
    this.cancel = this.deps.after(NOTICES_WRITE_MS, () => {
      this.cancel = undefined
      this.write()
    })
  }

  /** The devices' process stops: what waits is written now, and nothing after, so the stop's own endings (its detach,
   *  a listing source's emptied list) leave the file as it was. */
  close(): void {
    const waiting = this.cancel
    this.cancel = undefined
    this.closed = true
    if (!waiting) return
    waiting()
    this.write()
  }

  private write(): void {
    let cards = this.deps.cards().filter(isStoredNotice)
    let text = textOf(cards)
    // The oldest go first: they are the least likely still to be true.
    while (Buffer.byteLength(text) > NOTICES_FILE_MAX_BYTES) {
      cards = cards.slice(1)
      text = textOf(cards)
    }
    try {
      atomicWriteFile(this.deps.file, text, 'cache')
    } catch (error) {
      // Its kind, never the message, which names the path. Memory stays the truth; the next change tries again.
      this.deps.log(`[device] notices · not saved · ${errorKind(error)}`)
    }
  }
}
