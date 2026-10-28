/**
 * The WebSocket roadmap's Done criteria for Phase 0 and Phase 1 (Ken, 2026-10-28), judged on one
 * account's sockets for a few minutes (harness/socketScenario.ts): two daemons, a deleted machine X and
 * an offline machine Y pinned on one of them, a Desktop's windows and a browser tab, all on a local
 * backend and measured by a recording proxy in front of it.
 *
 * The roadmap's population numbers (under 40 web-ws connects a minute, a median lifetime over a minute)
 * are prod's, over every account. One account cannot reach them or miss them: on the main of 2026-10-28
 * this scenario made 12.5 connects a minute, already under 40, while the window to the offline machine
 * alone kept the median at a few milliseconds. So each churn cause the scenario holds is checked on its
 * own, and the two numbers are printed with the report for the prod measurement after release.
 *
 * Every check here also passes when nothing happened, so a run that did not do what the scenario says (A's relay
 * never reached B, the tab never opened a session, X was never refused, Y was selected under twice) fails every
 * check with what it missed (socketScenarioRan.e2e.ts).
 *
 * Red on the main of 2026-10-28; each check turns green as the phase that owns it lands, and a phase ships
 * only once its checks pass. Opt in with HARNESS_E2E_SERVICES_DIR, as the other real-backend suites do;
 * scripts/socket-churn.sh runs it and keeps the report.
 *
 * SOCKET_SCENARIO_MINUTES sets the run (default 3). SOCKET_REPORT_FILE keeps the report as JSON.
 */
import { writeFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { runSocketScenario, shortfalls, type ScenarioResult } from './harness/socketScenario.js'

const minutes = Number(process.env.SOCKET_SCENARIO_MINUTES ?? 3)
let result: ScenarioResult

/** When each web-ws select of `machineId` was sent, in order. */
const selectTimes = (machineId: string): number[] => result.sockets
  .filter((s) => s.endpoint === '/api/web-ws')
  .flatMap((s) => s.selects.filter((select) => select.machineId === machineId).map((select) => select.at))
  .sort((a, b) => a - b)

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('WebSocket phases 0 and 1: one account\'s sockets', () => {
  beforeAll(async () => {
    const lines: string[] = []
    result = await runSocketScenario({ durationMs: minutes * 60_000, log: (line) => lines.push(line) })
    console.log(`socket scenario: ${lines.join(' | ')}\n${JSON.stringify(result.report, null, 2)}`)
    if (process.env.SOCKET_REPORT_FILE) writeFileSync(process.env.SOCKET_REPORT_FILE, JSON.stringify(result, null, 2))
    const missing = shortfalls(result)
    if (missing.length) throw new Error(`The scenario did not run as it says, so no check here means anything: ${missing.join('; ')}`)
  }, minutes * 60_000 + 240_000)

  const webWs = () => result.report.endpoints['/api/web-ws']

  it('Phase 0: at least 95% of web-ws connects name their client kind and version', () => {
    expect(webWs().attributed).toBeGreaterThanOrEqual(0.95)
  })

  it('Phase 0: so does each kind of client, so many relays cannot hide one kind that never does', () => {
    const below = Object.entries(webWs().attributedByClient).filter(([, share]) => share < 0.95)
    expect(below).toEqual([])
  })

  it('Phase 1: a deleted machine is selected once, by the socket that finds it gone, and never again', () => {
    expect(selectTimes(result.machines.deleted).length).toBeLessThanOrEqual(1)
  })

  it('Phase 1: an offline machine is selected again only after the backend\'s retryAfterMs (30 s)', () => {
    const times = selectTimes(result.machines.offline)
    const gaps = times.slice(1).map((at, i) => at - times[i])
    // A second of slack for the timers on both sides.
    expect(Math.min(...gaps, Infinity)).toBeGreaterThanOrEqual(29_000)
  })

  it('Phase 1: no socket that selected a machine is dropped within a minute', () => {
    expect(webWs().acceptedThenDiedUnder1m).toBe(0)
  })
})
