/** Opt-in baseline/candidate bundle measurement; OPENCODE_COST_ROOT contains both cli.js files.
 * OPENCODE_COST_NATIVE_HOOKS=1 includes all thirteen native installers at startup.
 * Private daemons and fake native processes only. Run without other heavy validation. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { IsolatedDaemon } from './harness/daemon.js'
import { LocalClient } from './harness/client.js'

it.runIf(Boolean(process.env.OPENCODE_COST_ROOT))('samples the same cold daemon and OpenCode launches with each frozen bundle', async () => {
  const samples: unknown[] = []
  const root = process.env.OPENCODE_COST_ROOT!
  const sample = (pid: number) => {
    const [cpu, rss] = execFileSync('ps', ['-o', 'time=,rss=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/)
    return { cpuMs: cpu.split(':').reverse().reduce((sum, value, i) => sum + Number(value) * 60 ** i, 0) * 1000, rssMiB: Number(rss) / 1024 }
  }
  for (const which of ['baseline', 'candidate', 'candidate', 'baseline']) {
    const d = await IsolatedDaemon.create({ scriptPath: join(root, which, 'cli.js'), env: { HARNESS_CONNECTIONS_PORT: '0' } })
    let client: LocalClient | undefined
    try {
      if (process.env.OPENCODE_COST_NATIVE_HOOKS === '1') {
        const home = join(d.root, 'native')
        Object.assign(d.env, {
          HOOK_INSTALL_ENGINES: 'claude,codex,cursor,opencode,kilo,pi,amp,hermes,devin,commandcode,grok,agy,copilot',
          CURSOR_CONFIG_DIR: join(home, 'cursor'), CURSOR_DATA_DIR: join(home, 'cursor-data'),
          KILO_PLUGIN_DIR: join(home, 'kilo', 'plugin'), PI_HOME: join(home, 'pi'),
          AMP_PLUGIN_DIR: join(home, 'amp', 'plugins'), AMP_SESSIONS_DIR: join(home, 'amp-sessions'),
          HERMES_HOME: join(home, 'hermes'), DEVIN_CONFIG_PATH: join(home, 'devin', 'config.json'),
          COMMANDCODE_HOME: join(home, 'commandcode'), GROK_HOME: join(home, 'grok'),
          AGY_CONFIG_DIR: join(home, 'agy'), COPILOT_HOME: join(home, 'copilot'),
        })
        mkdirSync(d.env.HERMES_HOME!, { recursive: true }); writeFileSync(join(d.env.HERMES_HOME!, 'config.yaml'), 'model: fixture\n')
      }
      const bin = join(d.root, 'bin', 'opencode'); d.env.OPENCODE_PATH = bin
      d.env.OPENCODE_PLUGIN_DIR = join(d.root, 'opencode', 'plugin')
      writeFileSync(bin, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('opencode v2.0.18'); process.exit(0) }
if (process.argv.includes('--help')) { console.log('--auto'); process.exit(0) }
process.title = ('opencode --session ses_' + process.pid).padEnd(160);
console.log('┃'); setInterval(() => {}, 1000);
`, { mode: 0o755 })
      const began = performance.now(); await d.start(); const readyMs = performance.now() - began
      const atReady = sample(d.corePid()!)
      client = await LocalClient.connect(d)
      const launches: unknown[] = []
      for (let i = 0; i < 2; i++) {
        const cwd = join(d.projectsDir, String(i)); mkdirSync(cwd)
        const before = sample(d.corePid()!), start = performance.now()
        const result = await client.request('agent_create', { engine: 'opencode', cwd }, 30000)
        expect(result.error).toBeUndefined()
        const after = sample(d.corePid()!)
        launches.push({ phase: i ? 'warm' : 'cold', requestMs: performance.now() - start, coreCpuMs: after.cpuMs - before.cpuMs, rssMiB: after.rssMiB })
      }
      samples.push({ bundle: which, readyMs, atReady, launches })
    } finally { client?.close(); await d.close() }
  }
  writeFileSync(join(root, 'cost.json'), JSON.stringify({ nativeHooks: process.env.OPENCODE_COST_NATIVE_HOOKS === '1', node: process.version, platform: process.platform, tmux: execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim(), samples }, null, 2) + '\n')
}, 240000)
