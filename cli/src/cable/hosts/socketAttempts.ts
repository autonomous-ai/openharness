/**
 * The wait on another program's Unix socket, its retries and its stale rule: one file, as herdr's source and Herdr
 * Core's reach their sockets the same way, and a second copy would be a second way
 * (docs/plans/2026-11-16-herdr-app-design.md, Q6).
 *
 * The retries give up only on a socket whose last attempt listed nothing, and keep its stamp. herdr writes its log beside
 * its socket on every request, so the watched folder keeps changing while a stale socket sits there: only another
 * socket, one a program that started again made, connects.
 *
 * A log line says only fixed words and counts.
 */
import type { SocketFault } from './unixSocket.js'

/** The waits before each retry of a failed attempt; after the last, the last again while each attempt lists, else only
 *  the watch. */
const RETRIES_S = [1, 2, 4, 8, 16, 32, 60]
/** Followed this long, a program that drops its subscription is retried from the first wait again. */
const LIVE_MS = 60_000
/** A socket this young may be bound before its server listens: its first refusal is tried once more (spec Q8). */
const YOUNG_MS = 2_000

/** A stamp's ctime in ms (`<inode>:<ctime in ns>`, unixSocket.ts socketStampOf); none for another form. */
export function bornAt(stamp: string | undefined): number | undefined {
  const ns = stamp?.match(/^\d+:(\d+)$/)?.[1]
  // A ctime in ns is past 2^53, where a Number loses digits.
  return ns === undefined ? undefined : Number(BigInt(ns) / 1_000_000n)
}

/** What the log says of the socket: none there, one with no server, or one a subscription started on. */
type SocketWord = 'none' | 'stale' | 'live'

export interface SocketAttemptsDeps {
  /** The word its lines start with, in brackets: `herdr`, `herdr-app`. */
  name: string
  socketStamp(): string | undefined
  watch(changed: () => void): () => void
  after(ms: number, run: () => void): () => void
  /** The wall clock, which a socket's ctime is read against. */
  now(): number
  monotonic(): number
  log(line: string): void
  /** Opens an attempt on the socket that is there. */
  open(): void
  /** Ends the attempt under way: its connections and its own timers. */
  close(): void
  /** Drops what was listed: another socket, a retry that failed, a wait. */
  clear(): void
}

export class SocketAttempts {
  /** The next retry. */
  private timer: (() => void) | undefined
  private unwatch: (() => void) | undefined
  /** The stamp of the socket the attempt tries, taken as it starts: a program that starts again meanwhile makes
   *  another. */
  private stamp: string | undefined
  /** The stamp of the stale socket the retries gave up on. */
  private stale: string | undefined
  /** The stamp a subscription last started on: a program ran behind that socket. Forgotten at stop. */
  private subscribed: string | undefined
  /** The stamp of the last socket given its one young retry, kept across a stop: a dial plugged in again gets none. */
  private young: string | undefined
  /** The socket's last word said, kept across a stop: a dial plugged in again to the same socket hears none again. */
  private word: SocketWord | undefined
  /** Since when the listed agents have been followed, with no failure since. */
  private liveSince: number | undefined
  private retries = 0

  constructor(private readonly deps: SocketAttemptsDeps) {}

  /** Looks for the socket: waits on the watch with none, else opens an attempt. */
  start(): void {
    this.connect()
  }

  /** Its timer and its watch go; its retries and the stamp a subscription started on are forgotten. */
  stop(): void {
    this.cancel()
    this.unwatch?.()
    this.unwatch = undefined
    this.liveSince = undefined
    this.retries = 0
    this.subscribed = undefined
  }

  /** A subscription started on the socket: `socket · live`. */
  started(): void {
    this.subscribed = this.stamp
    this.say('live')
  }

  /** The attempt listed: its agents are followed from now. */
  listed(): void {
    this.liveSince ??= this.deps.monotonic()
  }

