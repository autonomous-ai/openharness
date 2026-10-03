/** Synthetic saved-session catalog reads. Never reads or starts the user's sessions.
 * Run: node --import tsx scripts/benchmark-stopped-catalog.ts [output.json]
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const root = mkdtempSync(join(tmpdir(), 'harness-catalog-bench-'))
process.env.ADAPTER_DATA_DIR = root
const { StoppedAgentStore } = await import('../src/lib/stoppedAgents.js')
const summaries: Record<string, unknown>[] = []
try {
  for (const count of [32, 272, 1000]) {
    const directory = join(root, String(count))
    mkdirSync(directory, { mode: 0o700 })
    for (let i = 0; i < count; i++) {
      const row = { schemaVersion: 2, agentId: `saved-${i}`, sessionId: `conversation-${i}`,
        engine: i % 2 ? 'claude' : 'codex', active: false, projectDir: '/synthetic/project',
        cwd: '/synthetic/project', runtimes: [{ backend: 'tmux', paneId: `%${i}` }],
        primaryRuntimeKey: `tmux\0%${i}`, tmuxPane: `%${i}`, processIdentity: null,
        launch: { state: 'ready' }, title: `Saved task ${i}`, defaultName: `Project ${i}`,
        registeredAt: 1, touchedAt: 2, lastHookAt: 1, lastTranscriptAt: 2, lastOpenedAt: 2,
        transcriptPath: `/synthetic/history/${i}.jsonl`, permissionMode: 'ask',
        source: 'hook', boundAt: 1, model: 'synthetic-model', cliVersion: 'fixture',
      }
      writeFileSync(join(directory, `${row.agentId}.json`), JSON.stringify({ version: 1, session: row }), { mode: 0o600 })
    }
    const store = new StoppedAgentStore(directory)
    const started = performance.now()
    if (store.list().length !== count) throw new Error('Cold catalog mismatch')
    const coldMs = performance.now() - started
    for (let i = 0; i < 5; i++) store.available([])
    const cpu = process.cpuUsage()
    const samples: number[] = []
    for (let i = 0; i < 60; i++) {
      const start = performance.now()
      const rows = store.available([])
      if (rows.length !== count || rows.some(row => row.active || !row.sessionId)) throw new Error('Warm catalog mismatch')
      samples.push(performance.now() - start)
    }
    const used = process.cpuUsage(cpu)
    samples.sort((a, b) => a - b)
    summaries.push({ count, coldMs, reads: samples.length, warmMedianMs: samples[29], warmP95Ms: samples[56],
      warmMaxMs: samples[59], cpuMs: (used.user + used.system) / 1000 })
  }
  const result = { kind: 'synthetic-saved-session-catalog', node: process.version,
    platform: process.platform, arch: process.arch, summaries,
    limitations: ['Synthetic metadata with a warm OS file cache.', 'Measures catalog reads, not whole-app CPU, display latency, or model processes.'] }
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { rmSync(root, { recursive: true, force: true }) }
