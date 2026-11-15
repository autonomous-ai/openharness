/** Real worker failure boundary, with a transient core coordinator and no user daemon or tmux server. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, expect, it, onTestFailed, vi } from 'vitest'
import { createResumeRepairs } from '../src/core/engines/resumeRepairs.js'
import { RESUME_REPAIR_PREPARE } from '../src/engines/worker/resumeRepairProtocol.js'
import { appendCodexHistory, codexSessionMeta } from '../src/testing/codexRollout.js'
import { startResumeRepairWorker } from '../src/testing/resumeRepairProcess.js'

let home = '', worker: Awaited<ReturnType<typeof startResumeRepairWorker>> | undefined
afterEach(async () => { vi.useRealTimers(); worker?.child.kill('SIGCONT'); await worker?.stop(); worker = undefined; if (home) rmSync(home, { recursive: true, force: true }) })

it.skipIf(process.platform === 'win32').each(['killed', 'hung'] as const)('keeps core responsive and history unchanged when its preparing worker is %s', async fault => {
  const started = performance.now(), phases: Array<[string, number]> = []
  const phase = (name: string) => { phases.push([name, Math.round(performance.now() - started)]) }
  onTestFailed(() => { console.error(JSON.stringify({ fault, phases })) })
  home = mkdtempSync(join(tmpdir(), 'resume-process-fault-'))
  const id = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36d', folder = join(home, 'sessions'), file = join(folder, `rollout-${id}.jsonl`)
  mkdirSync(folder); writeFileSync(file, codexSessionMeta(id)); appendCodexHistory(file, 8 * 1024 ** 2)
  const digest = () => createHash('sha256').update(readFileSync(file)).digest('hex')
  const before = digest(), source = { engine: 'codex', sessionId: id, transcriptPath: file, codexHome: home }
  phase('fixture_ready')
  worker = await startResumeRepairWorker(home, true)
  phase('worker_ready')
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
  phase('preparation_requested')
  expect(await remote.staged).toMatchObject({ answer: { repairedItems: 1 } })
  phase('private_stage_ready')
  remote.child.kill(fault === 'hung' ? 'SIGSTOP' : 'SIGKILL')
  // This is an actual core event-loop turn while the worker cannot progress, not a fixed sleep.
  await nextTurn()
  phase('core_turn_completed')
  if (fault === 'hung') await vi.advanceTimersByTimeAsync(65_000)
  phase('deadline_checked')
  expect(await resume).toMatchObject({ repairedItems: 0, unrepaired: 'unavailable' })
  phase('resume_completed')
  expect(setTail).not.toHaveBeenCalled()
  expect(digest()).toBe(before)
  if (fault === 'hung') {
    remote.child.kill('SIGCONT'); remote.proceed()
    await pending
    phase('late_worker_completed')
    expect(digest()).toBe(before)
  }
}, 30_000)
