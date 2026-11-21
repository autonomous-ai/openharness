import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths, verifyNativePathFacts } from './nativePaths.js'
import { hookPreparationRoutes, inspectHookFile } from './nativeHookFiles.js'
import { observeNativeFiles } from './nativeFileObservation.js'

const observed = vi.hoisted(() => ({ missingErrors: 0, missingReturns: 0, reads: 0,
  fault: undefined as { path: string; code: string } | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    observed.reads++
    if (observed.fault?.path === String(args[0])) throw Object.assign(new Error('fixture refusal'), { code: observed.fault.code })
    try {
      const info = fs.lstatSync(...args)
      if (info === undefined) observed.missingReturns++
      return info
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') observed.missingErrors++
      throw error
    }
  } }
})
let root: string, file: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-absence-')))
  file = join(root, 'missing')
  observed.missingErrors = 0; observed.missingReturns = 0; observed.reads = 0
})
afterEach(() => { observed.fault = undefined; rmSync(root, { recursive: true, force: true }) })

function routes() {
  const paths = new NativePaths(new NativeEvidenceBudget())
  paths.resolveSync(file, true)
  return paths
}
const fences = {
  retained: () => routes().retain(),
  saved: () => { const facts = routes().snapshot(); return () => verifyNativePathFacts(facts) },
  settings: () => inspectHookFile(file).verify,
  reservation: () => hookPreparationRoutes([file, file + '-peer']).verify,
  database: () => {
    const database = join(root, 'state.db'); writeFileSync(database, 'history', { mode: 0o600 })
    return observeNativeFiles([{ path: database }, { path: file, missingOkay: true }]).verify
  },
}
it.each(Object.keys(fences) as (keyof typeof fences)[])('%s checks absence afresh without constructing missing-file errors', kind => {
  const verify = fences[kind]()
  verify(); const before = observed.missingReturns
  verify()
  expect(observed.missingReturns).toBeGreaterThan(before)
  expect(observed.missingErrors).toBe(0)
  // A reservation permits a new ordinary destination, but never a new alias.
  if (kind !== 'reservation') {
    writeFileSync(file, 'appeared', { mode: 0o600 })
    expect(verify).toThrow(/changed/)
  }
})

it('does not turn a non-directory parent into an absent saved fact', () => {
  writeFileSync(file, 'ordinary file')
  expect(() => verifyNativePathFacts([{ path: join(file, 'child'), identity: null }])).toThrow(/unreadable/)
})
it.each(['EACCES', 'EPERM', 'EIO', 'ENOTDIR'])('keeps %s as a failed observation at every fence', code => {
  const checks = Object.values(fences).map(make => make())
  observed.fault = { path: file, code }
  for (const check of checks) expect(check).toThrow()
  expect(() => routes()).toThrow(/could not be inspected/)
})
it('still checks present leaf contents', () => {
  const folder = join(root, 'folder'); mkdirSync(folder)
  const database = join(folder, 'state.db'); writeFileSync(database, 'history', { mode: 0o600 })
  const proof = observeNativeFiles([{ path: database }, { path: file, missingOkay: true }])
  appendFileSync(database, 'new history')
  expect(proof.verify).toThrow(/changed/)
})
