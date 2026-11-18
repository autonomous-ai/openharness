import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtempSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stoppedArchiveWitness } from './stoppedAuthorityMetadata.js'
import { sessionFileIdentity } from './sessionStorageWire.js'

vi.mock('node:fs', async original => ({ ...await original<object>() }))

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'stopped-authority-'))
  roots.push(root)
  const directory = join(root, 'stopped-agents')
  mkdirSync(directory, { mode: 0o700 })
  return directory
}

describe('stopped archive authority metadata', () => {
  it('detects a nonmatching archive changed in place without a directory version change', async () => {
    const directory = fixture(), file = join(directory, 'other.json')
    writeFileSync(file, JSON.stringify({ sessionId: 'other' }), { mode: 0o600 })
    const directoryBefore = sessionFileIdentity(lstatSync(directory, { bigint: true }))
    const witness = stoppedArchiveWitness(directory)
    // The awaited preparation can change a previously nonmatching row into the selected conversation.
    await Promise.resolve().then(() => writeFileSync(file, JSON.stringify({ sessionId: 'asked' })))
    expect(sessionFileIdentity(lstatSync(directory, { bigint: true }))).toBe(directoryBefore)
    expect(stoppedArchiveWitness(directory)).not.toBe(witness)
  })

  it('detects atomic replacement and new archives, including creation after absence', () => {
    const directory = fixture(), file = join(directory, 'other.json'), temporary = join(directory, 'temporary')
    writeFileSync(file, '{}', { mode: 0o600 })
    const witness = stoppedArchiveWitness(directory)
    writeFileSync(temporary, '{}', { mode: 0o600 }); renameSync(temporary, file)
    expect(stoppedArchiveWitness(directory)).not.toBe(witness)
    const missing = join(directory, 'absent')
    expect(stoppedArchiveWitness(missing)).toBe('missing')
    mkdirSync(missing, { mode: 0o700 })
    expect(stoppedArchiveWitness(missing)).not.toBe('missing')
  })

  it('ignores its own temporary and reservation files while JSON membership changes still revoke authority', () => {
    const directory = fixture(), row = join(directory, 'one.json')
    writeFileSync(row, '{}', { mode: 0o600 })
    const before = stoppedArchiveWitness(directory)
    const temporary = join(directory, 'one.json.transaction.tmp'), reservation = join(directory, 'one.resume')
    writeFileSync(temporary, '', { mode: 0o600 }); writeFileSync(reservation, '{}', { mode: 0o600 })
    expect(stoppedArchiveWitness(directory)).toBe(before)
    renameSync(row, join(directory, 'renamed.json'))
    const renamed = stoppedArchiveWitness(directory)
    expect(renamed).not.toBe(before)
    writeFileSync(row, '{}', { mode: 0o600 })
    expect(stoppedArchiveWitness(directory)).not.toBe(renamed)
    rmSync(row)
    expect(stoppedArchiveWitness(directory)).toBe(renamed)
  })

  it('refuses directory replacement during its bounded scan', () => {
    const directory = fixture()
    writeFileSync(join(directory, 'one.json'), '{}', { mode: 0o600 })
    const open = fs.opendirSync
    vi.spyOn(fs, 'opendirSync').mockImplementation((...args) => {
      const dir = open(...args), read = dir.readSync.bind(dir)
      let replaced = false
      dir.readSync = () => {
        const entry = read()
        if (!replaced) {
          replaced = true
          renameSync(directory, directory + '-prior')
          mkdirSync(directory, { mode: 0o700 })
        }
        return entry
      }
      return dir
    })
    expect(() => stoppedArchiveWitness(directory)).toThrow()
  })

  it('refuses excessive work and elapsed budget without a partial authority answer', () => {
    const directory = fixture()
    writeFileSync(join(directory, 'one.json'), '{}', { mode: 0o600 })
    expect(() => stoppedArchiveWitness(directory, { entries: 0 })).toThrow('expired')
    let tick = 0
    expect(() => stoppedArchiveWitness(directory, { milliseconds: 1, now: () => tick++ })).toThrow('expired')
    expect(stoppedArchiveWitness(directory)).toMatch(/^[a-f0-9]{64}$/)
  })
})
