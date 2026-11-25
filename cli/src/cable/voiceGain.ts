/**
 * Quiet speech raised before it is transcribed.
 *
 * On a round dial, 132 of 173 voice turns from 2026-11-19 to 11-25 came back empty ("Didn't catch that"), and the dial's
 * own voice gate (firmware voice_gate_feed: 320 ms above a mean of 600) had heard no sustained voice in 56 of the 61 empty
 * ones it logged, against 10 of 15 heard in the turns that worked. The whole recording's peak and RMS could not tell them
 * apart: the touch that starts a recording and the tap that ends it clip at full scale and outweigh the voice. So the
 * voice is read per 20 ms frame, where a tap is a few frames out of many, and a quiet one is raised to a level the
 * transcriber hears. A recording whose voice is loud enough, or that holds nothing above its own noise, goes up as it
 * came, byte for byte.
 */

/** Steps of 1 dB from below one sample unit to full scale (20·log10 32768 ≈ 90.3): a frame's loudness to within 1 dB,
 *  in a fixed array however long the recording. */
const STEPS = 92
/** Voice whose loudest frames are below this (about -24 dBFS) is raised to it. */
export const VOICE_TARGET = 2000
/** At most +18 dB: further would raise the room more than the voice. */
export const MAX_GAIN = 8
/** Under a second there is too little to tell a word from a tap. */
const MIN_FRAMES = 50
/** The loudest frames must stand 6 dB over the quiet ones to be voice and not the room's own noise. */
const OVER_FLOOR = 2

/** The step of a frame's RMS: 0 for digital silence, k for 20·log10(rms) in [k-1, k). */
const step = (rms: number): number => rms < 1 ? 0 : Math.min(STEPS - 1, Math.floor(20 * Math.log10(rms)) + 1)
/** The middle of a step, in sample units. */
const levelOf = (at: number): number => at === 0 ? 0 : Math.round(10 ** ((at - 0.5) / 20))

/** How loud each 20 ms frame of a recording was, counted by step. */
export class FrameLevels {
  private readonly counts = new Uint32Array(STEPS)
  private frames = 0

  constructor(private readonly frameSamples: number) {}

  /** 16-bit LE mono, whole frames only: a cut falls in a pause, so the few samples left over are not voice. */
  add(pcm: Buffer): void {
    const samples = Math.floor(pcm.length / 2)
    for (let start = 0; start + this.frameSamples <= samples; start += this.frameSamples) {
      let squares = 0
      for (let i = start; i < start + this.frameSamples; i++) {
        const s = pcm.readInt16LE(i * 2)
        squares += s * s
      }
      this.counts[step(Math.sqrt(squares / this.frameSamples))]!++
      this.frames++
    }
  }

  merge(other: FrameLevels): void {
    for (let at = 0; at < STEPS; at++) this.counts[at]! += other.counts[at]!
    this.frames += other.frames
  }

  get count(): number {
    return this.frames
  }

  /** The loudness of the frame `share` (0 to under 1) of the way up from the quietest, in sample units; 0 with no
   *  frame. */
  at(share: number): number {
    if (this.frames === 0) return 0
    const rank = Math.floor(share * this.frames)
    let at = 0
    for (let seen = this.counts[0]!; seen <= rank; seen += this.counts[at]!) at++
    return levelOf(at)
  }
}

/** The voice of a recording, its loudest frames past the few a tap takes, and its floor, the room between words. */
export const voiceOf = (levels: FrameLevels): { voice: number; floor: number } =>
  ({ voice: levels.at(0.9), floor: levels.at(0.2) })

/** The gain that brings a recording's voice to VOICE_TARGET: 1 when it is loud enough, too short to judge, or nothing
 *  stands over its floor. */
export function gainFor(levels: FrameLevels): number {
  if (levels.count < MIN_FRAMES) return 1
  const { voice, floor } = voiceOf(levels)
  if (voice >= VOICE_TARGET || voice < Math.max(1, floor) * OVER_FLOOR) return 1
  return Math.min(VOICE_TARGET / voice, MAX_GAIN)
}

/** `pcm` times `gain`, each sample held within 16 bits (a tap that clipped stays clipped); the same buffer at 1. A
 *  trailing half sample is kept as it came. */
export function raised(pcm: Buffer, gain: number): Buffer {
  if (gain === 1) return pcm
  const out = Buffer.from(pcm)
  const samples = Math.floor(pcm.length / 2)
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i * 2) * gain))), i * 2)
  }
  return out
}

/** A gain in whole dB, for the log. */
export const decibels = (gain: number): number => Math.round(20 * Math.log10(gain))
