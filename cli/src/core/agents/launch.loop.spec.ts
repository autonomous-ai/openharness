/**
 * A Codex resume prepares its history in a real subprocess while core retains only bounded identity evidence and
 * publication. Read in line, a 200 MB rollout with an item to repair held the core loop 2.4 s on a Mac.
 *
 * What is measured is the CPU time of the loop's own thread between two turns of a 1 ms timer: the longest the loop
 * did one thing without letting the timer in. A busy machine that keeps the process off the CPU for a while does not
 * read as a held loop.
 *
 * The bound is 100 ms, not 50: on Linux the publishing rename drops the last link of the cached 200 MB original, and
 * the kernel frees its pages on the loop's thread, 23-51 ms here (a known core follow-up). An inline read holds seconds.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { codexSessionMeta } from '../../testing/codexRollout.js'
import { createLaunchHelpers } from './launch.js'
import { createResumeRepairs } from '../engines/resumeRepairs.js'
import { startResumeRepairWorker } from '../../testing/resumeRepairProcess.js'

const SESSION = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36d'

/** The CPU time, in ms, of the thread this runs on: the loop's. */
function threadCpuMs(): number {
  const used = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage?.() ?? process.cpuUsage()
  return (used.user + used.system) / 1000
}

/** The longest stretch of the loop's own work between two turns of a 1 ms timer, from now until `stop`. */
function loopHold(): { stop(): number } {
  let last = threadCpuMs()
  let longest = 0
  const timer = setInterval(() => {
    const now = threadCpuMs()
    longest = Math.max(longest, now - last)
    last = now
  }, 1)
  return { stop: () => { clearInterval(timer); return Math.max(longest, threadCpuMs() - last) } }
}

let profile = ''
let worker: Awaited<ReturnType<typeof startResumeRepairWorker>> | undefined
afterEach(async () => {
  await worker?.stop(); worker = undefined
  vi.restoreAllMocks()
  if (profile) rmSync(profile, { recursive: true, force: true })
})

it('a Codex resume repairs a 200 MB rollout without ever holding the core loop for 100 ms', async () => {
  profile = mkdtempSync(join(tmpdir(), 'resume-loop-'))
  const folder = join(profile, 'sessions', '2026', '11', '15')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `rollout-2026-11-15T08-00-00-${SESSION}.jsonl`)
  writeFileSync(file, codexSessionMeta(SESSION))
  const setTail = vi.fn()
  worker = await startResumeRepairWorker(profile)
  // Fixture allocation belongs to the engine's heap too: its GC must not be charged to the measured core loop.
  const fixture = await worker.call('fixture', 'fixture_append_codex_history', { file, bytes: 200 * 1024 ** 2 })
  expect(fixture.pid).toBe(worker.child.pid)
  expect(fixture.pid).not.toBe(process.pid)
  expect(statSync(file).size).toBeGreaterThanOrEqual(200 * 1024 ** 2)
  const call = vi.fn(worker.call)
  const repairs = createResumeRepairs({ call, handles: () => true, hold: async () => null, setTail })
  repairs.connected('engine-codex')
  const { prepareSessionResume } = createLaunchHelpers({
    authority: () => () => true, prepareApiTools: () => {}, launchOverridesDeps: {} as never, setGridLaunch: () => true, prepareResume: repairs.prepare,
  })
  const session = { agentId: 'a1', sessionId: SESSION, engine: 'codex', transcriptPath: file, codexHome: profile } as RegisteredSession
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const hold = loopHold()
  await prepareSessionResume(session, () => true)
  const longest = hold.stop()
  // Repaired: both reads, the backup, the repaired copy and their flushes all ran, and the tail moved to its new end.
  expect(setTail).toHaveBeenCalledWith(SESSION, statSync(file).size)
  expect(call.mock.calls.some(([, method]) => method === 'engine_resume_repair_prepare')).toBe(true)
  expect(longest).toBeLessThan(100)
}, 120_000)
