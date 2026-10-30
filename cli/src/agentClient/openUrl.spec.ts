import { describe, expect, it, vi } from 'vitest'
import type { Daemon, Where } from './daemon.js'
import { openUrlCommand } from './openUrl.js'

/** The BROWSER script's question: 0 only when the daemon owning the pane says a phone took the page. */
const HERE: Where = { port: 18473, dataDir: '/data', machineId: 'm', harnessPane: true }

function daemon(answer: Record<string, unknown> | Error) {
  const close = vi.fn()
  const request = vi.fn(async () => { if (answer instanceof Error) throw answer; return answer })
  return { daemon: { machineId: 'm', request, close } as Daemon, request, close }
}

describe('harness open-url', () => {
  it('uses HARNESS_PANE when a Windows host has no TMUX_PANE', async () => {
    const { daemon: line, request } = daemon({ handled: true })
    expect(await openUrlCommand(['https://x.test/a'], {
      env: { HARNESS_PANE: 'p1:%3' }, where: () => HERE, open: async () => line,
    })).toBe(0)
    expect(request).toHaveBeenCalledWith('browser_open', { pane: 'p1:%3', url: 'https://x.test/a' }, 5_000)
  })

  it('asks the pane\'s daemon, and is done when a phone took the page', async () => {
    const { daemon: line, request, close } = daemon({ handled: true })
    expect(await openUrlCommand(['https://x.test/a'], { pane: '%7', where: () => HERE, open: async () => line })).toBe(0)
    expect(request).toHaveBeenCalledWith('browser_open', { pane: '%7', url: 'https://x.test/a' }, 5_000)
    expect(close).toHaveBeenCalled()
  })

  it('leaves the page to this computer otherwise', async () => {
    const open = vi.fn(async () => daemon({ handled: false }).daemon)
    expect(await openUrlCommand(['https://x.test/a'], { pane: '%7', where: () => HERE, open })).toBe(1)
    expect(await openUrlCommand(['https://x.test/a'], { pane: '%7', where: () => HERE, open: async () => daemon(new Error('TIMEOUT')).daemon })).toBe(1)
    expect(await openUrlCommand(['https://x.test/a'], { pane: '%7', where: () => HERE, open: async () => { throw new Error('DAEMON_UNREACHABLE') } })).toBe(1)
    expect(await openUrlCommand(['https://x.test/a'], { pane: '%7', where: () => ({ ...HERE, harnessPane: false }), open })).toBe(1)
    expect(await openUrlCommand(['https://x.test/a'], { pane: undefined, open })).toBe(1)
    expect(await openUrlCommand([], { pane: '%7', open })).toBe(1)
    expect(open).toHaveBeenCalledTimes(1)
  })
})
