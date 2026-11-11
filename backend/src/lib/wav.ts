// What a PCM WAV file says about itself: the voice route and the chat's voice messages charge and draw a clip by it.

const WAV_HEADER_BYTES = 44
const WAVE_FORMAT_PCM = 1

/**
 * The clip's length in milliseconds, as Deepgram will hear it, or null when it cannot be told from the bytes.
 *
 * Only uncompressed PCM WAV is accepted, which is all the phone (mobile/lib/phone/voice_wav.dart) and the dial
 * (cli/src/cable/cableHost.ts wav()) ever send: its length is the bytes after the header at the rate the header
 * states. Compressed audio (MP3, Opus, or a compressed codec inside a WAV) is many times longer than its bytes
 * suggest, so charging it by size would let one account transcribe hours a day on a 10-minute plan. The header
 * is the caller's to write, so a rate, channel count or sample size outside what a microphone records (which
 * would make a long clip read as no time at all) is refused too.
 */
export function wavDurationMs(audio: Buffer): number | null {
  if (audio.length < WAV_HEADER_BYTES) return null
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.toString('ascii', 12, 16) !== 'fmt ') return null
  if (audio.readUInt16LE(20) !== WAVE_FORMAT_PCM) return null
  const channels = audio.readUInt16LE(22)
  const sampleRate = audio.readUInt32LE(24)
  const bits = audio.readUInt16LE(34)
  if (channels < 1 || channels > 2 || sampleRate < 8_000 || sampleRate > 48_000 || ![8, 16, 24, 32].includes(bits)) return null
  const bytesPerSecond = sampleRate * channels * (bits / 8)
  return Math.ceil(((audio.length - WAV_HEADER_BYTES) / bytesPerSecond) * 1000)
}
