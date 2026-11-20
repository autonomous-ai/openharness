import { VoiceLevel } from './voiceLevel.js'

/** A 60 s segment (1.92 MB at 16 kHz) uploads in about 31 s at 0.5 Mbps: an attempt at four times that is stuck. */
export const ATTEMPT_TIMEOUT_MS = 120_000

/** Transcribes one segment; `signal` aborts its upload. */
export type SegmentTranscriber = (pcm: Buffer, signal: AbortSignal) => Promise<string>

/** Injected, so tests reach the timeout with a fake; `AbortSignal.timeout` is not reached by fake timers. */
export interface SegmentTimer { set(fire: () => void, ms: number): unknown; clear(handle: unknown): void }

/** setTimeout (unref'd) and clearTimeout, read at call time. */
export const realTimer: SegmentTimer = {
  // Unref'd: an upload still pending never holds the process open.
  set: (fire, ms) => setTimeout(fire, ms).unref(),
  clear: handle => clearTimeout(handle as NodeJS.Timeout),
}

export interface SegmentCounts { segments: number; early: number; retries: number }

interface Segment { pcm: Buffer; retry: boolean }
interface Attempt { controller: AbortController; timeout: unknown }

/**
 * One recording, transcribed in segments of about 60 s while the person still talks.
 *
 * The dial waits 65 s for the answer after Done, and a 10-minute recording is a 19.2 MB WAV: posted whole at Done it
 * misses that wait below about 3 Mbps uplink. Uploaded a segment at a time as it arrives, at most one segment in
 * flight and the tail are left at Done.
 */
export class VoiceSegments {
  /** Samples in a segment, where the cut window starts, and in a 20 ms frame. */
  private readonly segmentSamples: number
  private readonly windowStart: number
  private readonly frameSamples: number
  private readonly lang: string
  private readonly transcribe: SegmentTranscriber
  private readonly timer: SegmentTimer
  private readonly runningLevel = new VoiceLevel()
  private readonly count: SegmentCounts = { segments: 0, early: 0, retries: 0 }
  /** Audio not yet cut, kept as it came and joined once per cut: 8 KB chunks against a 1.92 MB segment. */
  private pending: Buffer[] = []
  private pendingBytes = 0
  private queue: Segment[] = []
  private attempt?: Attempt
  private readonly texts: string[] = []
  private finishing = false
  private waiting?: { resolve(text: string): void; reject(error: unknown): void }
  /** Set by a failure that is not retried, or by abort(): nothing more is sent. */
  private stopped?: { error: unknown }

  constructor(options: { rate: number; lang: string; transcribe: SegmentTranscriber; timer: SegmentTimer }) {
    // The backend's WAV range; it also bounds the segment count whatever rate the dial states.
    const rate = Math.floor(Math.min(48_000, Math.max(8_000, options.rate)))
    this.segmentSamples = 60 * rate
    this.windowStart = 55 * rate
    this.frameSamples = Math.floor(rate / 50)
    this.lang = options.lang
    this.transcribe = options.transcribe
    this.timer = options.timer
  }

  push(chunk: Buffer): void {
    if (this.stopped || this.finishing) return
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    while (this.pendingBytes >= this.segmentSamples * 2) {
      const pending = Buffer.concat(this.pending, this.pendingBytes)
      const cut = this.cutAt(pending)
      // A copy, so the segment's memory is freed once its upload settles instead of being held by the rest.
      const rest = Buffer.from(pending.subarray(cut))
      this.pending = [rest]
      this.pendingBytes = rest.length
      this.add(pending.subarray(0, cut))
    }
  }

  /** Called once, at Done: the pending audio is the last segment. */
  finish(): Promise<string> {
    this.finishing = true
    return new Promise<string>((resolve, reject) => {
      this.waiting = { resolve, reject }
      if (this.pendingBytes === 0) return this.next()
      const tail = Buffer.concat(this.pending, this.pendingBytes)
      this.pending = []
      this.pendingBytes = 0
      this.add(tail)
    })
  }

