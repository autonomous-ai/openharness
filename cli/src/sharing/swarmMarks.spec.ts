import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { observerSnapshotFile, savedConfidential, superTabOf, withoutSwarm } from './swarmMarks.js'

describe('the Swarm\'s marks on Share, read with the Swarm off', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'swarm-marks-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })
  const save = (value: unknown) => {
    const file = observerSnapshotFile(dataDir, 'machine')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
    return file
  }

  it('tells a Super Tab\'s grant from an ordinary one', () => {
    expect(superTabOf({ tab: 'super:tab-1' })).toBe('tab-1')
    expect(superTabOf({ tab: 'team' })).toBeNull()
    expect(superTabOf({ tab: null })).toBeNull()
  })

  it('reads the confidential sessions this machine\'s snapshot names, and nothing from one it cannot trust', () => {
    expect(observerSnapshotFile(dataDir, 'machine')).toBe(join(dataDir, 'super-tabs', 'observers-machine.json'))
    const file = save({ machineId: 'machine', confidential: ['lead', 'not an id', 7] })
    expect(savedConfidential(file, 'machine')).toEqual(['lead'])
    expect(savedConfidential(file, 'another')).toEqual([])
    for (const bad of ['{', '[]', 'null', { machineId: 'machine', confidential: 'lead' }]) expect(savedConfidential(save(bad), 'machine'), JSON.stringify(bad)).toEqual([])
    expect(savedConfidential(join(dataDir, 'absent.json'), 'machine')).toEqual([])
  })

  it('without the Swarm, says no roster is in force, refuses a Super Tab\'s grants and every share of a confidential session', () => {
    const marks = withoutSwarm(dataDir, () => 'machine')
    const grant = (agentId: string, tab?: string) => ({ agentId, recipientEmail: 'b@example.com', ...(tab ? { tab } : {}) }) as never
    expect(marks.known()).toBeNull()
    expect(marks.allows(grant('lead'))).toBe(true)
    save({ machineId: 'machine', until: 0, wanted: [], confidential: ['lead'] })
    expect(marks.allows(grant('lead'))).toBe(false)
    expect(marks.allows(grant('member', 'super:tab'))).toBe(false)
    expect(marks.allows(grant('member'))).toBe(true)
  })
})
