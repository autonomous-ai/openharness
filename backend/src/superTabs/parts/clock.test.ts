import { describe, expect, it } from 'vitest'
import { createClock } from './clock.js'

describe('part write clock', () => {
  it('never stamps the same or an earlier time twice, even when the wall clock stands still or goes back', () => {
    const wall = [1000, 1000, 999, 1000]
    const clock = createClock(() => wall.shift()!)
    expect([clock.next(), clock.next(), clock.next(), clock.next()]).toEqual([1000, 1001, 1002, 1003])
  })

  it('follows the wall clock once it is ahead again', () => {
    const wall = [1000, 1000, 5000]
    const clock = createClock(() => wall.shift()!)
    expect([clock.next(), clock.next(), clock.next()]).toEqual([1000, 1001, 5000])
  })
})
