/** Checks executed private protocol literals and selected-file drift before a child loads its runtime. */
import { fingerprint } from './bundleFingerprint.js'
import { WORKER_COHORT_ENV, WORKER_CONTRACT, WORKER_PLAN } from './workerContract.js'

export function childAdmissionFailure(
  env: NodeJS.ProcessEnv, parentPid: number, script: string | undefined,
  read: (path: string) => string | null = fingerprint,
  executed: { contract: number; plan: string } = { contract: WORKER_CONTRACT, plan: WORKER_PLAN },
): string | null {
  if (env.HARNESSD_SUPERVISED !== '1' && !env.HARNESSD_SERVICE_TOKEN) return null
  const proof = /^(\d+):([1-9]\d{0,3}):([0-9a-f]{64}):([0-9a-f]{64})$/.exec(env[WORKER_COHORT_ENV] ?? '')
  if (!proof || Number(proof[1]) !== parentPid) return 'this parent has not admitted the worker cohort; update the supervisor or restore the previous build'
  if (Number(proof[2]) !== executed.contract || proof[3] !== executed.plan) return 'the executed worker contract or plan differs from the admitted cohort'
  // This observes disk drift only. The literals above prove compatible executed code even for B→C→B.
  if (!script || read(script) !== proof[4]) return 'the selected bundle changed before this child started'
  return null
}