  /** The attempt failed, by the client's word. It says `<said> · <fault>`, unless it is a refusal with nothing
   *  started on its stamp: then `retry · 1` once for a young socket, else stale at once. */
  failed(said: 'closed' | 'list', fault: SocketFault): void {
    if (fault === 'refused' && this.subscribed !== this.stamp) return this.refused()
    this.deps.log(`[${this.deps.name}] ${said} · ${fault}`)
    this.fail(fault)
  }

  private connect(): void {
    const stamp = this.deps.socketStamp()
    // Another socket is a program that started again and numbers its panes afresh: a row kept through a drop would take
    // the status of the new pane of its id, and a working one turned idle would say a done no turn had.
    if (stamp !== this.stamp) this.deps.clear()
    this.stamp = stamp
    if (!this.stamp) return this.wait(undefined)
    this.deps.open()
  }

  /**
   * A socket refused before anything subscribed on it has no server behind it: a herdr that stopped leaves its socket,
   * and the Mac this was found on had one from Aug 20, retried from 1 s to 60 s at every plug-in. It is given up on at
   * once, with no closed line as nothing opened; only another socket, a program that started again, is tried. A socket
   * under 2 s old is tried once more after 1 s first: a server binds its socket a moment before it listens. A refusal
   * on a socket a subscription started on keeps the retries (`fail`): that program may be starting again on the same
   * file.
   */
  private refused(): void {
    const born = bornAt(this.stamp)
    const age = born === undefined ? undefined : this.deps.now() - born
    // A ctime ahead of the clock is a clock set back, not a socket being born.
    if (age === undefined || age < 0 || age >= YOUNG_MS || this.young === this.stamp) return this.wait(this.stamp, true)
    this.young = this.stamp
    this.deps.close()
    this.retry(1)
  }

  /** Every failed attempt: the attempt ends, and the retries run. */
  private fail(fault: SocketFault): void {
    const since = this.liveSince
    this.liveSince = undefined
    this.deps.close()
    // A drop keeps its agents for the retry; a retry that fails clears them.
    if (since === undefined) this.deps.clear()
    // Only a program followed for a while is retried from the first wait: one that drops each subscription soon after
    // it starts goes on to the longer waits.
    else if (this.deps.monotonic() - since >= LIVE_MS) this.retries = 0
    if (fault === 'no_socket') return this.wait(undefined)
    const last = this.retries === RETRIES_S.length
    // Only an attempt that listed nothing gives up: a program that lists is running, and keeps the longest wait.
    if (last && since === undefined) return this.wait(this.stamp, fault === 'refused')
    if (!last) this.retries++
    this.retry(RETRIES_S[this.retries - 1])
  }

  private retry(seconds: number): void {
    // One attempt can fail twice (its list, then its close): it keeps one retry.
    this.cancel()
    this.deps.log(`[${this.deps.name}] retry · ${seconds}`)
    this.timer = this.deps.after(seconds * 1000, () => {
      this.timer = undefined
      this.connect()
    })
  }

  /** No socket, or one given up on: nothing listed, no timer, and the watch held. A socket given up on is said stale only
   *  when it refused: a program that answered and never listed said why in its own lines. */
  private wait(stale: string | undefined, refused = false): void {
    this.cancel()
    this.deps.close()
    this.deps.clear()
    this.stale = stale
    if (stale === undefined) this.say('none')
    else if (refused) this.say('stale')
    this.unwatch ??= this.deps.watch(() => this.changed())
    // A socket made since the last look, before the watch started, is told by no change.
    this.changed()
  }

  private cancel(): void {
    this.timer?.()
    this.timer = undefined
  }

  private changed(): void {
    const stamp = this.deps.socketStamp()
    if (!this.unwatch) return
    // The stale socket removed, none is there: each word is said as it changes.
    if (!stamp && this.stale !== undefined) {
      this.stale = undefined
      this.say('none')
    }
    if (!stamp || stamp === this.stale) return
    this.unwatch()
    this.unwatch = undefined
    // Another socket is a program that started again: it has retries of its own.
    this.retries = 0
    this.connect()
  }

  /** Which socket answered, said only when it changes. */
  private say(word: SocketWord): void {
    if (word === this.word) return
    this.word = word
    this.deps.log(`[${this.deps.name}] socket · ${word}`)
  }
}
