import { describe, expect, it } from 'vitest'

import { voiceLevel } from './voiceLevel.js'

const pcm = (...samples: number[]) => {
  const b = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2))
  return b
}

describe('voiceLevel', () => {
  it('is zero for silence and for no audio at all', () => {
    expect(voiceLevel(pcm(0, 0, 0))).toEqual({ peak: 0, rms: 0 })
    expect(voiceLevel(Buffer.alloc(0))).toEqual({ peak: 0, rms: 0 })
  })

  it('reads signed little-endian samples, the loudest negative one included', () => {
    expect(voiceLevel(pcm(3, -4))).toEqual({ peak: 4, rms: 4 })
    expect(voiceLevel(pcm(-32768, 0))).toEqual({ peak: 32768, rms: 23170 })
  })

  it('ignores a trailing half sample', () => {
    expect(voiceLevel(Buffer.concat([pcm(100), Buffer.from([0x7f])]))).toEqual({ peak: 100, rms: 100 })
  })
})
