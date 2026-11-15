/**
 * A Codex resume prepares its history while the core's loop goes on: the rollout is read a chunk at a time, and the
 * core's other work runs between chunks (engines/kit/resumeRepair.ts). Read in line, a 200 MB rollout with an item to
 * repair held the loop 2.4 s on a Mac; the one of 3 October was 803 MB.
 *
 * What is measured is the CPU time of the loop's own thread between two turns of a 1 ms timer: the longest the loop
 * did one thing without letting the timer in. A busy machine that keeps the process off the CPU for a while does not
 * read as a held loop.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { appendCodexHistory, codexSessionMeta } from '../../testing/codexRollout.js'
import { createLaunchHelpers } from './launch.js'

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
afterEach(() => {
  vi.restoreAllMocks()
  if (profile) rmSync(profile, { recursive: true, force: true })
})

it('a Codex resume repairs a 200 MB rollout without ever holding the core loop for 50 ms', async () => {
  profile = mkdtempSync(join(tmpdir(), 'resume-loop-'))
  const folder = join(profile, 'sessions', '2026', '11', '15')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `rollout-2026-11-15T08-00-00-${SESSION}.jsonl`)
  writeFileSync(file, codexSessionMeta(SESSION))
  appendCodexHistory(file, 200 * 1024 ** 2)
  const setTail = vi.fn()
  const { prepareSessionResume } = createLaunchHelpers({
    authority: () => () => true, prepareApiTools: () => {}, launchOverridesDeps: {} as never, setGridLaunch: () => true, setTail,
  })
  const session = { agentId: 'a1', sessionId: SESSION, engine: 'codex', transcriptPath: file, codexHome: profile } as RegisteredSession
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const hold = loopHold()
  await prepareSessionResume(session)
  const longest = hold.stop()
  // Repaired: both reads, the backup, the repaired copy and their flushes all ran, and the tail moved to its new end.
  expect(setTail).toHaveBeenCalledWith(SESSION, statSync(file).size)
  expect(longest).toBeLessThan(50)
}, 120_000)
