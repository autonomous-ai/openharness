import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HookPreparationHeld, hookPreparationRoutes, inspectHookFile, runHookPreparation, type HookPreparationProof } from './nativeHookFiles.js'

const effects = vi.hoisted(() => ({ onStat: undefined as ((file: unknown) => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { effects.onStat?.(args[0]); return fs.lstatSync(...args) } }
})
let root: string
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'native-route-batch-'))) })
afterEach(() => { effects.onStat = undefined; rmSync(root, { recursive: true, force: true }) })

const callers = [
  { name: 'destination routes', reads: 2, aliasReads: 4, fallbackReads: 3 },
  { name: 'preparation observations', reads: 6, aliasReads: 10, fallbackReads: 7 },
  { name: 'completed proof', reads: 6, aliasReads: 10, fallbackReads: 7 },
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

it.each(callers.flatMap(caller => ['file', 'parents'].map(missing => ({ ...caller, missing }))))(
  '$name reuses observed ancestry for missing $missing and still starts a fresh pass', async ({ name, reads, missing }) => {
    const fixture = siblings()
    for (const file of fixture.files) rmSync(missing === 'file' ? file : dirname(file), { recursive: true })
    const files = missing === 'file' ? fixture.files : fixture.files.map(file => join(dirname(file), 'unwritten/deeper/config.json'))
    await withVerifier(name, files, verify => {
      let observed = 0
      effects.onStat = file => { if (file === fixture.shared) observed++ }
      try {
        verify(); expect(observed).toBe(reads)
        observed = 0; verify(); expect(observed).toBe(reads)
      } finally { effects.onStat = undefined }
    })
    expect(hookPreparationRoutes(files).keys).toEqual([...files].sort())
  },
)

it.each(callers)('$name preserves canonical keys through an alias with missing descendants', async ({ name }) => {
  const fixture = siblings(); fixture.aliasAncestor()
  for (const file of fixture.files) rmSync(dirname(file), { recursive: true })
  const files = fixture.files.map(file => join(dirname(file), 'unwritten/deeper/config.json'))
  await withVerifier(name, files, verify => { verify() })
  expect(hookPreparationRoutes(files).keys).toEqual(files.map(file => file.replace(fixture.shared, join(root, 'displaced'))).sort())
})

it.skipIf(process.platform === 'win32')('verifies a settings file whose canonical parent is the root', () => {
  const alias = join(root, 'root-alias'), name = `${basename(root)}-absent.json`
  symlinkSync('/', alias)
  const file = join(alias, name)
  const observed = inspectHookFile(file)
  expect(observed.directory).toBe('/')
  expect(() => observed.verify()).not.toThrow()
  const routes = hookPreparationRoutes([file])
  expect(routes.keys).toEqual([join('/', name)])
  expect(() => routes.verify()).not.toThrow()
})

it.skipIf(process.platform === 'win32')('accepts a newly created descendant after a parent fallback reached the root', () => {
  const alias = join(root, 'root-alias'), name = `${basename(root)}-absent`
  symlinkSync('/', alias)
  const file = join(alias, 'usr', name, 'config.json')
  // Simulate the ancestor appearing between proofs without writing outside the private fixture.
  effects.onStat = path => { if (path === '/usr') throw Object.assign(new Error('missing fixture ancestor'), { code: 'ENOENT' }) }
  let observed: ReturnType<typeof inspectHookFile>, routes: ReturnType<typeof hookPreparationRoutes>
  try { observed = inspectHookFile(file); routes = hookPreparationRoutes([file]) }
  finally { effects.onStat = undefined }
  expect(() => observed.verify()).not.toThrow()
  expect(() => routes.verify()).not.toThrow()
  expect(routes.keys).toEqual([join('/usr', name, 'config.json')])
})

it.skipIf(process.platform === 'win32')('retains the refusal for an absent file with no observed non-root ancestor', () => {
  expect(() => inspectHookFile(join('/', `${basename(root)}-absent.json`))).toThrow(/retained route/)
})

it.each([{ depth: 128, held: false }, { depth: 181, held: true }])(
  'bounds a missing-parent fallback with $depth existing and missing levels', ({ depth, held }) => {
    const existing = join(root, ...Array.from({ length: depth }, () => 'd'))
    mkdirSync(existing, { recursive: true })
    const file = join(existing, ...Array.from({ length: depth }, () => 'missing'), 'config.json')
    const routes = hookPreparationRoutes([file])
    if (held) expect(() => routes.verify()).toThrow(/work limit/)
    else expect(() => routes.verify()).not.toThrow()
  },
)

it.each([...callers.map(caller => caller.name), 'file observation' as const].flatMap(name =>
  (['replacement', 'alias'] as const).map(change => ({ name, change }))))(
  '$name checks missing-parent ancestry again after a sibling $change', async ({ name, change }) => {
  const fixture = siblings()
  for (const file of fixture.files) rmSync(dirname(file), { recursive: true })
  let changed = false
  const exercise = (verify: () => void) => {
    effects.onStat = file => {
      if (file !== dirname(fixture.files[name === 'file observation' ? 0 : 1])) return
      effects.onStat = undefined; changed = true
      if (change === 'alias') fixture.aliasAncestor()
      else {
        renameSync(fixture.shared, join(root, 'displaced'))
        mkdirSync(fixture.shared)
      }
    }
    try { verify() } finally { effects.onStat = undefined }
  }
  const checking = name === 'file observation'
    ? Promise.resolve().then(() => exercise(inspectHookFile(fixture.files[0]).verify))
    : withVerifier(name, fixture.files, exercise)
  await expect(checking).rejects.toThrow(/changed/)
  expect(changed).toBe(true)
  },
)

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

it.each(callers)('$name checks an existing common alias in every walk and grouped final snapshot', async ({ name, aliasReads }) => {
  const fixture = siblings(); fixture.aliasAncestor()
  await withVerifier(name, fixture.files, verify => {
    let observed = 0
    effects.onStat = file => { if (file === fixture.shared) observed++ }
    try { verify(); expect(observed).toBe(aliasReads) }
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

it.each(callers)('$name falls back to fresh provisional reads after 256 directories', async ({ name, fallbackReads }) => {
  const branches = ['first', 'second', 'third'].map(branch => join(root, branch, ...Array.from({ length: 90 }, () => 'd')))
  for (const branch of branches) mkdirSync(branch, { recursive: true })
  const files = [...branches.map(branch => join(branch, 'one.json')), join(branches[2], 'two.json')]
  for (const file of files) writeFileSync(file, '{}', { mode: 0o600 })
  await withVerifier(name, files, verify => {
    let observed = 0
    effects.onStat = file => { if (file === branches[2]) observed++ }
    try { verify(); expect(observed).toBe(fallbackReads) }
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

it('checks an earlier private directory after the final sibling walk', () => {
  const fixture = siblings(), routes = hookPreparationRoutes(fixture.files)
  let changed = false
  effects.onStat = file => {
    if (file !== fixture.files[2]) return
    effects.onStat = undefined; changed = true
    const first = join(fixture.shared, 'one'), moved = join(root, 'old-one')
    renameSync(first, moved); mkdirSync(first)
    renameSync(join(moved, 'config.json'), fixture.files[0])
  }
  expect(() => routes.verify()).toThrow(/changed/)
  expect(changed).toBe(true)
})
