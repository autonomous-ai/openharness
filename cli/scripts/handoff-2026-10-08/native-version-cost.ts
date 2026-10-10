/** Matched native-version component workload. Run each revision/workload in a fresh process. */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const workload = process.argv[2]
if (!['healthy', 'slow', 'cached'].includes(workload)) throw Error('Unknown workload')
const cli = process.env.NATIVE_VERSION_COST_CLI ?? resolve(import.meta.dirname, '../..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-version-cost-')))
try {
  // The only executable is this private fixture, using the same Node as the runner.
  const file = join(root, 'opencode'), calls = join(root, 'calls')
  writeFileSync(calls, '')
  writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== '--version') process.exit(2);
fs.appendFileSync(${JSON.stringify(calls)}, 'probe\\n');
setTimeout(() => console.log('opencode v2.0.18'), ${workload === 'slow' ? 100 : 0});
`, { mode: 0o700 })
  process.env.HOME = root
  const { majorVersion, nativeVersionProbe } = await import(pathToFileURL(join(cli, 'src/engines/kit/nativeVersion.ts')).href)
  const rule = { args: ['--version'], output: /(\d+)\.\d+\.\d+/, timeoutMs: 5_000 }
  const memo = new Map<string, number | null>()
  if (workload === 'cached' && await majorVersion(rule, nativeVersionProbe(rule, () => file), memo) !== 2) throw Error('Warmup failed')
  const iterations = workload === 'cached' ? 500 : 10
  const latenciesMs: number[] = [], callbackDelaysMs: number[] = []
  const cpu = process.cpuUsage(), start = performance.now()
  for (let index = 0; index < iterations; index++) {
    let last = performance.now(), worst = 0
    const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now }, 1)
    try {
      const started = performance.now()
      const answer = await majorVersion(rule, nativeVersionProbe(rule, () => file), workload === 'cached' ? memo : new Map())
      latenciesMs.push(performance.now() - started)
      // Let the timer see the final synchronous block before clearing it.
      await new Promise(done => setTimeout(done, 1))
      callbackDelaysMs.push(worst)
      if (answer !== 2) throw Error('The version answer changed')
    } finally { clearInterval(timer) }
  }
  const used = process.cpuUsage(cpu)
  const commands = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length
  if (commands !== (workload === 'cached' ? 1 : iterations)) throw Error('Unexpected number of native probes')
  const distribution = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    return { median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }
  }
  process.stdout.write(JSON.stringify({ workload, iterations, commands, latencyMs: distribution(latenciesMs),
    callbackDelayMs: distribution(callbackDelaysMs), elapsedMs: performance.now() - start,
    parentCpuMs: (used.user + used.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, platform: process.platform, arch: process.arch }) + '\n')
} finally { rmSync(root, { recursive: true, force: true }) }
