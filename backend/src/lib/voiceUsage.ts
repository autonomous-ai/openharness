/**
 * What one transcribed clip at /api/voice/stt adds to the day's totals: what voice costs, per account-day, with the
 * dial's clips apart from the rest (docs/plans/2026-11-23-dial-usage-counts-design.md, "What does voice cost?").
 * Counted here, where every second is transcribed, never taken from a client's report.
 */
import { DIAL_VOICE_SURFACE } from '../types/dialUsage.js'

export const VOICE_USAGE_METRICS = ['voice_dial_clips', 'voice_dial_audio_ms', 'voice_dial_transcribe_ms',
  'voice_rest_clips', 'voice_rest_audio_ms', 'voice_rest_transcribe_ms', 'voice_account_days',
  'voice_account_days_over_1m', 'voice_account_days_over_5m', 'voice_account_days_over_20m'] as const
export type VoiceUsageMetric = typeof VOICE_USAGE_METRICS[number]
/** `rest`: the phone, an older CLI, anything without the dial's header. */
export type VoiceSurface = 'dial' | 'rest'

/** The dial's clips only on the exact value the devices' upload sends; an absent, repeated or other value is the rest.
 * The caller shapes the header, so its value is compared and never kept or logged. */
export function voiceSurface(header: string | string[] | undefined): VoiceSurface {
  return header === DIAL_VOICE_SURFACE ? 'dial' : 'rest'
}

const ACCOUNT_DAY_EDGES: Array<[VoiceUsageMetric, number]> = [
  ['voice_account_days_over_1m', 60_000], ['voice_account_days_over_5m', 300_000], ['voice_account_days_over_20m', 1_200_000],
]

/**
 * The clip's totals: one clip, its audio and its transcription time under its surface, then the account-day buckets.
 * Those are over the account's whole voice, dial and rest together, read off the account's shared daily quota bucket
 * ([beforeMs], lib/voiceQuota.ts): a dial-only bucket would need a new per-account record, which the design rules out.
 * The review reads them as differences (under 1 min = account_days - over_1m, ...).
 *
 * A clip given back (Deepgram failed) lowers the bucket again, so a later clip can count the day or cross an edge a
 * second time, and two clips in flight at once can miss one. Rare, and it only moves a bucket.
 */
export function voiceIncrements(surface: VoiceSurface, beforeMs: number, clipMs: number,
  transcribeMs: number): Array<[VoiceUsageMetric, number]> {
  // Rounded up as the quota charges it, so this clip ends where the next one's [beforeMs] starts.
  const audioMs = Math.max(0, Math.ceil(clipMs))
  const increments: Array<[VoiceUsageMetric, number]> = [[`voice_${surface}_clips`, 1], [`voice_${surface}_audio_ms`, audioMs],
    [`voice_${surface}_transcribe_ms`, Math.max(0, Math.round(transcribeMs))]]
  if (beforeMs === 0) increments.push(['voice_account_days', 1])
  for (const [metric, edge] of ACCOUNT_DAY_EDGES) if (beforeMs < edge && edge <= beforeMs + audioMs) increments.push([metric, 1])
  return increments
}
