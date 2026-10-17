import { describe, expect, it } from 'vitest'
import type { PtyHostDiscovery } from '../ptyHost/client.js'
import { endPtyHosts, PANE_GRACE_MS, type HostClient, type PtyHostsDeps } from './ptyHosts.js'

const discovery = (pid: number, protocol = 2): PtyHostDiscovery => ({ protocol, instance: `p${protocol}`, endpoint: 'e', pid, version: '0.5.0', token: 't' })

function host(panes: string[], options: { refuseFirstShutdown?: boolean; exitsOnShutdown?: boolean; protocol?: number } = {}) {
  const calls: string[] = []
  let alive = true
  let refused = !options.refuseFirstShutdown
  const table = new Set(panes)
  const client: HostClient = {
    protocol: options.protocol ?? 2,
    pid: 100,
    close: () => { calls.push('close') },
    call: (async (op: { op: string; pane?: string }) => {
      calls.push(op.pane ? `${op.op} ${op.pane}` : op.op)
      if (op.op === 'inventory') return { state: 'ok', value: { panes: [...table].map((pane) => ({ pane })) } }
      if (op.op === 'kill') { table.delete(op.pane!); return { state: 'ok', value: {} } }
      if (op.op === 'shutdown') {
        if (!refused) { refused = true; table.add('%9'); return { state: 'failed', dispatch: 'rejected', code: 'bad_request', reason: 'host still has panes (1)' } }
        if (options.exitsOnShutdown !== false) alive = false
        return { state: 'ok', value: {} }
      }
      return { state: 'failed', dispatch: 'rejected', code: 'bad_request', reason: 'no' }
    }) as HostClient['call'],
  }
  return { client, calls, alive: () => alive, kill: () => { alive = false } }
}

function deps(h: ReturnType<typeof host> | null, overrides: Partial<PtyHostsDeps> = {}): { deps: PtyHostsDeps; slept: number[]; ended: string[] } {
  const slept: number[] = []
  const ended: string[] = []
  return {
    slept, ended,
    deps: {
      platform: 'win32',
      discover: () => [discovery(100)],
      reach: async () => (h ? { client: h.client } : { unreachable: 'nothing answers' }),
      alive: (pid) => pid === 100 && (h ? h.alive() : true),
      dead: async () => false,
      rows: async () => [{ pid: 100, parentPid: 1, executable: 'C:\\Users\\u\\.harness\\runtime\\pty\\0.5.0\\harness-pty.exe', startMarker: 'w:1', args: '' }],
      terminate: async (pid, marker) => { ended.push(`${pid} ${marker}`); h?.kill(); return 'ended' },
      signal: (pid) => { ended.push(`SIGTERM ${pid}`); h?.kill() },
      sleep: async (ms) => { slept.push(ms) },
      ...overrides,
    },
  }
}

describe('endPtyHosts', () => {
  it('kills each pane, gives them their grace, then shuts the host down', async () => {
    const h = host(['%1', '%2'])
    const t = deps(h)
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 2, panes: 2, how: 'shut down' }])
    expect(h.calls).toEqual(['inventory', 'kill %1', 'kill %2', 'shutdown', 'close'])
    expect(t.slept).toContain(PANE_GRACE_MS)
    expect(t.ended).toEqual([])
  })

  it('goes round once more when a pane appeared before the shutdown', async () => {
    const h = host(['%1'], { refuseFirstShutdown: true })
    expect(await endPtyHosts(deps(h).deps)).toEqual([{ pid: 100, protocol: 2, panes: 2, how: 'shut down' }])
    expect(h.calls).toEqual(['inventory', 'kill %1', 'shutdown', 'inventory', 'kill %9', 'shutdown', 'close'])
  })

  it('ends a host that cannot be reached by its pid and start marker on Windows, after checking it is the host', async () => {
    const t = deps(null)
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'ended' }])
    expect(t.ended).toEqual(['100 w:1'])
    const other = deps(null, { rows: async () => [{ pid: 100, parentPid: 1, executable: 'C:\\x\\notepad.exe', startMarker: 'w:2', args: '' }] })
    expect(await endPtyHosts(other.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'left', detail: 'nothing answers, and pid 100 is not a harness-pty process' }])
    expect(other.ended).toEqual([])
  })

  it('leaves a host proven dead or gone alone, and signals one on Unix', async () => {
    expect(await endPtyHosts(deps(null, { dead: async () => true }).deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'gone' }])
    expect(await endPtyHosts(deps(null, { alive: () => false }).deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'gone' }])
    let up = true
    const unix = deps(null, { platform: 'darwin', alive: () => up, signal: (pid) => { unix.ended.push(`SIGTERM ${pid}`); up = false } })
    expect(await endPtyHosts(unix.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'ended' }])
    expect(unix.ended).toEqual(['SIGTERM 100'])
  })

  it('ends a protocol 1 host, which has no shutdown, once its panes are gone', async () => {
    const h = host(['%1'], { protocol: 1 })
    const t = deps(h, { discover: () => [discovery(100, 1)] })
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 1, panes: 1, how: 'ended' }])
    expect(h.calls).toEqual(['inventory', 'kill %1', 'close'])
    expect(t.ended).toEqual(['100 w:1'])
  })
})
