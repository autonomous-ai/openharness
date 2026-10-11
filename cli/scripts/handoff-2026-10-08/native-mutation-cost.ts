/** Matched native model control workload; synthetic native latency, no host binaries or files. */
import { performance } from 'node:perf_hooks'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const root = process.env.NATIVE_MUTATION_COST_CLI ?? resolve(import.meta.dirname, '../..')
const workload = process.argv[2]
if (!['healthy', 'lost-reply'].includes(workload)) throw Error('Unknown workload')
const hostPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'linux' })
const forbidden = () => { throw Error('Host binaries are forbidden in this measurement') }
Object.assign(childProcess, { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden, spawn: forbidden, spawnSync: forbidden, fork: forbidden })
syncBuiltinESMExports()
const { createSessionModelControl } = await import(pathToFileURL(join(root, 'src/engines/kit/nativeSessionModel.ts')).href)
const { OPENCODE_SESSION_MODEL } = await import(pathToFileURL(join(root, 'src/engines/opencode/contract.ts')).href)
console.log = () => {}; console.warn = () => {}
const control = createSessionModelControl(OPENCODE_SESSION_MODEL, () => '/fixture/opencode')
const iterations = 40, latenciesMs: number[] = []
let writes = 0, reads = 0, confirmed = 0
const cpu = process.cpuUsage()
for (let index = 0; index < iterations; index++) {
  const sessionId = `ses_fixture${index}`, started = performance.now()
  const result = await control.switchSessionModel(sessionId, { providerID: 'fixture', modelID: 'model' }, {
    retryDelayMs: 0, run: async (args: string[]) => {
      await new Promise(done => setTimeout(done, 2))
      if (args[1] === 'session.switchModel') {
        writes++
        if (workload === 'lost-reply') throw Error('committed, reply lost')
        return { stdout: '' }
      }
      reads++
      return { stdout: JSON.stringify({ data: { id: sessionId, model: { providerID: 'fixture', id: 'model' } } }) }
    },
  })
  if (result.ok) confirmed++
  latenciesMs.push(performance.now() - started)
}
const used = process.cpuUsage(cpu)
process.stdout.write(JSON.stringify({ workload, iterations, latenciesMs, cpuMs: (used.user + used.system) / 1000,
  peakRssMiB: process.resourceUsage().maxRSS / 1024, writes, reads, confirmed,
  node: process.version, hostPlatform, evidencePlatform: process.platform, arch: process.arch }) + '\n')
