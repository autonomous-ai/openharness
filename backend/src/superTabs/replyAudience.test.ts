import { describe, expect, it } from 'vitest'
import { REPLY_FANOUT, replyAudience } from './activity.js'

describe('replyAudience: who one thread reply tells (task #2745)', () => {
  it('puts the starter and the quoted author first, then the tagged, then repliers newest first, each once', () => {
    expect(replyAudience({ starter: 'a', quoted: 'b', tagged: ['c', 'a'], repliers: [{ id: 'd', sequence: 3 }, { id: 'e', sequence: 9 }, { id: 'b', sequence: 5 }] }))
      .toEqual(['a', 'b', 'c', 'e', 'd'])
  })

  it('tells at most REPLY_FANOUT people, the starter always among them', () => {
    const repliers = Array.from({ length: REPLY_FANOUT + 20 }, (_, i) => ({ id: `p${i}`, sequence: i }))
    const told = replyAudience({ starter: 'root', quoted: null, tagged: [], repliers })
    expect(told).toHaveLength(REPLY_FANOUT)
    expect(told[0]).toBe('root')
    expect(told[1]).toBe(`p${REPLY_FANOUT + 19}`)
  })

  it('tells nobody when there is no one', () => {
    expect(replyAudience({ starter: null, quoted: null, tagged: [], repliers: [] })).toEqual([])
  })
})
