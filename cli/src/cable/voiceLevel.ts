/** The ES7210 gains the dial firmware records at, in dB: the levels below are held for these only. */
export type MicGain = 37.5 | 30
export const DEFAULT_MIC_GAIN: MicGain = 37.5

/** A 10 ms block is loud when its mean |sample| is over this, at each mic gain: the firmware's voice_buffer.c table,
 *  both pinned by devices/harness-device/firmware/test/vectors/voice_gate.txt. */
const LOUD: Record<MicGain, number> = { 37.5: 600, 30: 250 }

/** The dial's `micGain`, or 37.5 dB for none or one this side has no levels for: firmware from before it was sent, and the Pro. */
export function micGainOf(value: unknown): MicGain {
  return typeof value === 'number' && value in LOUD ? value as MicGain : DEFAULT_MIC_GAIN
}

/**
 * How loud one capture was: the peak and RMS of 16-bit little-endian mono PCM, in sample units (0..32768), the share of
 * its samples at full scale, per mille, and whether it held speech by the dial's own voice gate.
 *
 * Numbers only, so a log can say whether a turn the transcriber answered with nothing was silence, noise or
 * speech without keeping a sample of the audio (OPENHARNES-18: every turn spoken while the dial followed Hachi
 * came back empty, and nothing in the log said what the dial had actually recorded).
 *
 * The clip share is counted because at the ES7210's top gain, 37.5 dB, loud speech saturates the round dial's mic: a
 * peak of 32767 cannot tell one touched sample from a flat-topped clip, and this share, from hosts in the field, shows
 * whether recording at 30 dB worked.
 *
 * The gate follows the dial's mic gain: the same speech recorded at a lower gain is quieter, so its level is lower. It
 * reads the PCM the dial sent, before voiceGain.ts raises it, so the host's raise never makes a press with nothing said
 * heard.
 *
 * Summed piece by piece: a long recording is uploaded in segments while the person talks, so no single buffer holds
 * all of it.
 */
export class VoiceLevel {
  private peak = 0
  private squares = 0
  private samples = 0
  private clipped = 0
  // The gate is the firmware's voice_gate_feed (devices/harness-device/firmware/main/voice_buffer.c), so the daemon and
  // the dial name one recording speech by one rule: a 10 ms block is loud when its mean |sample| is over the level for
  // the dial's mic gain (600 at 37.5 dB), and the
  // recording is heard once 320 ms of loud blocks run unbroken (2026-11-25: an empty transcript mixed a press with
  // nothing said with loud speech the transcriber returned empty). The block under way carries across add() calls, as
  // segments are cut at any sample.
  private readonly block: number
  private readonly needed: number
  private readonly loud: number
  private blockSum = 0
  private blockSamples = 0
  private loudSamples = 0
  private heard = false

  constructor(rate: number, micGain: MicGain) {
    this.block = Math.floor(rate / 100)
    this.needed = Math.floor(rate * 320 / 1000)
    this.loud = LOUD[micGain]
  }

  /** 16-bit LE mono; whole samples, but the last call may end in half a sample, which is ignored. */
  add(pcm: Buffer): void {
    const samples = Math.floor(pcm.length / 2)
    for (let i = 0; i < samples; i++) {
      const s = pcm.readInt16LE(i * 2)
      const a = Math.abs(s)
      if (a > this.peak) this.peak = a
      this.squares += s * s
      if (s >= 32767 || s <= -32768) this.clipped++
      if (!this.heard) this.gate(a)
    }
    this.samples += samples
  }

  /** [clip] is per mille, to two decimals. */
  read(): { peak: number; rms: number; clip: number; heard: boolean } {
    if (this.samples === 0) return { peak: 0, rms: 0, clip: 0, heard: false }
    return {
      peak: this.peak,
      rms: Math.round(Math.sqrt(this.squares / this.samples)),
      clip: Math.round(this.clipped * 100_000 / this.samples) / 100,
      heard: this.heard,
    }
  }

  private gate(a: number): void {
    this.blockSum += a
    if (++this.blockSamples < this.block) return
    // The firmware's integer mean.
    if (Math.floor(this.blockSum / this.block) > this.loud) this.loudSamples += this.block
    else this.loudSamples = 0
    if (this.loudSamples >= this.needed) this.heard = true
    this.blockSum = 0
    this.blockSamples = 0
  }
}
