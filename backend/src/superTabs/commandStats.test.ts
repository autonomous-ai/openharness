import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordCommand, startCommandStats } from './commandStats.js'

// Task #3661: Ken's scan put POST commands p95 at 683 ms on v1.4.20 (11-05: 374), and no log said which commands were slow.
describe('commands by type', () => {
  afterEach(() => { vi.useRealTimers() })

  function started(options: Parameters<typeof startCommandStats>[0] = {}) {
    vi.useFakeTimers()
    const log = vi.fn()
    const stop = startCommandStats({ pod: 'pod-1', ...options, log })
    return { log, stop }
  }

  it('logs each minute, per command type, the count, p50, p95 and max, and how many retried their write or were refused', () => {
    const { log, stop } = started()
    for (let ms = 1; ms <= 100; ms++) recordCommand('message.send', ms, { attempts: ms % 10 === 0 ? 2 : 1 })
    recordCommand('work.assign', 900, { attempts: 1 })
    recordCommand('work.assign', 300, { attempts: 1, refused: true })
    vi.advanceTimersByTime(60_000)
    expect(log).toHaveBeenCalledTimes(1)
    const [message, context] = log.mock.calls[0]!
    expect(message).toBe('commands by type')
    // The type that took the most time first.
    expect(context).toEqual({ pod: 'pod-1', windowMs: 60_000, commands: {
      'message.send': { n: 100, p50: 50, p95: 95, max: 100, retried: 10 },
      'work.assign': { n: 2, p50: 300, p95: 900, max: 900, refused: 1 },
    } })
    expect(Object.keys(context.commands)).toEqual(['message.send', 'work.assign'])
    stop()
  })

  it('logs nothing for a quiet minute, and what is left when stopped', () => {
    const { log, stop } = started()
    vi.advanceTimersByTime(60_000)
    expect(log).not.toHaveBeenCalled()
    recordCommand('work.check', 12, { attempts: 1 })
    stop()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![1].commands).toEqual({ 'work.check': { n: 1, p50: 12, p95: 12, max: 12 } })
  })

  it('keeps a bounded sample per type, lists at most `top` types, and names only known shapes of type', () => {
    const { log, stop } = started({ maxSamples: 10, top: 2, random: () => 0.99 })
    for (let i = 0; i < 1000; i++) recordCommand('message.send', 5, { attempts: 1 })
    recordCommand('agent.alert', 1, { attempts: 1 })
    recordCommand('work.status', 2, { attempts: 1 })
    recordCommand('<script>', 3, { attempts: 1 })
    stop()
    const { commands } = log.mock.calls[0]![1]
    expect(commands['message.send']).toEqual({ n: 1000, p50: 5, p95: 5, max: 5 })
    expect(Object.keys(commands)).toHaveLength(2)
    expect(JSON.stringify(log.mock.calls)).not.toContain('<script>')
  })

  it('records nothing while not started', () => {
    recordCommand('message.send', 5, { attempts: 1 })
    const { log, stop } = started()
    stop()
    expect(log).not.toHaveBeenCalled()
  })
})
