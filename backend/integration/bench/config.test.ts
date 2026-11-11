import { describe, expect, it } from 'vitest'
import { conversationCount, DEFAULT_CONFIG, parseArgs } from './config.js'

describe('parseArgs', () => {
  it('runs a busy Swarm by default: 60 agents, 50 projects, 6 machines, 3 Desktop and 2 host readers', () => {
    const { config } = parseArgs([])
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(config).toMatchObject({ agents: 60, projects: 50, machines: 6, lane: 'mixed', desktopReaders: 3, hostReaders: 2 })
    expect(conversationCount(config)).toBe(110)
    expect(config.every).toMatchObject({ observeMs: 15_000, desktopPollMs: 3_000, hostTickMs: 1_000, deliveryPassMs: 3_000 })
  })

  it('reads sizes, seconds and cadences', () => {
    const { config, out } = parseArgs(['--seed', '9', '--agents', '150', '--projects', '50', '--machines', '10', '--lane', 'cross-chat', '--duration', '30',
      '--every', 'channelPostMs=500,hostTickMs=2000', '--out', '/tmp/x'])
    expect(config).toMatchObject({ seed: 9, agents: 150, projects: 50, machines: 10, lane: 'cross-chat', durationMs: 30_000 })
    expect(conversationCount(config)).toBe(200)
    expect(config.every).toEqual({ ...DEFAULT_CONFIG.every, channelPostMs: 500, hostTickMs: 2000 })
    expect(out).toBe('/tmp/x')
  })

  it('refuses settings it cannot run', () => {
    expect(() => parseArgs(['--projects', '0'])).toThrow(/projects/)
    expect(() => parseArgs(['--projects', '101', '--agents', '200'])).toThrow(/100 projects/)
    expect(() => parseArgs(['--agents', '10', '--projects', '20'])).toThrow(/PM/)
    expect(() => parseArgs(['--desktop-readers', '9'])).toThrow(/Readers/)
    expect(() => parseArgs(['--every', 'nope=1'])).toThrow(/nope/)
    expect(() => parseArgs(['--agents'])).toThrow(/--agents/)
    expect(() => parseArgs(['--lane', 'cross-group'])).toThrow(/--lane/)
    expect(() => parseArgs(['--groups', '200'])).toThrow(/--groups/)
  })
})

describe('the read cache the bench runs with', () => {
  it('keeps stamps in this process by default, or in a Redis it is given, or runs without a cache', () => {
    expect(parseArgs([]).cache).toBe('memory')
    expect(parseArgs(['--cache', 'off']).cache).toBe('off')
    expect(parseArgs(['--cache', 'redis://127.0.0.1:6379/15']).cache).toBe('redis://127.0.0.1:6379/15')
    expect(() => parseArgs(['--cache', 'disk'])).toThrow(/--cache/)
  })
})
