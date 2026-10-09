/** Same private native pool on both production trees. No host engine, process or daemon. */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CURSOR_TRANSCRIPT } from '../../src/engines/cursor/contract.js'
import { GROK_TRANSCRIPT } from '../../src/engines/grok/contract.js'
import { COPILOT_PROCESS_SESSION } from '../../src/engines/copilot/contract.js'
import { locateProcessSession, locateTranscript } from '../../src/engines/kit/sessionLocation.js'
const root = mkdtempSync(join(tmpdir(), 'native-location-cost-'))
const workload = process.argv[2] ?? 'transcript'
const id = (n: number) => `aaaaaaaa-1111-4222-8333-${String(n).padStart(12, '0')}`
const file = (path: string, text = '{}\n') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path }
try {
  const count = workload === 'limit' ? 4200 : 160
  for (let i = 0; i < count; i++) {
    if (workload === 'process') {
      mkdirSync(join(root, 'session-state', id(i)), { recursive: true })
      const path = file(join(root, 'session-state', id(i), 'inuse.4242.lock'))
      utimesSync(path, 1000 + i, 1000 + i)
    } else if (workload === 'grok-sidecars') {
      const group = join(root, 'sessions', `hash-${String(i).padStart(5, '0')}`)
      file(join(group, id(1), 'updates.jsonl'))
      file(join(group, '.cwd'), (i === count - 1 ? '/workspace' : `/elsewhere-${i}`).padEnd(60 * 1024, ' '))
    } else mkdirSync(join(root, 'projects', `project-${String(i).padStart(5, '0')}`), { recursive: true })
  }
  if (workload === 'transcript') file(join(root, 'projects', 'project-00159', 'agent-transcripts', id(1), `${id(1)}.jsonl`))
  const latenciesMs: number[] = [], outcomes: Record<string, number> = {}
  const cpu = process.cpuUsage()
  for (let i = 0; i < 10; i++) {
    const started = performance.now()
    let outcome: string
    try {
      const found = workload === 'process' ? await locateProcessSession(COPILOT_PROCESS_SESSION, root, 4242)
        : workload === 'grok-sidecars' ? await locateTranscript(GROK_TRANSCRIPT, root, id(1), { cwd: '/workspace' })
        : await locateTranscript(CURSOR_TRANSCRIPT, root, id(1))
      outcome = found ? 'exact' : 'absent'
    } catch (error) {
      if ((error as { code?: string }).code !== 'IDENTITY_UNAVAILABLE') throw error
      outcome = 'held'
    }
    latenciesMs.push(Number((performance.now() - started).toFixed(2)))
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  const used = process.cpuUsage(cpu)
  console.log(JSON.stringify({ workload, entries: count, iterations: 10, outcomes, latenciesMs,
    cpuMs: (used.user + used.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, platform: process.platform, arch: process.arch }))
} finally { rmSync(root, { recursive: true, force: true }) }
