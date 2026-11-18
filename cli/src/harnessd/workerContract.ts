/** Executed private worker semantics. Breaking changes bump this contract; public clients are independent. */
export const WORKER_CONTRACT = 7
/** Machine-checked against service/native factory declarations and capability versions, without loading them at entry. */
export const WORKER_PLAN = 'c0e779383f9daf58c0844778d2a2de8867acca3287ab6fb0958ebbe78fa429e5'
export const WORKER_COHORT_ENV = 'HARNESSD_WORKER_COHORT'
export const SERVICES_EXPLICIT_ENV = 'HARNESSD_SERVICES_EXPLICIT'

export type WorkerProbe = { kind: 'modern'; contract: number; plan: string } | { kind: 'legacy' }

/** Only complete affirmative records admit a retained master. Missing/malformed markers never imply legacy. */
export function readWorkerProbe(output: string): WorkerProbe | undefined {
  const lines = output.trim().split('\n')
  const line = lines[lines.length - 1]
  const modern = /^harnessd-probe ok · protocol [1-9]\d{0,3} · v[^\r\n·]{0,128} · (?:takes a handover · )?worker-cohort ([1-9]\d{0,3}) ([0-9a-f]{64})$/.exec(line)
  if (modern) return { kind: 'modern', contract: Number(modern[1]), plan: modern[2] }
  // The supported historical protocol 5–7 explicitly accepts SERVICES=none and an empty process list.
  if (/^harnessd-probe ok · protocol [5-7] · v[^\r\n·]{1,128}(?: · takes a handover)?$/.test(line)) return { kind: 'legacy' }
  return undefined
}

export function workerCohortEnvironment(parentPid: number, entryFingerprint: string): Record<string, string> {
  return { [WORKER_COHORT_ENV]: `${parentPid}:${WORKER_CONTRACT}:${WORKER_PLAN}:${entryFingerprint}` }
}
