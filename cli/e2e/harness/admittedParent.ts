/** A fixture replacing the master must probe the exact entry before admitting its private worker. */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fingerprint } from '../../src/harnessd/bundleFingerprint.js'
import { readWorkerProbe, workerCohortEnvironment, WORKER_CONTRACT, WORKER_PLAN } from '../../src/harnessd/workerContract.js'
import { CLI_ROOT, type IsolatedDaemon } from './daemon.js'
const exec = promisify(execFile)

export async function admitFixtureCore(d: IsolatedDaemon): Promise<void> {
  const node = d.options.node || process.env.E2E_NODE_PATH
  if (!node || !d.options.noMaster || d.options.launch) throw new Error('fixture parent requires its explicit isolated core entry')
  const bundle = d.options.scriptPath ?? process.env.E2E_BUNDLE_PATH
  const entry = bundle || join(CLI_ROOT, 'src/cli.ts')
  const hash = fingerprint(entry)
  if (!hash) throw new Error('fixture core entry unavailable')
  const { stdout } = await exec(node, [...(bundle ? [] : ['--import', 'tsx']), entry, '__harnessd-probe'], {
    cwd: CLI_ROOT, env: { ...d.env, HARNESSD_SERVICES: 'none', HARNESSD_SERVICE_PROCESSES: '' },
    timeout: 30_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 64 * 1024,
  })
  const probe = readWorkerProbe(stdout)
  if (probe?.kind !== 'modern' || probe.contract !== WORKER_CONTRACT || probe.plan !== WORKER_PLAN || fingerprint(entry) !== hash) {
    throw new Error('fixture parent did not admit the selected core')
  }
  Object.assign(d.env, workerCohortEnvironment(process.pid, hash))
}