  abort(): void {
    if (!this.stopped) this.stop(new DOMException('Voice recording cancelled', 'AbortError'))
  }

  /** Complete once finish() has been called. */
  level(): { peak: number; rms: number } {
    return this.runningLevel.read()
  }

  counts(): SegmentCounts {
    return { ...this.count }
  }

  /**
   * The byte offset of the next cut: the start of the quietest 20 ms frame in [55 s, 60 s), the latest on a tie, so
   * a segment ends in a pause rather than inside a word. A whole number of samples, so no sample is split.
   */
  private cutAt(pcm: Buffer): number {
    const frame = this.frameSamples
    const segmentEnd = this.segmentSamples
    let cut = 0
    let quietest = Infinity
    for (let start = Math.ceil(this.windowStart / frame) * frame; start + frame <= segmentEnd; start += frame) {
      let squares = 0
      for (let i = start; i < start + frame; i++) {
        const s = pcm.readInt16LE(i * 2)
        squares += s * s
      }
      if (squares <= quietest) {
        quietest = squares
        cut = start
      }
    }
    return cut * 2
  }

  private add(pcm: Buffer): void {
    this.runningLevel.add(pcm)
    this.queue.push({ pcm, retry: false })
    this.next()
  }

  /** One upload in flight, in order: segments share one uplink, so a second at once would only slow the first. */
  private next(): void {
    const segment = this.attempt ? undefined : this.queue.shift()
    if (segment) this.start(segment)
    else this.settle()
  }

  private start(segment: Segment): void {
    if (segment.retry) this.count.retries++
    else {
      this.count.segments++
      if (!this.finishing) this.count.early++
    }
    const controller = new AbortController()
    const attempt: Attempt = { controller, timeout: undefined }
    this.attempt = attempt
    attempt.timeout = this.timer.set(() => {
      controller.abort()
      this.failed(attempt, segment, new Error('Voice upload timed out. Try again'))
    }, ATTEMPT_TIMEOUT_MS)
    // The transcriber may ignore the signal (it awaits the access token before fetch): answered() and failed() drop
    // an answer to an attempt that timed out or was aborted, so it is never used. A throw in either (a transcript that
    // is not text: it is the backend's JSON) fails the recording, as it failed the turn when Done posted it whole; left
    // on this promise it would end the devices process, and finish() would never settle.
    this.transcribe(segment.pcm, controller.signal)
      .then(text => this.answered(attempt, text), error => this.failed(attempt, segment, error))
      .catch((error: unknown) => { if (!this.stopped) this.stop(error) })
  }

  private answered(attempt: Attempt, text: string): void {
    if (attempt !== this.attempt) return
    this.end(attempt)
    this.texts.push(text)
    this.next()
  }

  private failed(attempt: Attempt, segment: Segment, error: unknown): void {
    if (attempt !== this.attempt) return
    this.end(attempt)
    // Never after Done, so a recording under a minute makes one request after Done, as before segments.
    if (segment.retry || this.finishing) return this.stop(error)
    segment.retry = true
    this.queue.unshift(segment)
    this.next()
  }

  private end(attempt: Attempt): void {
    this.timer.clear(attempt.timeout)
    this.attempt = undefined
  }

  private stop(error: unknown): void {
    this.stopped = { error }
    this.queue = []
    this.pending = []
    this.pendingBytes = 0
    const attempt = this.attempt
    if (attempt) {
      this.end(attempt)
      attempt.controller.abort()
    }
    this.settle()
  }

  private settle(): void {
    const waiting = this.waiting
    if (!waiting) return
    if (this.stopped) waiting.reject(this.stopped.error)
    else if (this.attempt || this.queue.length > 0) return
    // Japanese is written without spaces between words; the backend's other languages put one between them.
    else waiting.resolve(this.texts.map(text => text.trim()).filter(Boolean).join(this.lang === 'ja' ? '' : ' '))
    this.waiting = undefined
  }
}
