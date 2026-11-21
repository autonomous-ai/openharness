import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SERVICE_HOSTS, serviceProcessesEnv } from './services.js'
import { ENGINES } from '../engines/types.js'
import { readWorkerProbe, WORKER_PLAN, WORKER_CONTRACT, workerCohortEnvironment, WORKER_COHORT_ENV } from './workerContract.js'

describe('the executed worker contract', () => {
  it('binds the literal plan to the complete host catalogue and capability versions', () => {
    const actual = createHash('sha256').update(JSON.stringify({ hosts: SERVICE_HOSTS, nativeFactories: ENGINES, capabilities: serviceProcessesEnv([], 0) })).digest('hex')
    expect(WORKER_PLAN).toBe(actual)
  })
  it('carries only a bounded parent and code contract into a child', () => {
    expect(workerCohortEnvironment(42, 'b'.repeat(64))).toEqual({ [WORKER_COHORT_ENV]: `42:${WORKER_CONTRACT}:${WORKER_PLAN}:${'b'.repeat(64)}` })
  })
  it('accepts complete current and historical worker probe records', () => {
    expect(readWorkerProbe(`harnessd-probe ok · protocol 8 · v1 · worker-cohort ${WORKER_CONTRACT} ${WORKER_PLAN}`))
      .toEqual({ kind: 'modern', contract: WORKER_CONTRACT, plan: WORKER_PLAN })
    expect(readWorkerProbe('harnessd-probe ok · protocol 7 · v1 · takes a handover')).toEqual({ kind: 'legacy' })
  })
  it('rejects unknown, malformed and empty records rather than interpreting marker absence', () => {
    for (const value of ['', 'harnessd-probe ok', 'harnessd-probe ok · protocol 4 · v1', 'harnessd-probe ok · protocol 8 · v1', 'harnessd-probe ok · protocol 7 · v1 · worker-cohort 0 x']) expect(readWorkerProbe(value)).toBeUndefined()
  })
})
