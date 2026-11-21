import { appendFileSync, chmodSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HookPreparationHeld, hookPreparationRoutes, inspectHookFile, runHookPreparation, type HookPreparationAttempt, type HookPreparationProof } from './nativeHookFiles.js'

const effects = vi.hoisted(() => ({ onStat: undefined as ((file: unknown) => void) | undefined,
  onStatResult: undefined as ((file: unknown, info: unknown) => unknown) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    effects.onStat?.(args[0]); const info = fs.lstatSync(...args); return effects.onStatResult?.(args[0], info) ?? info
  } }
})
let root: string
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'native-route-batch-'))) })
afterEach(() => { effects.onStat = undefined; effects.onStatResult = undefined; rmSync(root, { recursive: true, force: true }) })

const callers = [
  { name: 'destination routes', reads: 2, missingReads: 2, aliasReads: 2, fallbackReads: 3 },
  { name: 'preparation observations', reads: 2, missingReads: 6, aliasReads: 2, fallbackReads: 7 },
  { name: 'completed proof', reads: 2, missingReads: 6, aliasReads: 2, fallbackReads: 7 },
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

it.each([1, 2])('checks a dependency once per fence through %i preparation levels', async depth => {
  const directory = join(root, 'dependency'); mkdirSync(directory)
  const file = join(directory, 'settings.json'); writeFileSync(file, '{}')
  const dependency = inspectHookFile(file)
  const nested = async (level: number, verify: () => void): Promise<void> => {
    const destination = join(root, `prepared-${level}.json`); writeFileSync(destination, '{}')
    await runHookPreparation([destination], async attempt => {
      if (level < depth) { await nested(level + 1, attempt.verify); return }
      let reads = 0
      effects.onStat = path => { if (path === directory) reads++ }
      try {
        attempt.verify(); expect(reads).toBe(2)
        reads = 0; attempt.verify(); expect(reads).toBe(2)
      } finally { effects.onStat = undefined }
    }, { verify })
  }
  await nested(1, dependency.verify)
})

it.each(['dependency changed', 'owner revoked'] as const)(
  'refuses effects when %s during destination inspection', async change => {
  const fixture = siblings(), dependencyFile = join(root, 'dependency.json')
  writeFileSync(dependencyFile, '{}'); const dependency = inspectHookFile(dependencyFile)
  let owned = true, effect = false, changed = false
  await expect(runHookPreparation(fixture.files, async (attempt: HookPreparationAttempt) => {
    effects.onStat = path => {
      if (path !== fixture.files[0] || changed) return
      changed = true
      if (change === 'dependency changed') appendFileSync(dependencyFile, 'changed during route checks')
      else owned = false
    }
    try { attempt.verify(); effect = true } finally { effects.onStat = undefined }
  }, { verify: dependency.verify, current: () => owned })).rejects.toThrow(/changed/)
  expect(changed).toBe(true); expect(effect).toBe(false)
})

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
  '$name reuses observed ancestry for missing $missing and still starts a fresh pass', async ({ name, reads: fixedReads, missingReads, missing }) => {
    const reads = missing === 'file' ? fixedReads : missingReads
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

it.each(callers)('$name checks an existing common alias at every fresh route fence', async ({ name, aliasReads }) => {
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

it('cannot authorize an effect after an observation is added during verification', async () => {
  const fixture = siblings()
  let inserted = false, effect = false
  await expect(runHookPreparation(fixture.files, async attempt => {
    attempt.observe('inserts a dependency', () => {
      if (inserted) return
      inserted = true
      attempt.observe('new dependency', () => { throw new HookPreparationHeld('the new dependency refused publication') })
    })
    attempt.verify()
    effect = true
  })).rejects.toThrow(/changed|refused/)
  expect(inserted).toBe(true)
  expect(effect).toBe(false)
})

it('cannot authorize an effect after a complete verifier changes during its compiled fence', async () => {
  const fixture = siblings(), extra = join(root, 'extra.json')
  writeFileSync(extra, '{}')
  const replacement = inspectHookFile(extra)
  let reads = 0, changed = false, effect = false
  await expect(runHookPreparation(fixture.files, async attempt => {
    effects.onStat = file => {
      // Change the captured observation during its first fresh metadata pass.
      if (file !== fixture.files[0] || ++reads !== 1) return
      effects.onStat = undefined; changed = true
      attempt.observe(fixture.files[0], replacement.verify)
    }
    try { attempt.verify(); effect = true } finally { effects.onStat = undefined }
  })).rejects.toThrow(/observations changed/)
  expect(changed).toBe(true)
  expect(effect).toBe(false)
})

it('refuses a fallback replacing an observation that its current iteration already visited', async () => {
  const fixture = siblings()
  let changed = false, effect = false
  await expect(runHookPreparation(fixture.files, async attempt => {
    attempt.observe('changes an earlier dependency', () => {
      if (changed) return
      changed = true
      attempt.observe(fixture.files[0], () => { throw new HookPreparationHeld('the replacement refused publication') })
    })
    attempt.verify()
    effect = true
  })).rejects.toThrow(/observations changed/)
  expect(changed).toBe(true)
  expect(effect).toBe(false)
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


it('checks a shared existing alias exactly twice for a complete destination set', () => {
  const fixture = siblings(); fixture.aliasAncestor()
  const routes = hookPreparationRoutes(fixture.files)
  for (let pass = 0; pass < 2; pass++) {
    let reads = 0
    effects.onStat = path => { if (path === fixture.shared) reads++ }
    try { routes.verify(); expect(reads).toBe(2) }
    finally { effects.onStat = undefined }
  }
})

it.each(['present', 'absent'] as const)('refuses a new destination alias after capturing a %s leaf', state => {
  const fixture = siblings(), file = fixture.files[0], target = join(root, 'peer.json')
  writeFileSync(target, '{}')
  if (state === 'absent') rmSync(file)
  const routes = hookPreparationRoutes(fixture.files)
  rmSync(file, { force: true }); symlinkSync(target, file)
  expect(() => routes.verify()).toThrow(/alias|route changed/)
})

it.each(['replacement', 'appearance', 'disappearance', 'mode'] as const)('refuses leaf %s between the two destination checks', change => {
  const fixture = siblings(), file = fixture.files[0]
  if (change === 'appearance') rmSync(file)
  const routes = hookPreparationRoutes(fixture.files)
  let changed = false
  effects.onStat = path => {
    if (path !== fixture.files[1] || changed) return
    changed = true
    if (change === 'disappearance') rmSync(file)
    else if (change === 'mode') chmodSync(file, 0o640)
    else {
      const next = join(root, 'next.json'); writeFileSync(next, '{}')
      renameSync(next, file)
    }
  }
  try { expect(() => routes.verify()).toThrow(/changed/); expect(changed).toBe(true) }
  finally { effects.onStat = undefined }
})

it('allows an ordinary missing leaf to be created between destination checks', () => {
  const fixture = siblings(), file = fixture.files[0]
  rmSync(file); const routes = hookPreparationRoutes(fixture.files)
  routes.verify(); writeFileSync(file, '{}')
  expect(() => routes.verify()).not.toThrow()
})


it('never adopts replacement ancestry from newer observations', async () => {
  const fixture = siblings()
  await expect(runHookPreparation(fixture.files, async attempt => {
    fixture.replaceAncestor()
    for (const file of fixture.files) attempt.observe(file, inspectHookFile(file).verify)
    attempt.verify()
  })).rejects.toThrow(/changed/)
})

it('retains the reserved route when observations cover a different destination', async () => {
  const fixture = siblings(), other = join(root, 'other.json')
  writeFileSync(other, '{}')
  const observed = inspectHookFile(other)
  await expect(runHookPreparation(fixture.files, async attempt => {
    for (const file of fixture.files) attempt.observe(file, observed.verify)
    fixture.aliasAncestor()
    attempt.verify()
  })).rejects.toThrow(/changed/)
})

it('checks the original route before invoking a custom observation', async () => {
  const fixture = siblings(), custom = vi.fn()
  await expect(runHookPreparation(fixture.files, async attempt => {
    attempt.observe('custom', custom)
    fixture.replaceAncestor()
    attempt.verify()
  })).rejects.toThrow(/changed/)
  expect(custom).not.toHaveBeenCalled()
})

it.each(['preparation observations', 'completed proof'] as const)('%s uses two fresh passes for a single existing destination', async caller => {
  const fixture = siblings()
  await withVerifier(caller, [fixture.files[0]], verify => {
    let ancestors = 0, leaves = 0
    effects.onStat = file => { if (file === fixture.shared) ancestors++; if (file === fixture.files[0]) leaves++ }
    try {
      verify(); expect(ancestors).toBe(2); expect(leaves).toBe(2)
      ancestors = 0; leaves = 0
      verify(); expect(ancestors).toBe(2); expect(leaves).toBe(2)
    } finally { effects.onStat = undefined }
  })
})

it.each([1, 2])('preserves the reserved-leaf alias refusal during pass %i', async pass => {
  const fixture = siblings(), target = join(root, 'new-target.json'); writeFileSync(target, '{}')
  let reads = 0, changed = false
  const refused = await runHookPreparation(fixture.files, async attempt => {
    effects.onStat = file => {
      if (file !== fixture.files[0] || ++reads !== pass) return
      effects.onStat = undefined; changed = true
      rmSync(fixture.files[0]); symlinkSync(target, fixture.files[0])
    }
    try { attempt.verify() } finally { effects.onStat = undefined }
  }).then(() => undefined, error => error)
  expect(changed).toBe(true)
  expect(refused).toBeInstanceOf(HookPreparationHeld)
  expect(refused.reason).toBe('the reserved destination route changed')
})

it.each(['direct observation', 'alias version'] as const)('retains the original alias after a newer %s', async change => {
  const fixture = siblings(); fixture.aliasAncestor()
  await expect(runHookPreparation(fixture.files, async attempt => {
    if (change === 'alias version') lutimesSync(fixture.shared, 1, 1)
    for (const file of fixture.files) {
      const source = change === 'direct observation' ? file.replace(fixture.shared, join(root, 'displaced')) : file
      attempt.observe(file, inspectHookFile(source).verify)
    }
    if (change === 'direct observation') {
      rmSync(fixture.shared); symlinkSync(join(root, 'unconfirmed'), fixture.shared)
    }
    attempt.verify()
  })).rejects.toThrow(/changed/)
})

it.each((['preparation observations', 'completed proof'] as const).flatMap(caller => [1, 2].map(pass => ({ caller, pass }))))(
  '$caller refuses a device-only ancestor change on pass $pass', async ({ caller, pass }) => {
    const fixture = siblings(); let reads = 0
    await expect(withVerifier(caller, fixture.files, verify => {
      effects.onStatResult = (file, raw) => {
        if (file !== fixture.shared || ++reads !== pass) return raw
        const info = raw as { dev: bigint }
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { dev: info.dev + 1n })
      }
      try { verify() } finally { effects.onStatResult = undefined }
    })).rejects.toThrow(/changed/)
    expect(reads).toBe(2)
  },
)

it('checks the reserved ancestry even when a combined observation includes extra files', async () => {
  const fixture = siblings(), extra = join(root, 'extra.json'); writeFileSync(extra, '{}')
  await expect(runHookPreparation(fixture.files, async attempt => {
    attempt.observe(extra, inspectHookFile(extra).verify)
    let reads = 0
    effects.onStat = file => { if (file === fixture.shared) reads++ }
    try { attempt.verify(); expect(reads).toBe(2) } finally { effects.onStat = undefined }
    fixture.replaceAncestor()
    attempt.verify()
  })).rejects.toThrow(/changed/)
})
