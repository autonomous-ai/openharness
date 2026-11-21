import { describe, expect, it, vi } from 'vitest'
import { childAdmissionFailure } from './childAdmission.js'
import { WORKER_CONTRACT, WORKER_PLAN, WORKER_COHORT_ENV, workerCohortEnvironment } from './workerContract.js'

const disk = 'b'.repeat(64)
const env = { HARNESSD_SUPERVISED: '1', HARNESSD_SERVICE_TOKEN: 'test-only', ...workerCohortEnvironment(42, disk) }

describe('child code admission before runtime effects', () => {
  it('refuses compact session records across contracts five and six with the same host plan', () => {
    const previous = { contract: 5, plan: WORKER_PLAN }
    const previousEnvironment = { ...env, [WORKER_COHORT_ENV]: `42:5:${WORKER_PLAN}:${disk}` }
    expect(childAdmissionFailure(previousEnvironment, 42, '/previous.js', () => disk, previous)).toBeNull()
    expect(childAdmissionFailure(env, 42, '/current.js', () => disk)).toBeNull()
    expect(childAdmissionFailure(previousEnvironment, 42, '/current.js', () => disk)).toContain('executed worker contract')
    expect(childAdmissionFailure(env, 42, '/previous.js', () => disk, previous)).toContain('executed worker contract')
    expect(WORKER_CONTRACT).toBe(7)
  })

  it('refuses mixed paste-host plans while admitting either complete cohort', () => {
    const previousPlan = '025db0d70a1bf79ed16dd31bc0aef1caaf3040cb4009d9f8c19387924fc8d911'
    const previous = { contract: WORKER_CONTRACT, plan: previousPlan }
    const previousEnvironment = { ...env, [WORKER_COHORT_ENV]: `42:${WORKER_CONTRACT}:${previousPlan}:${disk}` }
    expect(WORKER_PLAN).not.toBe(previousPlan)
    expect(childAdmissionFailure(previousEnvironment, 42, '/previous.js', () => disk, previous)).toBeNull()
    expect(childAdmissionFailure(env, 42, '/current.js', () => disk)).toBeNull()
    expect(childAdmissionFailure(previousEnvironment, 42, '/current.js', () => disk)).toContain('executed worker contract')
    expect(childAdmissionFailure(env, 42, '/previous.js', () => disk, previous)).toContain('executed worker contract')
  })

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
  it('refuses either mixed session-membership-scope plan while admitting each complete cohort', () => {
    const previousPlan = 'bf081b9d36cdc601439eaad4d8952a18d06e6c89ff63c0317d218b75f1e410f7'
    const previous = { contract: 3, plan: previousPlan }
    const previousEnvironment = { ...env, [WORKER_COHORT_ENV]: `42:3:${previousPlan}:${disk}` }
    expect(WORKER_CONTRACT).toBe(7)
    expect(WORKER_PLAN).not.toBe(previousPlan)
    expect(childAdmissionFailure(previousEnvironment, 42, '/previous.js', () => disk, previous)).toBeNull()
    expect(childAdmissionFailure(env, 42, '/current.js', () => disk)).toBeNull()
    expect(childAdmissionFailure(previousEnvironment, 42, '/current.js', () => disk)).toContain('executed worker contract')
    expect(childAdmissionFailure(env, 42, '/previous.js', () => disk, previous)).toContain('executed worker contract')
  })
  it('refuses a mixed required-storage cohort while preserving complete historical rollback', () => {
    const previous = { contract: 2, plan: WORKER_PLAN }
    const previousEnvironment = { ...env, [WORKER_COHORT_ENV]: `42:2:${WORKER_PLAN}:${disk}` }
    expect(WORKER_CONTRACT).toBe(7)
    expect(childAdmissionFailure(previousEnvironment, 42, '/previous.js', () => disk, previous)).toBeNull()
    expect(childAdmissionFailure(previousEnvironment, 42, '/current.js', () => disk)).toContain('executed worker contract')
    expect(childAdmissionFailure(env, 42, '/previous.js', () => disk, previous)).toContain('executed worker contract')
  })
  it('refuses the breaking Create payload across contracts three and four with the same host plan', () => {
    const previous = { contract: 3, plan: WORKER_PLAN }
    const previousEnvironment = { ...env, [WORKER_COHORT_ENV]: `42:3:${WORKER_PLAN}:${disk}` }
    expect(WORKER_CONTRACT).toBe(7)
    expect(childAdmissionFailure(previousEnvironment, 42, '/previous.js', () => disk, previous)).toBeNull()
    expect(childAdmissionFailure(env, 42, '/current.js', () => disk)).toBeNull()
    expect(childAdmissionFailure(previousEnvironment, 42, '/current.js', () => disk)).toContain('executed worker contract')
    expect(childAdmissionFailure(env, 42, '/previous.js', () => disk, previous)).toContain('executed worker contract')
  })
  it('refuses removed private desk calls across contracts four and five with the same host plan', () => {
    const previous = { contract: 4, plan: WORKER_PLAN }
    const previousEnvironment = { ...env, [WORKER_COHORT_ENV]: `42:4:${WORKER_PLAN}:${disk}` }
    expect(WORKER_CONTRACT).toBe(7)
    expect(childAdmissionFailure(previousEnvironment, 42, '/previous.js', () => disk, previous)).toBeNull()
    expect(childAdmissionFailure(env, 42, '/current.js', () => disk)).toBeNull()
    expect(childAdmissionFailure(previousEnvironment, 42, '/current.js', () => disk)).toContain('executed worker contract')
    expect(childAdmissionFailure(env, 42, '/previous.js', () => disk, previous)).toContain('executed worker contract')
  })

})
