import { afterEach, describe, expect, it, vi } from 'vitest'
import { Logger } from './logger.js'

/**
 * In the cluster these lines are read by Datadog, which parses a JSON line into attributes you can
 * filter and group by. The old format — `[ts] [INFO] message {json}` — arrived as one string, so
 * `userId` and the rest were text nobody could query. `message` and `status` are the names Datadog
 * reads; everything else becomes `@<key>`.
 */
function captured(write: () => void): string[] {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)) })
  try { write() } finally { spy.mockRestore() }
  return lines
}

describe('logger, in the cluster', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const json = () => new Logger(true)

  it('writes one line of JSON', () => {
    const lines = captured(() => json().info('web user disconnected'))
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0])).not.toThrow()
  })

  it('names the message and the level the way Datadog reads them', () => {
    const [line] = captured(() => json().info('web user disconnected'))
    const entry = JSON.parse(line)
    expect(entry.message).toBe('web user disconnected')
    expect(entry.status).toBe('info')
    expect(Date.parse(entry.timestamp)).not.toBeNaN()
  })

  it('puts context alongside, so a field can be filtered on', () => {
    const [line] = captured(() => json().info('web user disconnected', { userId: 'u1', machineId: 'm1' }))
    // Siblings, not nested under `context`: Datadog reads these as @userId and @machineId.
    expect(JSON.parse(line)).toMatchObject({ userId: 'u1', machineId: 'm1' })
  })

  it('does not let a context field take over the message or the level', () => {
    const [line] = captured(() => json().info('the real message', { message: 'not this', status: 'error' }))
    const entry = JSON.parse(line)
    expect(entry.message).toBe('the real message')
    expect(entry.status).toBe('info')
  })

  it('says warn and error as their own levels', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    json().warn('careful')
    json().error('broke', new Error('the cause'))
    expect(JSON.parse(String(warn.mock.calls[0][0])).status).toBe('warn')
    const entry = JSON.parse(String(error.mock.calls[0][0]))
    expect(entry.status).toBe('error')
    expect(entry.message).toBe('broke')
    expect(entry.error).toBe('the cause')
  })
})

describe('logger, on a terminal', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('keeps the readable line, so `npm run dev` is not a wall of JSON', () => {
    const [line] = captured(() => new Logger(false).info('web user disconnected', { userId: 'u1' }))
    expect(line).toMatch(/^\[[^\]]+\] \[INFO\] web user disconnected \{"userId":"u1"\}$/)
  })
})
