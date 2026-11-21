import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectHookFile, hookFileVerifier } from './nativeHookFiles.js'
import { statusLineScript } from './statusLine.js'
const effects = vi.hoisted(() => ({ onStat: undefined as ((file: unknown) => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { effects.onStat?.(args[0]); return fs.lstatSync(...args) } }
})
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'optional-source-proof-')) })
afterEach(() => { effects.onStat = undefined; rmSync(root, { recursive: true, force: true }) })
function capture(paths: string[]) {
  const observations = paths.map(file => ({ observed: inspectHookFile(file) }))
  const verify = hookFileVerifier(observations)
  return { current: () => { try { verify(); return true } catch { return false } } }
}
describe('one synchronous source-verification pass', () => {
  it.each([false, true])('checks complete sibling sources in two fresh route passes (alias=%s)', alias => {
    const shared = join(realpathSync(root), 'complete'), selected = join(realpathSync(root), 'selected')
    mkdirSync(shared)
    if (alias) symlinkSync(shared, selected)
    const files = ['one.json', 'two.json', 'three.json'].map(name => {
      writeFileSync(join(shared, name), '{}')
      return join(alias ? selected : shared, name)
    })
    const prepared = capture(files)
    for (let call = 0; call < 2; call++) {
      let sharedReads = 0, aliasReads = 0
      effects.onStat = file => { if (file === shared) sharedReads++; if (file === selected) aliasReads++ }
      try {
        expect(prepared.current()).toBe(true)
        expect(sharedReads).toBe(2)
        expect(aliasReads).toBe(alias ? 2 : 0)
      } finally { effects.onStat = undefined }
    }
    writeFileSync(join(shared, 'one.json'), 'changed')
    expect(prepared.current()).toBe(false)
  })

  it('refuses conflicting observations of the same complete source', () => {
    const file = join(root, 'conflict.json')
    writeFileSync(file, 'first')
    const first = inspectHookFile(file)
    const replacement = join(root, 'replacement.json')
    writeFileSync(replacement, 'second'); renameSync(replacement, file)
    const second = inspectHookFile(file)
    expect(hookFileVerifier([{ observed: first }, { observed: second }])).toThrow(/changed/)
    expect(readFileSync(file, 'utf8')).toBe('second')
  })

  it.each(['replacement', 'alias'] as const)('checks common ancestry after a later source read causes a %s', change => {
    const shared = join(realpathSync(root), 'late'), displaced = join(realpathSync(root), 'displaced')
    mkdirSync(shared)
    const names = ['one', 'two', 'three']
    const files = names.map(name => {
      const folder = join(shared, name); mkdirSync(folder)
      const file = join(folder, 'config.json'); writeFileSync(file, '{}'); return file
    })
    const prepared = capture(files)
    let reads = 0, changed = false
    effects.onStat = file => {
      if (file !== files[1] || ++reads !== 2) return
      changed = true; effects.onStat = undefined
      renameSync(shared, displaced)
      if (change === 'alias') symlinkSync(displaced, shared)
      else { mkdirSync(shared); for (const name of names) renameSync(join(displaced, name), join(shared, name)) }
    }
    expect(prepared.current()).toBe(false)
    expect(changed).toBe(true)
    for (const file of files) expect(readFileSync(file, 'utf8')).toBe('{}')
  })

  function sharedSources() {
    const shared = join(realpathSync(root), 'shared'), displaced = join(realpathSync(root), 'displaced')
    const folders = ['data', '.codex', 'work']
    for (const folder of folders) mkdirSync(join(shared, folder), { recursive: true })
    writeFileSync(join(shared, 'data', 'agent-settings.json'), '{}')
    const profile = join(shared, '.codex', 'config.toml')
    writeFileSync(profile, 'developer_instructions = "Keep mine."\n')
    return { shared, profile,
      capture: () => capture([join(shared, 'data', 'agent-settings.json'), profile, join(shared, 'work', '.codex', 'config.toml')]),
      replaceAncestor: () => {
        renameSync(shared, displaced); mkdirSync(shared)
        // Move the children intact: every source leaf and child directory keeps its identity.
        for (const folder of folders) renameSync(join(displaced, folder), join(shared, folder))
      },
      aliasAncestor: () => { renameSync(shared, displaced); symlinkSync(displaced, shared) },
    }
  }

  it('reads a common directory provisionally once, then freshly for each source, with a new pass on every call', async () => {
    const fixture = sharedSources(), prepared = await fixture.capture()
    expect(prepared).not.toBeNull()
    let reads = 0
    effects.onStat = file => { if (file === fixture.shared) reads++ }
    expect(prepared!.current()).toBe(true)
    expect(reads).toBe(4) // One provisional walk plus the three uncached source snapshots.
    reads = 0
    expect(prepared!.current()).toBe(true)
    expect(reads).toBe(4)
    effects.onStat = undefined
    fixture.replaceAncestor()
    expect(prepared!.current()).toBe(false)
  })

  it.each(['replacement', 'alias', 'same-byte leaf'] as const)('rejects a %s after an earlier source has checked the common ancestor', async change => {
    const fixture = sharedSources(), prepared = await fixture.capture()
    expect(prepared).not.toBeNull()
    let changed = false
    effects.onStat = file => {
      if (file !== fixture.profile) return
      effects.onStat = undefined; changed = true
      if (change === 'replacement') fixture.replaceAncestor()
      else if (change === 'alias') fixture.aliasAncestor()
      else {
        const replacement = join(root, 'replacement.toml')
        writeFileSync(replacement, readFileSync(fixture.profile)); renameSync(replacement, fixture.profile)
      }
    }
    expect(prepared!.current()).toBe(false)
    expect(changed).toBe(true)
    expect(readFileSync(fixture.profile, 'utf8')).toBe('developer_instructions = "Keep mine."\n')
  })

  it('never retains an absent ancestor across passes or accepts an inserted alias', async () => {
    const fixture = sharedSources(), prepared = await fixture.capture()
    expect(prepared!.current()).toBe(true)
    const target = join(root, 'other-config'); mkdirSync(target)
    symlinkSync(target, join(fixture.shared, 'work', '.codex'))
    expect(prepared!.current()).toBe(false)
  })

  it('reads an existing common alias afresh in every source walk and snapshot', async () => {
    const fixture = sharedSources()
    fixture.aliasAncestor()
    const prepared = await fixture.capture()
    expect(prepared).not.toBeNull()
    let reads = 0
    effects.onStat = file => { if (file === fixture.shared) reads++ }
    expect(prepared!.current()).toBe(true)
    expect(reads).toBe(6)
  })

  it.each([false, true])('gives nested verification an independent pass and retains outer freshness (mutate=%s)', async mutate => {
    const fixture = sharedSources(), prepared = await fixture.capture()
    expect(prepared).not.toBeNull()
    let nested = false, nestedReads = 0, inside = false
    effects.onStat = file => {
      if (inside) { if (file === fixture.shared) nestedReads++; return }
      if (nested || file !== fixture.profile) return
      nested = true; inside = true
      expect(prepared!.current()).toBe(true)
      inside = false
      if (mutate) fixture.replaceAncestor()
    }
    expect(prepared!.current()).toBe(!mutate)
    expect(nested).toBe(true)
    expect(nestedReads).toBe(4)
  })

  it('falls back to fresh reads after 256 provisional directories without refusing valid sources', async () => {
    const branch = (name: string) => join(realpathSync(root), name, ...Array.from({ length: 90 }, () => 'd'))
    const data = branch('data'), home = branch('home'), workspace = branch('work')
    for (const directory of [data, home, workspace]) mkdirSync(directory, { recursive: true })
    mkdirSync(join(data, 'statusline')); writeFileSync(join(data, 'statusline', 'statusline.mjs'), statusLineScript())
    const prepared = capture([join(data, 'agent-settings.json'), join(home, 'settings.json'), join(workspace, '.claude', 'settings.json'), join(workspace, '.claude', 'settings.local.json')])
    expect(prepared).not.toBeNull()
    let reads = 0
    effects.onStat = file => { if (file === workspace) reads++ }
    expect(prepared!.current()).toBe(true)
    // This late directory is beyond the cap: both project sources walk and verify it freshly.
    expect(reads).toBe(4)
  })
})
