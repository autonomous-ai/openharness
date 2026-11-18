import { describe, expect, it, vi } from 'vitest'
import { childAdmissionFailure } from './childAdmission.js'
import { WORKER_CONTRACT, WORKER_PLAN, WORKER_COHORT_ENV, workerCohortEnvironment } from './workerContract.js'

const disk = 'b'.repeat(64)
const env = { HARNESSD_SUPERVISED: '1', HARNESSD_SERVICE_TOKEN: 'test-only', ...workerCohortEnvironment(42, disk) }

describe('child code admission before runtime effects', () => {
  it('leaves a deliberate standalone process alone without reading any file', () => {
    const read = vi.fn()
    expect(childAdmissionFailure({}, 42, undefined, read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('requires a positive contract bound to the actual parent for both core and workers', () => {
    for (const given of [{ HARNESSD_SUPERVISED: '1' }, { HARNESSD_SERVICE_TOKEN: 'test-only' }, { ...env, [WORKER_COHORT_ENV]: 'legacy' }, { ...env, [WORKER_COHORT_ENV]: `43:1:${WORKER_PLAN}:${disk}` }]) {
      const read = vi.fn()
      expect(childAdmissionFailure(given, 42, '/cli.js', read)).toContain('this parent has not admitted')
      expect(read).not.toHaveBeenCalled()
    }
  })
  it('checks compatible executed literals even when disk changes B to C and back to B', () => {
    const restoredB = () => disk
    expect(childAdmissionFailure(env, 42, '/cli.js', restoredB, { contract: WORKER_CONTRACT + 1, plan: WORKER_PLAN })).toContain('executed worker contract')
    expect(childAdmissionFailure(env, 42, '/cli.js', restoredB, { contract: WORKER_CONTRACT, plan: 'c'.repeat(64) })).toContain('executed worker contract')
    // Different executed artifact C with the same declared private semantics is compatible, not byte-identical.
    expect(childAdmissionFailure(env, 42, '/cli.js', restoredB, { contract: WORKER_CONTRACT, plan: WORKER_PLAN })).toBeNull()
  })
  it('refuses selected-file drift, an unreadable file or a missing path', () => {
    expect(childAdmissionFailure(env, 42, '/cli.js', () => 'c'.repeat(64))).toContain('selected bundle changed')
    expect(childAdmissionFailure(env, 42, '/cli.js', () => null)).toContain('selected bundle changed')
    expect(childAdmissionFailure(env, 42, undefined)).toContain('selected bundle changed')
    expect(childAdmissionFailure(env, 42, '/a/path/that/does/not/exist')).toContain('selected bundle changed')
  })
  it('accepts a compatible cohort with its selected file unchanged', () => {
    expect(childAdmissionFailure(env, 42, '/cli.js', () => disk)).toBeNull()
  })
  it('refuses either mixed private session-query plan while admitting each complete contract-three cohort', () => {
    const previousPlan = 'ad3cd3af3b497aa0ac8422ed823ff3da403497dc16f4623fc53001ea75645467'
    const previous = { contract: 3, plan: previousPlan }
    const previousEnvironment = { ...env, [WORKER_COHORT_ENV]: `42:3:${previousPlan}:${disk}` }
    expect(WORKER_CONTRACT).toBe(3)
    expect(WORKER_PLAN).not.toBe(previousPlan)
    expect(childAdmissionFailure(previousEnvironment, 42, '/previous.js', () => disk, previous)).toBeNull()
    expect(childAdmissionFailure(env, 42, '/current.js', () => disk)).toBeNull()
    expect(childAdmissionFailure(previousEnvironment, 42, '/current.js', () => disk)).toContain('executed worker contract')
    expect(childAdmissionFailure(env, 42, '/previous.js', () => disk, previous)).toContain('executed worker contract')
  })
  it('refuses a mixed required-storage cohort while preserving complete historical rollback', () => {
    const previous = { contract: 2, plan: WORKER_PLAN }
    const previousEnvironment = { ...env, [WORKER_COHORT_ENV]: `42:2:${WORKER_PLAN}:${disk}` }
    expect(WORKER_CONTRACT).toBe(3)
    expect(childAdmissionFailure(previousEnvironment, 42, '/previous.js', () => disk, previous)).toBeNull()
    expect(childAdmissionFailure(previousEnvironment, 42, '/current.js', () => disk)).toContain('executed worker contract')
    expect(childAdmissionFailure(env, 42, '/previous.js', () => disk, previous)).toContain('executed worker contract')
  })
})
