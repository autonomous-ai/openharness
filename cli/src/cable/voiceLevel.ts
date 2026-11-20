/**
 * How loud one capture was: the peak and RMS of 16-bit little-endian mono PCM, in sample units (0..32768).
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

  /** 16-bit LE mono; whole samples, but the last call may end in half a sample, which is ignored. */
  add(pcm: Buffer): void {
    const samples = Math.floor(pcm.length / 2)
    for (let i = 0; i < samples; i++) {
      const s = pcm.readInt16LE(i * 2)
      const a = Math.abs(s)
      if (a > this.peak) this.peak = a
      this.squares += s * s
    }
    this.samples += samples
  }

  read(): { peak: number; rms: number } {
    if (this.samples === 0) return { peak: 0, rms: 0 }
    return { peak: this.peak, rms: Math.round(Math.sqrt(this.squares / this.samples)) }
  }
}
