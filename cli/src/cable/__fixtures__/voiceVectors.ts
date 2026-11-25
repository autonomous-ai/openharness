import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { MicGain } from '../voiceLevel.js'

// Read in place from the firmware's tree, so the dial's voice_buffer.c and this side are held to one file.
const VECTORS = '../../../../devices/harness-device/firmware/test/vectors/'

export interface VoiceVectors {
  gains: Array<{ gain: MicGain; loud: number; steps: number[] }>
  clips: Map<string, { pcm: Buffer; heard: Map<MicGain, boolean> }>
}

let cached: VoiceVectors | undefined

/** The shared voice gate vectors (voice_gate.txt and voice_gate.pcm), read once. */
export function voiceVectors(): VoiceVectors {
  if (cached) return cached
  const text = readFileSync(fileURLToPath(new URL(VECTORS + 'voice_gate.txt', import.meta.url)), 'utf8')
  const pcm = readFileSync(fileURLToPath(new URL(VECTORS + 'voice_gate.pcm', import.meta.url)))
  const gains: VoiceVectors['gains'] = []
  const clips: VoiceVectors['clips'] = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [kind, ...fields] = line.split('\t')
    if (kind === 'rate') {
      if (Number(fields[0]) !== 16_000) throw new Error(`voice_gate.txt: rate ${fields[0]}, not 16000`)
    } else if (kind === 'gain') {
      // The spec checks these are the gains VoiceLevel has levels for.
      gains.push({ gain: Number(fields[0]) as MicGain, loud: Number(fields[1]), steps: fields.slice(2).map(Number) })
    } else if (kind === 'clip') {
      const [name, first, samples, ...heard] = fields
      clips.set(name!, {
        pcm: pcm.subarray(Number(first) * 2, (Number(first) + Number(samples)) * 2),
        heard: new Map(gains.map(({ gain }, i) => [gain, heard[i] === '1'])),
      })
    } else throw new Error(`voice_gate.txt: unknown line ${kind}`)
  }
  cached = { gains, clips }
  return cached
}
