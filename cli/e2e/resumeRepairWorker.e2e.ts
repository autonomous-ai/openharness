/** Real worker failure boundary, with a transient core coordinator and no user daemon or tmux server. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createResumeRepairs } from '../src/core/engines/resumeRepairs.js'
import { RESUME_REPAIR_PREPARE } from '../src/engines/worker/resumeRepairProtocol.js'
import { appendCodexHistory, codexSessionMeta } from '../src/testing/codexRollout.js'
import { startResumeRepairWorker } from '../src/testing/resumeRepairProcess.js'

let home = '', worker: Awaited<ReturnType<typeof startResumeRepairWorker>> | undefined
afterEach(async () => { vi.useRealTimers(); worker?.child.kill('SIGCONT'); await worker?.stop(); worker = undefined; if (home) rmSync(home, { recursive: true, force: true }) })

it.skipIf(process.platform === 'win32').each(['killed', 'hung'] as const)('keeps core responsive and history unchanged when its preparing worker is %s', async fault => {
  home = mkdtempSync(join(tmpdir(), 'resume-process-fault-'))
  const id = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36d', folder = join(home, 'sessions'), file = join(folder, `rollout-${id}.jsonl`)
  mkdirSync(folder); writeFileSync(file, codexSessionMeta(id)); appendCodexHistory(file, 8 * 1024 ** 2)
  const before = readFileSync(file), source = { engine: 'codex', sessionId: id, transcriptPath: file, codexHome: home }
  worker = await startResumeRepairWorker(home, true)
  const remote = worker
  const setTail = vi.fn()
  let pending: Promise<Record<string, unknown>> | undefined
  const repairs = createResumeRepairs({ handles: () => true, hold: async () => null, setTail,
    call: (service, method, payload) => {
      if (method === RESUME_REPAIR_PREPARE) {
        pending = remote.call(service, method, payload)
        return pending
      }
      return remote.call(service, method, payload)
    },
  })
  repairs.connected('engine-codex')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const resume = repairs.prepare(source, () => true)
  expect(await remote.staged).toMatchObject({ answer: { repairedItems: 1 } })
  remote.child.kill(fault === 'hung' ? 'SIGSTOP' : 'SIGKILL')
  // This is an actual core event-loop turn while the worker cannot progress, not a fixed sleep.
  await nextTurn()
  if (fault === 'hung') await vi.advanceTimersByTimeAsync(65_000)
  expect(await resume).toMatchObject({ repairedItems: 0, unrepaired: 'unavailable' })
  expect(setTail).not.toHaveBeenCalled()
  expect(readFileSync(file)).toEqual(before)
  if (fault === 'hung') {
    remote.child.kill('SIGCONT'); remote.proceed()
    await pending
    expect(readFileSync(file)).toEqual(before)
  }
}, 30_000)
