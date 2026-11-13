/**
 * How loud one capture was: the peak and RMS of 16-bit little-endian mono PCM, in sample units (0..32768).
 *
 * Numbers only, so a log can say whether a turn the transcriber answered with nothing was silence, noise or
 * speech without keeping a sample of the audio (OPENHARNES-18: every turn spoken while the dial followed Hachi
 * came back empty, and nothing in the log said what the dial had actually recorded).
 */
export function voiceLevel(pcm: Buffer): { peak: number; rms: number } {
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0) return { peak: 0, rms: 0 }
  let peak = 0
  let squares = 0
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2)
    const a = Math.abs(s)
    if (a > peak) peak = a
    squares += s * s
  }
  return { peak, rms: Math.round(Math.sqrt(squares / samples)) }
}
