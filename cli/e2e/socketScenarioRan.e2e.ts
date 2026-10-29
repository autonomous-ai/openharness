/**
 * The socket scenario's checks (socketChurn.e2e.ts) gate each WebSocket phase's release, and every one of them
 * also passes when nothing happened: no select of a deleted machine, no quick redial of an offline one. So the
 * scenario first proves it ran (harness/socketScenario.ts `shortfalls`), and these are the ways it can fail to.
 */
import { describe, expect, it } from 'vitest'
import { offlineRetryProblems, shortfalls, type ScenarioResult } from './harness/socketScenario.js'
import type { SocketRecord } from './harness/socketMeter.js'

const A = 'a'.repeat(32), B = 'b'.repeat(32), X = 'c'.repeat(32), Y = 'd'.repeat(32)
const at = 1_000_000

const socket = (client: string, machineId: string, outcome: string): SocketRecord => ({
  endpoint: '/api/web-ws', client, version: null, openedAt: at, closedAt: null, closeCode: null, closeReason: '',
  selects: [{ machineId, at, outcome }], via: null,
})

/** What a run that did everything it should looks like. */
function ran(): ScenarioResult {
  const sockets = [socket('unknown', B, 'accepted'), socket('web', B, 'accepted'), socket('unknown', X, 'NOT_YOUR_MACHINE'),
    socket('unknown', Y, 'MACHINE_OFFLINE'), socket('unknown', Y, 'MACHINE_OFFLINE')]
  return {
    report: { durationMs: 180_000, http: {}, endpoints: { '/api/web-ws': { connects: sockets.length } as any } },
    sockets,
    machines: { a: A, b: B, deleted: X, offline: Y },
    clients: {
      windows: { b: { dials: 1, closes: [] }, deleted: { dials: 3, closes: [1011, 1011, 1011] }, offline: { dials: 3, closes: [1011, 1011, 1011] } },
      web: { dials: 1, sessions: 1 },
    },
    backendLog: '',
  }
}

describe('the socket scenario proves it ran', () => {
  it('finds nothing missing in a run that did everything', () => {
    expect(shortfalls(ran())).toEqual([])
  })

  it('names each thing a run that did nothing is missing', () => {
    const idle = ran()
    idle.sockets = []
    idle.report.endpoints = {}
    idle.clients.windows.deleted.closes = []
    idle.clients.web.sessions = 0
    expect(shortfalls(idle)).toEqual([
      'no web-ws connects',
      'machine B was never accepted through a daemon relay',
      'the browser tab never opened a session',
      'the window to the deleted machine was never refused',
      'the offline machine was selected 0 times, not at least twice',
    ])
  })

  it('does not count the browser tab as the daemon relay reaching B', () => {
    const tabOnly = ran()
    tabOnly.sockets = tabOnly.sockets.filter((s) => !(s.client !== 'web' && s.selects[0].machineId === B))
    expect(shortfalls(tabOnly)).toEqual(['machine B was never accepted through a daemon relay'])
  })
})

describe('the offline check measures each daemon\'s own retries', () => {
  const offlineSelect = (via: string | null, at: number, outcome = 'MACHINE_OFFLINE'): SocketRecord => ({
    ...socket('relay', Y, outcome), via, selects: [{ machineId: Y, at, outcome }],
  })
  const withOffline = (...sockets: SocketRecord[]): ScenarioResult => {
    const result = ran()
    result.sockets = [...result.sockets.filter((s) => s.selects[0].machineId !== Y), ...sockets]
    return result
  }

  it('passes when each daemon waited 30 s between its own refusals, however close the two daemons are', () => {
    expect(offlineRetryProblems(withOffline(offlineSelect('a', at), offlineSelect('b', at + 1),
      offlineSelect('a', at + 30_000), offlineSelect('b', at + 30_001)))).toEqual([])
  })

  // Review of #2104: one select per daemon, a millisecond apart, passed, since an empty list of gaps has no minimum.
  it('fails when a daemon never retried, or never asked', () => {
    expect(offlineRetryProblems(withOffline(offlineSelect('a', at), offlineSelect('b', at + 1)))).toEqual([
      'daemon a was refused the offline machine 1 time(s): no retry to measure',
      'daemon b was refused the offline machine 1 time(s): no retry to measure',
    ])
    expect(offlineRetryProblems(withOffline(offlineSelect('a', at), offlineSelect('a', at + 30_000)))).toEqual([
      'daemon b was refused the offline machine 0 time(s): no retry to measure',
    ])
  })

  it('fails on a quick retry, and on a select no daemon is named for', () => {
    expect(offlineRetryProblems(withOffline(offlineSelect('a', at), offlineSelect('a', at + 15_000),
      offlineSelect('b', at), offlineSelect('b', at + 30_000), offlineSelect(null, at + 40_000)))).toEqual([
      '1 select(s) of the offline machine came through no named daemon',
      'daemon a asked the offline machine again after 15.0 s',
    ])
  })
})
