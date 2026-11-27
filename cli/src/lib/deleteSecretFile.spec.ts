import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// Pass-through, but for the failures a case queues: each delete of a file takes the next one, as an antivirus holding
// the file open on Windows makes it fail (EBUSY) until it lets go.
const disk = vi.hoisted(() => ({ failures: [] as string[], deletes: 0 }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      disk.deletes++
      const code = disk.failures.shift()
      if (code) throw Object.assign(new Error(`${code}: fixture, ${String(args[0])}`), { code })
      return actual.rmSync(...args)
    },
  }
})

const { deleteSecretFile, SecretNotDeleted } = await import('./deleteSecretFile.js')

const dir = mkdtempSync(join(tmpdir(), 'harness-secret-file-'))
const file = join(dir, 'secret.json')
const waits: number[] = []
const wait = (ms: number): void => { waits.push(ms) }

afterEach(() => { Object.assign(disk, { failures: [], deletes: 0 }); waits.length = 0 })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

/** What [run] threw. */
function thrown(run: () => void): Error {
  try { run() } catch (error) { return error as Error }
  throw new Error('it did not throw')
}

describe('deleting a file that holds a secret', () => {
  it('a file it cannot delete is said in the fixed word and the errno, never the path, and stays', () => {
    writeFileSync(file, 'secret')
    disk.failures = ['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY']

    const error = thrown(() => deleteSecretFile(file, 'SECRET_NOT_DELETED', wait))

    expect(error).toBeInstanceOf(SecretNotDeleted)
    expect(error.message).toBe('SECRET_NOT_DELETED (EBUSY)')
    expect(error.message).not.toContain(dir)
    // Bounded: three tries, with two waits between them that add up to about a second.
    expect(disk.deletes).toBe(3)
    expect(waits).toHaveLength(2)
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1_000)
    expect(existsSync(file)).toBe(true)
  })

  it('a file held for a moment is deleted on the next try', () => {
    writeFileSync(file, 'secret')
    disk.failures = ['EBUSY']

    deleteSecretFile(file, 'SECRET_NOT_DELETED', wait)

    expect(existsSync(file)).toBe(false)
    expect(disk.deletes).toBe(2)
    expect(waits).toHaveLength(1)
  })

  it('EPERM, which Windows gives for a file held open as well, is tried again', () => {
    writeFileSync(file, 'secret')
    disk.failures = ['EPERM']

    deleteSecretFile(file, 'SECRET_NOT_DELETED', wait)

    expect(existsSync(file)).toBe(false)
  })

  it('any other failure is said at once, with no wait', () => {
    writeFileSync(file, 'secret')
    disk.failures = ['EACCES']

    expect(() => deleteSecretFile(file, 'SECRET_NOT_DELETED', wait)).toThrow('SECRET_NOT_DELETED (EACCES)')
    expect(disk.deletes).toBe(1)
    expect(waits).toEqual([])
    expect(existsSync(file)).toBe(true)
  })

  it('a failure with no errno is said as UNKNOWN', () => {
    writeFileSync(file, 'secret')
    disk.failures = ['not an errno']

    expect(() => deleteSecretFile(file, 'SECRET_NOT_DELETED', wait)).toThrow('SECRET_NOT_DELETED (UNKNOWN)')
  })

  it('a file already gone is no failure', () => {
    rmSync(file, { force: true })
    disk.deletes = 0

    deleteSecretFile(file, 'SECRET_NOT_DELETED', wait)

    expect(disk.deletes).toBe(1)
  })
})
