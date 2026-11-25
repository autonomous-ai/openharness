import { describe, expect, it } from 'vitest'

import { decibels, FrameLevels, gainFor, MAX_GAIN, raised, VOICE_TARGET, voiceOf } from './voiceGain.js'

/** Samples in one 20 ms frame at 16 kHz. */
const FRAME = 320
const RATE = 16_000

/** `seconds` of a 200 Hz tone of `amplitude` (its RMS is amplitude / √2). */
function voice(seconds: number, amplitude: number): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * RATE) * 2)
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 200 * i) / RATE) * amplitude), i * 2)
  return pcm
}

/** `seconds` of a room's hiss, ±`amplitude` in a fixed pattern. */
function room(seconds: number, amplitude: number): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * RATE) * 2)
  let seed = 7
  for (let i = 0; i < pcm.length / 2; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    pcm.writeInt16LE(Math.round(((seed / 2_147_483_648) * 2 - 1) * amplitude), i * 2)
  }
  return pcm
}

/** A touch or a tap on the dial as its mic hears it: 60 ms at full scale. */
const tap = () => voice(0.06, 32_767)

const levelsOf = (...parts: Buffer[]) => {
  const levels = new FrameLevels(FRAME)
  levels.add(Buffer.concat(parts))
  return levels
}

/** The RMS of a stretch of samples. */
function rms(pcm: Buffer, from = 0, to = pcm.length / 2): number {
  let squares = 0
  for (let i = from; i < to; i++) squares += pcm.readInt16LE(i * 2) ** 2
  return Math.sqrt(squares / (to - from))
}

describe('FrameLevels', () => {
  it('reads each whole 20 ms frame to within 1 dB, the leftover samples left out', () => {
    // A second, then half a frame of silence (FRAME bytes are FRAME / 2 samples), which is not counted.
    const levels = levelsOf(voice(1, 1500), Buffer.alloc(FRAME))
    expect(levels.count).toBe(50)
    // An RMS of 1061 is 60.5 dB: the step [60, 61) dB, read at its middle.
    expect(levels.at(0)).toBe(1059)
    expect(levels.at(0.99)).toBe(1059)
    const leftover = new FrameLevels(FRAME)
    leftover.add(Buffer.alloc(FRAME * 2 - 2))
    expect(leftover.count).toBe(0)
    expect(leftover.at(0.9)).toBe(0)
  })

  it('merges two recordings\' counts', () => {
    const quiet = levelsOf(voice(1, 100))
    quiet.merge(levelsOf(voice(1, 30_000)))
    expect(quiet.count).toBe(100)
    expect(quiet.at(0.2)).toBeLessThan(100)
    expect(quiet.at(0.9)).toBeGreaterThan(20_000)
  })

  it('holds a full-scale frame within its last step', () => {
    expect(levelsOf(Buffer.alloc(FRAME * 2, Buffer.from([0x00, 0x80]))).at(0)).toBe(Math.round(10 ** (90.5 / 20)))
  })

  it('takes a recording\'s voice past the frames a touch and a tap take', () => {
    const { voice: level, floor } = voiceOf(levelsOf(tap(), room(0.5, 100), voice(1.5, 707), room(0.5, 100), tap()))
    expect(level).toBeGreaterThan(450)
    expect(level).toBeLessThan(560)
    expect(floor).toBeLessThan(70)
  })
})

describe('gainFor', () => {
  it('raises a quiet voice to the target, past the taps that start and end it', () => {
    const gain = gainFor(levelsOf(tap(), room(0.5, 100), voice(1.5, 707), room(0.5, 100), tap()))
    expect(gain * 500).toBeGreaterThan(VOICE_TARGET * 0.89)
    expect(gain * 500).toBeLessThan(VOICE_TARGET * 1.12)
  })

  it('leaves a voice loud enough as it is', () => {
    expect(gainFor(levelsOf(tap(), room(0.5, 100), voice(1.5, 4000), tap()))).toBe(1)
  })

  it('leaves the room alone: nothing over its floor is no voice, however quiet', () => {
    expect(gainFor(levelsOf(tap(), room(3, 150), tap()))).toBe(1)
    expect(gainFor(levelsOf(Buffer.alloc(3 * RATE * 2)))).toBe(1)
  })

  it('leaves under a second alone: too little to tell a word from a tap', () => {
    expect(gainFor(levelsOf(room(0.4, 20), voice(0.5, 300)))).toBe(1)
  })

  it('raises at most 18 dB', () => {
    expect(gainFor(levelsOf(room(1, 10), voice(2, 60)))).toBe(MAX_GAIN)
    expect(decibels(MAX_GAIN)).toBe(18)
  })

  it('raises a voice over digital silence', () => {
    expect(gainFor(levelsOf(Buffer.alloc(RATE * 2), voice(1, 1000)))).toBeGreaterThan(1)
  })
})

describe('raised', () => {
  it('is the same buffer at a gain of 1', () => {
    const pcm = voice(1, 500)
    expect(raised(pcm, 1)).toBe(pcm)
  })

  it('multiplies every sample, and holds a clipped tap within 16 bits instead of wrapping it', () => {
    const pcm = Buffer.concat([tap(), voice(1, 500)])
    const out = raised(pcm, 4)
    expect(out).not.toBe(pcm)
    expect(rms(out, 960)).toBeCloseTo(rms(pcm, 960) * 4, 0)
    const taps = Array.from({ length: 960 }, (_, i) => out.readInt16LE(i * 2))
    expect(Math.max(...taps)).toBe(32_767)
    expect(Math.min(...taps)).toBe(-32_768)
    // The recording it came from is untouched: a retry or the level reads it as the dial sent it.
    expect(Math.max(...Array.from({ length: 960 }, (_, i) => pcm.readInt16LE(i * 2)))).toBe(32_767)
  })

  it('keeps a trailing half sample as it came', () => {
    const pcm = Buffer.concat([voice(0.01, 500), Buffer.from([0x7f])])
    const out = raised(pcm, 2)
    expect(out).toHaveLength(pcm.length)
    expect(out[out.length - 1]).toBe(0x7f)
  })
})
