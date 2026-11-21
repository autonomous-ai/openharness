/**
 * Tier B of the dial eval for the Claude app (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier B"): each main
 * scenario of the catalog that runs in tier B, on the real daemon and devices process, through the tier B driver
 * (harness/appEvalDriver.ts).
 *
 * macOS and Linux. Every daemon has a throwaway home, its open, its home and the apps' stores checked inside its root
 * before it starts, the harness's recording `open` (HARNESS_OPEN_BIN) and the fake backend only. The real Claude app,
 * its store, `~/.claude`, `~/.codex` and this computer's daemon are never touched. The network guard runs in this process
 * and in every process of each daemon: a connection to anything but this machine fails the scenario, by host and port.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listed, scenariosFor } from '../src/testing/dialAppEval/catalog.js'
import { loadBaseline, SKIP_RATCHET_ENV, tierBVerdict } from '../src/testing/dialAppEval/grade.js'
import { readNetGuard } from '../src/testing/dialAppEval/netGuard.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from '../src/testing/dialAppEval/runner.js'
import type { Platform } from '../src/testing/dialAppEval/types.js'
import { claudeSteps } from './harness/appEvalClaude.js'
import { TierBDriver } from './harness/appEvalDriver.js'

const WIN32 = process.platform === 'win32'
const HOST = process.platform as Platform
const SCENARIOS = WIN32 ? [] : scenariosFor('b', HOST).filter((s) => s.app === 'claude' && !s.heldOut)

describe.skipIf(WIN32)('the dial eval, tier B: the Claude app', () => {
  let driver: TierBDriver
  const runs: ScenarioRun[] = []
  beforeAll(() => { driver = new TierBDriver({ claude: claudeSteps }) })
  afterAll(async () => {
    if (process.env.DIAL_EVAL_OUT) writeResults(process.env.DIAL_EVAL_OUT, 'claude', collect(runs))
    // It throws naming each attempt off this machine not asserted on yet, the last daemon's as it closed among them.
    await driver?.close()
  })

  it('the network guard is in the core and the devices process, and a connection from the devices process to 192.0.2.1 fails the run naming it', async () => {
    const c1 = SCENARIOS.find((s) => s.id === 'C1')!
    await driver.start(c1, HOST)
    try {
      const file = driver.netGuardFile()
      const { loaded } = readNetGuard(file)
      expect(loaded.map((l) => l.process)).toEqual(expect.arrayContaining(['core', 'devices']))
      const devices = loaded.find((l) => l.process === 'devices')!
      appendFileSync(file, `${JSON.stringify({ kind: 'attempt', api: 'net', host: '192.0.2.1', port: 9, pid: devices.pid, process: 'devices' })}\n`)
    } finally {
      await driver.stop()
    }
    expect(driver.networkReached()).toEqual(['devices net 192.0.2.1:9'])
    // Given once.
    expect(driver.networkReached()).toEqual([])
  })

  it('a start fails whose core or devices process the guard is not in, whatever an older line of its file says', async () => {
    const c1 = SCENARIOS.find((s) => s.id === 'C1')!
    await driver.start(c1, HOST)
    await driver.stop()
    // The file as it would be had both processes started again without the guard: only others' lines.
    writeFileSync(driver.netGuardFile(), ['core', 'devices'].map((process) => `${JSON.stringify({ kind: 'loaded', pid: 1, process })}\n`).join(''))
    try {
      await expect(driver.start(c1, HOST)).rejects.toThrow('the network guard is not in the core process')
    } finally {
      await driver.stop()
    }
  })

  it("an attempt off this machine made as the last daemon closes fails the driver's close, naming it", async () => {
    await driver.start(SCENARIOS.find((s) => s.id === 'C1')!, HOST)
    await driver.stop()
    const file = driver.netGuardFile()
    const devices = readNetGuard(file).loaded.find((l) => l.process === 'devices')!
    appendFileSync(file, `${JSON.stringify({ kind: 'attempt', api: 'net', host: '192.0.2.1', port: 9, pid: devices.pid, process: 'devices' })}\n`)
    await expect(driver.close()).rejects.toThrow('devices net 192.0.2.1:9')
    // The file's other tests on a driver of their own: the closed one has taken its guard off this process.
    driver = new TierBDriver({ claude: claudeSteps })
  })

  it('a scenario refused at its start is a run that says why, with nothing seen', async () => {
    const run = await runScenario(driver, { ...SCENARIOS.find((s) => s.id === 'C1')!, world: { chatgptInstalled: false } }, HOST)
    expect(run.error).toContain('no ChatGPT app')
    expect(driver.seen().frames).toEqual([])
  })

  it('the fake Claude app attaches the session it resumes from its link, as the mod does for the session the app shows', async () => {
    // C8's resting, resumable session, tapped.
    const c8 = SCENARIOS.find((s) => s.id === 'C8')!
    const steps = [{ kind: 'claude.write' as const, sessions: ['a'] }, ...listed('claude', ['a']), { kind: 'tap' as const, session: 'a' }]
    await runScenario(driver, { ...c8, steps, fresh: true }, HOST)
    // Its own daemon, so its log is this scenario's alone.
    expect(driver.lastWorld().d.log().split('\n').filter((line) => line.includes('[device] attach ·'))).not.toEqual([])
  })

  it('the dial unplugged shows nothing, and its glass starts afresh when plugged in again', async () => {
    await runScenario(driver, SCENARIOS.find((s) => s.id === 'C11')!, HOST)
    const { steps, faces } = driver.seen()
    const replug = steps.find((s) => s.kind === 'replug')!.at
    expect(faces.filter((f) => f.at < replug).at(-1)).toEqual({ at: expect.any(Number), page: '', tiles: [], active: null })
  })

  it.for(SCENARIOS)('$id: $title', async (scenario) => {
    const began = Date.now()
    const run = await runScenario(driver, scenario, HOST)
    // Kept before any assertion, so a scenario that fails one is still in the results and the baseline's verdict.
    runs.push(run)
    expect(run.error).toBeUndefined()
    console.log(`[dial eval] ${scenario.id}: ${Date.now() - began} ms`)
    expect(driver.networkReached()).toEqual([])
    expect(run.wrongSends).toEqual([])
    expect(uncaughtProbes(run)).toEqual([])
  })

  // The eval command judges the ratchet itself, over every file's results (run.ts).
  it.skipIf(process.env[SKIP_RATCHET_ENV] === '1')("matches this platform's baseline", () => {
    const baseline = loadBaseline()
    expect(baseline).not.toBeNull()
    const verdict = tierBVerdict(collect(runs), baseline!, HOST)
    expect(verdict.ok, verdict.message).toBe(true)
  })
})
