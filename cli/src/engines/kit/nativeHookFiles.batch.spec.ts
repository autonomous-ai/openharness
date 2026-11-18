import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HookPreparationHeld, hookPreparationRoutes, runHookPreparation, type HookPreparationProof } from './nativeHookFiles.js'

const effects = vi.hoisted(() => ({ onStat: undefined as ((file: unknown) => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { effects.onStat?.(args[0]); return fs.lstatSync(...args) } }
})
let root: string
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'native-route-batch-'))) })
afterEach(() => { effects.onStat = undefined; rmSync(root, { recursive: true, force: true }) })

const callers = [
  { name: 'destination routes', reads: 4 },
  { name: 'preparation observations', reads: 8 },
  { name: 'completed proof', reads: 8 },
] as const
type Caller = typeof callers[number]['name']
async function withVerifier(caller: Caller, files: string[], exercise: (verify: () => void) => void): Promise<void> {
  if (caller === 'destination routes') { exercise(hookPreparationRoutes(files).verify); return }
  if (caller === 'preparation observations') {
    await runHookPreparation(files, async attempt => { exercise(attempt.verify) })
    return
  }
  let proof: HookPreparationProof | undefined
  await runHookPreparation(files, async () => {}, { confirmed: value => { proof = value } })
  expect(proof).toBeDefined()
  exercise(() => { if (!proof!.current()) throw new HookPreparationHeld('the completed proof refused changed files') })
}
function siblings() {
  const shared = join(root, 'shared'), displaced = join(root, 'displaced')
  const names = ['one', 'two', 'three']
  const files = names.map(name => {
    const folder = join(shared, name); mkdirSync(folder, { recursive: true })
    const file = join(folder, 'config.json'); writeFileSync(file, '{"kept":true}', { mode: 0o600 }); return file
  })
  return { shared, files,
    replaceAncestor: () => {
      renameSync(shared, displaced); mkdirSync(shared)
      for (const name of names) renameSync(join(displaced, name), join(shared, name))
    },
    aliasAncestor: () => { renameSync(shared, displaced); symlinkSync(displaced, shared) },
  }
}

it.each(callers)('$name shares only provisional sibling reads and starts a fresh pass every time', async ({ name, reads }) => {
  const fixture = siblings()
  await withVerifier(name, fixture.files, verify => {
    let observed = 0
    effects.onStat = file => { if (file === fixture.shared) observed++ }
    try {
      verify(); expect(observed).toBe(reads)
      observed = 0; verify(); expect(observed).toBe(reads)
    } finally { effects.onStat = undefined }
  })
  for (const file of fixture.files) expect(readFileSync(file, 'utf8')).toBe('{"kept":true}')
})

it.each(callers.flatMap(caller => (caller.name === 'destination routes' ? ['replacement', 'alias']
  : ['replacement', 'alias', 'leaf identity', 'leaf bytes', 'leaf mode']).map(change => ({ ...caller, change }))))(
  '$name keeps the final fresh proof after a sibling $change', async ({ name, change }) => {
    const fixture = siblings(); let changed = false
    await expect(withVerifier(name, fixture.files, verify => {
      effects.onStat = file => {
        if (file !== fixture.files[1]) return
        effects.onStat = undefined; changed = true
        if (change === 'replacement') fixture.replaceAncestor()
        else if (change === 'alias') fixture.aliasAncestor()
        else if (change === 'leaf identity') {
          const replacement = join(root, 'replacement'); writeFileSync(replacement, readFileSync(fixture.files[1]), { mode: 0o600 })
          renameSync(replacement, fixture.files[1])
        } else if (change === 'leaf bytes') writeFileSync(fixture.files[1], '{"changed":true}')
        else chmodSync(fixture.files[1], 0o640)
      }
      try { verify() } finally { effects.onStat = undefined }
    })).rejects.toThrow()
    expect(changed).toBe(true)
  },
)

it.each(callers)('$name checks an existing common alias in every walk and final snapshot', async ({ name, reads }) => {
  const fixture = siblings(); fixture.aliasAncestor()
  await withVerifier(name, fixture.files, verify => {
    let observed = 0
    effects.onStat = file => { if (file === fixture.shared) observed++ }
    try { verify(); expect(observed).toBe(reads === 4 ? 6 : 12) }
    finally { effects.onStat = undefined }
  })
})

it.each(callers)('$name gives a nested proof its own provisional reads', async ({ name, reads }) => {
  const fixture = siblings()
  await withVerifier(name, fixture.files, verify => {
    let nested = false, inside = false, nestedReads = 0
    effects.onStat = file => {
      if (inside) { if (file === fixture.shared) nestedReads++; return }
      if (nested || file !== fixture.files[1]) return
      nested = true; inside = true
      try { verify() } finally { inside = false }
      fixture.replaceAncestor()
    }
    try { expect(verify).toThrow(); expect(nested).toBe(true); expect(nestedReads).toBe(reads) }
    finally { effects.onStat = undefined }
    // Keep the callback's expected refusal fatal to the enclosing preparation too.
    throw new HookPreparationHeld('nested proof changed its ancestor')
  }).catch(error => { expect(error).toBeInstanceOf(HookPreparationHeld) })
})

it.each(callers)('$name falls back to fresh provisional reads after 256 directories', async ({ name, reads }) => {
  const branches = ['first', 'second', 'third'].map(branch => join(root, branch, ...Array.from({ length: 90 }, () => 'd')))
  for (const branch of branches) mkdirSync(branch, { recursive: true })
  const files = [...branches.map(branch => join(branch, 'one.json')), join(branches[2], 'two.json')]
  for (const file of files) writeFileSync(file, '{}', { mode: 0o600 })
  await withVerifier(name, files, verify => {
    let observed = 0
    effects.onStat = file => { if (file === branches[2]) observed++ }
    try { verify(); expect(observed).toBe(reads) }
    finally { effects.onStat = undefined }
  })
})

it('runs every custom observation at each original preparation fence', async () => {
  const fixture = siblings(), custom = vi.fn()
  await runHookPreparation(fixture.files, async attempt => {
    attempt.observe('custom observation', custom)
    attempt.verify(); expect(custom).toHaveBeenCalledTimes(1)
    attempt.verify(); expect(custom).toHaveBeenCalledTimes(2)
  })
  expect(custom).toHaveBeenCalledTimes(4)
})
