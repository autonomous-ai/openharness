import { describe, expect, it } from 'vitest'
import { deliveriesByMessage } from './pageDeliveries.js'

describe('the messages page\'s deliveries by message', () => {
  it('deliveriesByMessage keeps input order per message', () => {
    const deliveries = [
      { id: 'd1', messageId: 'm2' }, { id: 'd2', messageId: 'm1' }, { id: 'd3', messageId: 'm2' },
      { id: 'd4', messageId: 'm3' }, { id: 'd5', messageId: 'm1' }, { id: 'd6', messageId: 'm2' },
    ]
    const byMessage = deliveriesByMessage(deliveries)
    expect([...byMessage.keys()].sort()).toEqual(['m1', 'm2', 'm3'])
    expect(byMessage.get('m1')!.map(d => d.id)).toEqual(['d2', 'd5'])
    expect(byMessage.get('m2')!.map(d => d.id)).toEqual(['d1', 'd3', 'd6'])
    expect(byMessage.get('m3')!.map(d => d.id)).toEqual(['d4'])
    expect(byMessage.get('m4')).toBeUndefined()
    // The same rows, never copies: a page's later filter and sort work on what pageDeliveries read.
    expect(byMessage.get('m3')![0]).toBe(deliveries[3])
    expect(deliveriesByMessage([]).size).toBe(0)
  })
})
