import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HookPreparationHeld, hookFileVerifier, inspectHookFile, runHookPreparation, type HookPreparationProof } from './nativeHookFiles.js'

const effects = vi.hoisted(() => ({ stat: undefined as ((file: string) => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { effects.stat?.(String(args[0])); return fs.lstatSync(...args) } }
})
let root: string
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-absent-fence-'))) })
afterEach(() => { effects.stat = undefined; rmSync(root, { recursive: true, force: true }) })
const callers = ['optional', 'attempt', 'completed'] as const
type Caller = typeof callers[number]
async function withVerifier(caller: Caller, files: string[], use: (verify: () => void) => void) {
  if (caller === 'optional') { use(hookFileVerifier(files.map(file => ({ observed: inspectHookFile(file) })))); return }
  if (caller === 'attempt') { await runHookPreparation(files, async attempt => { use(attempt.verify) }); return }
  let proof: HookPreparationProof | undefined
  await runHookPreparation(files, async () => {}, { confirmed: value => { proof = value } })
  expect(proof).toBeDefined()
  use(() => { if (!proof!.current()) throw new Error('completed observation refused') })
}
function fixture(existing = false) {
  const shared = join(root, 'shared'), names = ['one', 'two', 'three']
  const files = names.map(name => {
    const file = join(shared, name, 'settings.json'); mkdirSync(dirname(file), { recursive: true })
    if (existing) writeFileSync(file, '{}', { mode: 0o600 })
    return file
  })
  return { shared, files, names }
}

it.each(callers.flatMap(caller => ['all absent', 'mixed', 'single absent'].map(shape => ({ caller, shape }))))(
  '$caller checks fixed $shape leaves with two fresh shared passes', async ({ caller, shape }) => {
    const group = fixture(shape === 'mixed')
    if (shape === 'mixed') rmSync(group.files[1])
    const files = shape === 'single absent' ? [group.files[0]] : group.files
    await withVerifier(caller, files, verify => {
      const reads = new Map<string, number>()
      effects.stat = file => { reads.set(file, (reads.get(file) ?? 0) + 1) }
      try {
        for (let call = 0; call < 2; call++) {
          reads.clear(); verify()
          expect(reads.get(group.shared)).toBe(caller === 'optional' ? 2 : 4)
          const absent = shape === 'mixed' ? files[1] : files[0]
          expect(reads.get(absent)).toBe(caller === 'optional' ? 2 : 4)
        }
      } finally { effects.stat = undefined }
    })
  },
)

it.each(callers.flatMap(caller => ['file', 'directory', 'dangling alias', 'file alias'].map(change => ({ caller, change }))))(
  '$caller refuses an absent leaf becoming a $change', async ({ caller, change }) => {
    const group = fixture()
    const refused = await withVerifier(caller, group.files, verify => {
      const file = group.files[1]
      if (change === 'file') writeFileSync(file, '{}', { mode: 0o600 })
      else if (change === 'directory') mkdirSync(file)
      else {
        const target = join(root, 'other-file')
        if (change === 'file alias') writeFileSync(target, '{}', { mode: 0o600 })
        symlinkSync(target, file)
      }
      verify()
    }).then(() => undefined, error => error)
    const reason = change.includes('alias') ? caller === 'optional'
      ? 'the settings route gained an unconfirmed alias' : 'the reserved destination route changed'
      : 'the settings file changed before publication'
    expect(refused).toBeInstanceOf(caller === 'completed' ? Error : HookPreparationHeld)
    expect(refused).toMatchObject(caller === 'completed' ? { message: 'completed observation refused' }
      : { name: 'HookPreparationHeld', reason, message: `Hook preparation is waiting: ${reason}` })
  },
)

it.each(callers.flatMap(caller => ['replacement', 'alias'].map(change => ({ caller, change }))))(
  '$caller checks shared ancestry after the final missing-leaf read and a $change', async ({ caller, change }) => {
    const group = fixture(), displaced = join(root, 'displaced')
    let changed = false, reads = 0
    await expect(withVerifier(caller, group.files, verify => {
      effects.stat = file => {
        if (file !== group.files[1] || ++reads !== (caller === 'optional' ? 2 : 4)) return
        effects.stat = undefined; changed = true
        renameSync(group.shared, displaced)
        if (change === 'alias') symlinkSync(displaced, group.shared)
        else { mkdirSync(group.shared); for (const name of group.names) renameSync(join(displaced, name), join(group.shared, name)) }
      }
      try { verify() } finally { effects.stat = undefined }
    })).rejects.toThrow()
    expect(changed).toBe(true)
  },
)

it.each(callers)('%s keeps missing-parent creation on the original observation path', async caller => {
  const group = fixture()
  for (const file of group.files) rmSync(dirname(file), { recursive: true })
  await withVerifier(caller, group.files, verify => {
    for (const file of group.files) mkdirSync(dirname(file))
    verify(); verify()
  })
})

it.each(callers)('%s shares absent-leaf evidence across existing aliases', async caller => {
  const group = fixture(), alias = join(root, 'alias')
  symlinkSync(group.shared, alias)
  const files = [group.files[0], join(alias, 'one', 'settings.json'), join(alias, 'two', 'settings.json')]
  await withVerifier(caller, files, verify => {
    let reads = 0
    effects.stat = file => { if (file === group.shared) reads++ }
    try { verify(); expect(reads).toBe(caller === 'optional' ? 2 : 4) }
    finally { effects.stat = undefined }
  })
})

it.each(callers)('%s refuses a file created after the first absent-leaf pass', async caller => {
  const group = fixture(); let changed = false, reads = 0, effect = false
  const refused = await withVerifier(caller, group.files, verify => {
    effects.stat = file => {
      if (file !== group.files[1] || ++reads !== (caller === 'optional' ? 1 : 3)) return
      effects.stat = undefined; changed = true
      writeFileSync(group.files[0], '{}', { mode: 0o600 })
    }
    try { verify(); effect = true } finally { effects.stat = undefined }
  }).then(() => undefined, error => error)
  expect(refused).toBeInstanceOf(caller === 'completed' ? Error : HookPreparationHeld)
  expect(refused).toMatchObject(caller === 'completed' ? { message: 'completed observation refused' }
    : { name: 'HookPreparationHeld', reason: 'the settings file changed before publication' })
  expect(changed).toBe(true); expect(effect).toBe(false)
})

it.each(callers)('%s keeps full existing-file versions in a mixed group', async caller => {
  const group = fixture(true); rmSync(group.files[1])
  await expect(withVerifier(caller, group.files, verify => {
    writeFileSync(group.files[0], '{"changed":true}', { mode: 0o600 })
    verify()
  })).rejects.toThrow()
})
