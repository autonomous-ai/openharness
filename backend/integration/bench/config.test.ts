import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, parseArgs } from './config.js'

describe('parseArgs', () => {
  it('uses the defaults the brief names: 200 groups, 20 active, 6 machines, 3 Desktop and 2 host readers', () => {
    const { config } = parseArgs([])
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(config).toMatchObject({ groups: 200, doneShare: 0.9, machines: 6, desktopReaders: 3, hostReaders: 2 })
    expect(config.every).toMatchObject({ observeMs: 15_000, desktopPollMs: 3_000, hostTickMs: 1_000, deliveryPassMs: 3_000 })
  })

  it('reads sizes, seconds, the mix and cadences', () => {
    const { config, out, driver } = parseArgs(['--seed', '9', '--groups', '50', '--done-share', '0', '--duration', '30',
      '--mix', 'message.send=1,work.status=0,work.check=3', '--every', 'workerPostMs=500,hostTickMs=2000', '--out', '/tmp/x', '--driver', 'legacy'])
    expect(config).toMatchObject({ seed: 9, groups: 50, doneShare: 0, durationMs: 30_000,
      mix: { 'message.send': 1, 'work.status': 0, 'work.check': 3 } })
    expect(config.every).toEqual({ ...DEFAULT_CONFIG.every, workerPostMs: 500, hostTickMs: 2000 })
    expect(out).toBe('/tmp/x')
    expect(driver).toBe('legacy')
  })

  it('refuses settings it cannot run', () => {
    expect(() => parseArgs(['--done-share', '1'])).toThrow(/at least one active group/)
    expect(() => parseArgs(['--desktop-readers', '9'])).toThrow(/Readers/)
    expect(() => parseArgs(['--mix', 'message.send=0,work.status=0,work.check=0'])).toThrow(/mix/)
    expect(() => parseArgs(['--every', 'nope=1'])).toThrow(/nope/)
    expect(() => parseArgs(['--groups'])).toThrow(/--groups/)
    expect(() => parseArgs(['--colour', 'red'])).toThrow(/--colour/)
  })
})
