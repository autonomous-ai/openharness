import { describe, expect, it } from 'vitest'

import { VoiceLevel } from './voiceLevel.js'

const pcm = (...samples: number[]) => {
  const b = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2))
  return b
}

describe('VoiceLevel', () => {
  const level = (...parts: Buffer[]) => {
    const running = new VoiceLevel()
    for (const part of parts) running.add(part)
    return running.read()
  }

  it('is zero for silence and for no audio at all', () => {
    expect(level(pcm(0, 0, 0))).toEqual({ peak: 0, rms: 0 })
    expect(level(Buffer.alloc(0))).toEqual({ peak: 0, rms: 0 })
    expect(level()).toEqual({ peak: 0, rms: 0 })
  })

  it('reads signed little-endian samples, the loudest negative one included', () => {
    expect(level(pcm(3, -4))).toEqual({ peak: 4, rms: 4 })
    expect(level(pcm(-32768, 0))).toEqual({ peak: 32768, rms: 23170 })
  })

  it('ignores a trailing half sample', () => {
    expect(level(Buffer.concat([pcm(100), Buffer.from([0x7f])]))).toEqual({ peak: 100, rms: 100 })
  })

  it('reads several captures as the one they make together', () => {
    // sqrt((9 + 16 + 10000) / 3) = 57.8
    expect(level(pcm(3, -4), pcm(100))).toEqual({ peak: 100, rms: 58 })
    expect(level(pcm(3, -4, 100))).toEqual({ peak: 100, rms: 58 })
  })
})
