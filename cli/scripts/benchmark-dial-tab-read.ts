/** The round dial's tab read (`listAgentSnapshot({ apps: true })`): a window open on an empty tab, Harness settled in
 * front, on a host with no sessions and a registry of synthetic agents. Never the daemon, never a real home.
 * Run from cli/: node --import tsx scripts/benchmark-dial-tab-read.ts [--src <the cli/src of a tree>] [output.json]
 * `--src` (default: this tree's) is where every module is loaded from, so the same script measures the base.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

import type { HostAgent, HostSource } from '../src/cable/hosts/types.js'

const args = process.argv.slice(2)
const at = args.indexOf('--src')
const src = resolve(at >= 0 ? args.splice(at, 2)[1] : join(import.meta.dirname, '../src'))
const output = args[0]

// A throwaway home before any module of the tree loads: a module that resolves a path under the home at load time
// lands here, never in the person's own.
const home = mkdtempSync(join(tmpdir(), 'harness-dial-tab-read-'))
process.env.HOME = home
process.env.USERPROFILE = home
for (const [name, folder] of [['ADAPTER_DATA_DIR', 'data'], ['ADAPTER_RUNTIME_DIR', 'runtime'], ['HARNESS_AUTH_DIR', 'auth']]) {
  process.env[name] = join(home, folder)
  mkdirSync(process.env[name]!)
}
delete process.env.HARNESS_ENV_FILE
delete process.env.DOTENV_CONFIG_PATH

const load = (path: string): Promise<unknown> => import(pathToFileURL(join(src, path)).href)

const APPS = ['ghostty', 'vscode', 'orca', 'cursor', 'iterm']
const WARMUP = 500
const ROUNDS = 21
const PER_ROUND = 500

interface Case { agents: number; apps: number; reads: number; medianUs: number; maxUs: number; registryReadsPerRead: number; appsInAnswer: number | null }

try {
  const { DaemonCableHost } = await load('cable/cableHost.ts') as typeof import('../src/cable/cableHost.js')
  const { HostRegistry } = await load('cable/hosts/registry.ts') as typeof import('../src/cable/hosts/registry.js')

  async function measure(count: number): Promise<Case> {
    const agents = Array.from({ length: count }, (_, i): HostAgent => {
      const app = APPS[i % APPS.length]
      return { id: `agent-${i}`, engine: 'claude', sessionId: `session-${i}`, name: `agent ${i}`, host: app, app,
        state: 'idle', lastActivityAt: 1_794_000_000_000 + i, unseenDone: false }
    })
    let lists = 0
    const source: HostSource = {
      id: 'observed',
      list: () => { lists++; return agents },
      capabilities: () => ({ status: true, voice: false, focus: false, answer: false }),
    }
    const host = new DaemonCableHost({
      sessions: () => [],
      displayName: (s) => s.agentId,
      machineName: () => 'bench',
      machineId: () => 'bench',
      computerId: () => 'bench',
      sendTurn: () => {},
      stopTurn: () => {},
      answer: () => {},
      recent: () => [],
      recentAsks: () => [],
      log: () => {},
      // The settle runs at once, so the front is settled without a wait.
      appTimer: (_ms, run) => { run(); return () => {} },
    })
    host.setRegistry(new HostRegistry([host.harness, source]))
    await host.listAgentSnapshot({ apps: true })
    host.front('harness')
    host.setSwarms({ active: '', swarms: [], tiles: [] })
    host.setDesk([])
    if (!host.holdsTab()) throw new Error('the window did not open on the tab')

    let last: Awaited<ReturnType<typeof host.listAgentSnapshot>> | undefined
    for (let i = 0; i < WARMUP; i++) last = await host.listAgentSnapshot({ apps: true })
    lists = 0
    const perRead: number[] = []
    for (let round = 0; round < ROUNDS; round++) {
      const start = performance.now()
      for (let i = 0; i < PER_ROUND; i++) last = await host.listAgentSnapshot({ apps: true })
      perRead.push((performance.now() - start) * 1000 / PER_ROUND)
    }
    perRead.sort((a, b) => a - b)
    const reads = ROUNDS * PER_ROUND
    const round2 = (n: number): number => Math.round(n * 100) / 100
    return {
      agents: count,
      apps: count ? APPS.length : 0,
      reads,
      medianUs: round2(perRead[Math.floor(ROUNDS / 2)]),
      maxUs: round2(perRead[ROUNDS - 1]),
      registryReadsPerRead: round2(lists / reads),
      appsInAnswer: last?.apps ? last.apps.apps.length : null,
    }
  }

  const result = { node: process.version, platform: platform(), arch: arch(), cases: [await measure(0), await measure(50)] }
  console.log(JSON.stringify(result, null, 2))
  if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
