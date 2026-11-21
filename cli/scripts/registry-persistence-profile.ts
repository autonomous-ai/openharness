/** Fixed 83-sample workload; only untimed setup adapts to awaited authority admission. */
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { ownProcessGroup } from '../src/lib/windows/noWindow.js'

const directory = mkdtempSync(join(tmpdir(), 'registry-profile-'))
for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME']) process.env[key] = directory
const { registry } = await import('../src/lib/registry.js')
await registry.load()
const samples: Record<string, unknown>[] = []
const sample = async (name: string, work: () => unknown) => {
  const start = performance.now(), cpu = process.cpuUsage()
  const heartbeat = new Promise<number>(resolve => setImmediate(() => resolve(performance.now() - start)))
  let error: string | undefined
  try { await work() } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
  const elapsed = performance.now() - start
  const blocked = await heartbeat
  const used = process.cpuUsage(cpu)
  samples.push({ name, elapsed, heartbeat: blocked, cpu: (used.user + used.system) / 1000,
    rss: process.memoryUsage().rss, ...(error ? { error } : {}) })
}
try {
  for (const size of [16, 160]) {
    await registry.transaction(async () => {
      for (let index = registry.list().length; index < size; index++) await registry.openProcessAgent({
        agentId: `agent-${index}`, engine: 'claude', tmuxPane: `%${index + 1}`,
        processIdentity: { pid: 1000 + index, executable: '/fixture/claude', startMarker: `fixture-${index}` },
      })
    })
    for (let index = 0; index < 20; index++) await sample(`unchanged-${size}`, () => registry.flush())
    for (let index = 0; index < 20; index++) await sample(`changed-${size}`, async () => {
      registry.setCwd('agent-0', `/fixture/project-${index}`)
      await registry.flush()
    })
  }
  for (let index = 0; index < 3; index++) {
    const holder = fork(fileURLToPath(new URL('../src/lib/__fixtures__/registryLockOwner.cjs', import.meta.url)), [directory], {
      ...ownProcessGroup(), execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    await once(holder, 'message')
    const exited = once(holder, 'exit')
    setImmediate(() => holder.send('release'))
    await sample('legacy-lock', () => registry.setClosePlan('agent-0', {
      id: '12345678-1234-1234-1234-123456789012', identity: 'fixture', requestedAt: Date.now(), state: 'waiting',
    }))
    await exited
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, samples }))
} finally { await registry.flush({ exiting: true }); rmSync(directory, { recursive: true, force: true }) }
