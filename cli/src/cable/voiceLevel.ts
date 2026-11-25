/**
 * How loud one capture was: the peak and RMS of 16-bit little-endian mono PCM, in sample units (0..32768), and whether
 * it held speech by the dial's own voice gate.
 *
 * Numbers only, so a log can say whether a turn the transcriber answered with nothing was silence, noise or
 * speech without keeping a sample of the audio (OPENHARNES-18: every turn spoken while the dial followed Hachi
 * came back empty, and nothing in the log said what the dial had actually recorded).
 *
 * Summed piece by piece: a long recording is uploaded in segments while the person talks, so no single buffer holds
 * all of it.
 */
export class VoiceLevel {
  private peak = 0
  private squares = 0
  private samples = 0
  // The gate is the firmware's voice_gate_feed (devices/harness-device/firmware/main/voice_buffer.c), so the daemon and
  // the dial name one recording speech by one rule: a 10 ms block is loud when its mean |sample| is over 600, and the
  // recording is heard once 320 ms of loud blocks run unbroken (2026-11-25: an empty transcript mixed a press with
  // nothing said with loud speech the transcriber returned empty). The block under way carries across add() calls, as
  // segments are cut at any sample.
  private readonly block: number
  private readonly needed: number
  private blockSum = 0
  private blockSamples = 0
  private loudSamples = 0
  private heard = false

  constructor(rate: number) {
    this.block = Math.floor(rate / 100)
    this.needed = Math.floor(rate * 320 / 1000)
  }

  /** 16-bit LE mono; whole samples, but the last call may end in half a sample, which is ignored. */
  add(pcm: Buffer): void {
    const samples = Math.floor(pcm.length / 2)
    for (let i = 0; i < samples; i++) {
      const s = pcm.readInt16LE(i * 2)
      const a = Math.abs(s)
      if (a > this.peak) this.peak = a
      this.squares += s * s
      if (!this.heard) this.gate(a)
    }
    this.samples += samples
  }

  read(): { peak: number; rms: number; heard: boolean } {
    if (this.samples === 0) return { peak: 0, rms: 0, heard: false }
    return { peak: this.peak, rms: Math.round(Math.sqrt(this.squares / this.samples)), heard: this.heard }
  }

  private gate(a: number): void {
    this.blockSum += a
    if (++this.blockSamples < this.block) return
    // The firmware's integer mean.
    if (Math.floor(this.blockSum / this.block) > 600) this.loudSamples += this.block
    else this.loudSamples = 0
    if (this.loudSamples >= this.needed) this.heard = true
    this.blockSum = 0
    this.blockSamples = 0
  }
}
