// A chat voice message: a WAV the phone recorded, sent as a file, whose words the server transcribes once before it is sent
// (store.ts readVoice). People hear it; agents and previews read what this file says about it.

/** The longest clip read as a voice message. The phone stops a take at 10:00; the margin covers the recorder's tail. */
export const MAX_VOICE_MS = 605_000

/** Bars in a voice message's waveform, as both apps draw it. */
export const VOICE_BARS = 48
/** A bar's height runs 0..VOICE_BAR_MAX. */
const VOICE_BAR_MAX = 31
const WAV_HEADER_BYTES = 44

/** `M:SS`, rounded down to the second: what a voice bubble shows and its label carries. */
export function voiceLength(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** What previews, activity and tags say for a voice message. */
export const voiceLabel = (durationMs: number) => `Voice message (${voiceLength(durationMs)})`

/**
 * How loud each of [bars] equal slices of a 16-bit PCM WAV is, 0..31: its RMS on the decibel scale the phone's live wave
 * uses (mobile/lib/phone/voice_wav.dart pcm16Level), so a sent message looks like the take did while it was recorded.
 * Worked out here from the bytes rather than taken from the sender, so every viewer draws the same file the same way.
 */
export function voiceWaveform(wav: Buffer, bars = VOICE_BARS): number[] {
  const samples = Math.max(0, Math.floor((wav.length - WAV_HEADER_BYTES) / 2))
  return Array.from({ length: bars }, (_, bar) => {
    const from = Math.floor((bar * samples) / bars), to = Math.max(from + 1, Math.floor(((bar + 1) * samples) / bars))
    let sum = 0, count = 0
    for (let i = from; i < Math.min(to, samples); i++, count++) sum += wav.readInt16LE(WAV_HEADER_BYTES + i * 2) ** 2
    const rms = count ? Math.sqrt(sum / count) : 0
    if (rms < 1) return 0
    const level = (20 * Math.log10(rms / 32768) - QUIET_DB) / (LOUD_DB - QUIET_DB)
    return Math.round(Math.min(1, Math.max(0, level)) * VOICE_BAR_MAX)
  })
}

const QUIET_DB = -55
const LOUD_DB = -10
