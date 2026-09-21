import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCandidateArtifact, newestArtifact } from './artifacts.js'
import { bundledDshRegistry, resetBundledDshRegistry } from './registry.js'
import { resolveInstallSource } from './install.js'

describe('newestArtifact', () => {
  let workspace: string
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'dsh-art-')) })
  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  const touch = (rel: string, at: number): void => {
    const path = join(workspace, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'x')
    utimesSync(path, at, at)
  }

  it('picks the most recently modified file with a wanted extension, skipping generated trees', () => {
    touch('models/old.step', 1_000)
    touch('models/new.STEP', 3_000)
    touch('notes.txt', 9_000)
    touch('node_modules/lib/newest.step', 9_000)
    touch('__cadgen__/cache.step', 9_000)
    touch('.hidden/x.step', 9_000)
    touch('models/.new.STEP.glb', 9_000)
    expect(newestArtifact(workspace, ['.step', '.stl', '.glb'])?.path).toBe('models/new.STEP')
    expect(newestArtifact(workspace, ['.glb'])).toBeNull()
    expect(newestArtifact(workspace, [])).toBeNull()
  })

  it('walks six directories deep and no deeper', () => {
    touch('1/2/3/4/5/6/deep.step', 1_000)
    touch('1/2/3/4/5/6/7/deeper.step', 9_000)
    expect(newestArtifact(workspace, ['.step'])?.path).toBe('1/2/3/4/5/6/deep.step')
  })

  it('stops looking once it has seen its bound of entries, directories included', () => {
    touch('only/model.step', 1_000)
    // the directory is the one entry the bound allows; its contents are past it
    expect(newestArtifact(workspace, ['.step'], 0)).toBeNull()
    expect(newestArtifact(workspace, ['.step'], 1)?.path).toBe('only/model.step')
    rmSync(join(workspace, 'only'), { recursive: true })
    touch('a.txt', 1_000)
    touch('b.txt', 1_000)
    touch('c.step', 1_000)
    // three files and a bound of one: two are looked at and the walk stops before the third; a bound
    // of two sees all three
    expect(newestArtifact(workspace, ['.step', '.txt'], 1)).not.toBeNull()
    expect(newestArtifact(workspace, ['.step'], 2)?.path).toBe('c.step')
  })

  it('skips an entry it cannot stat, such as a dangling link, and a file with no extension', () => {
    symlinkSync(join(workspace, 'nowhere.step'), join(workspace, 'dangling.step'))
    touch('Makefile', 5_000)
    touch('real.step', 1_000)
    expect(newestArtifact(workspace, ['.step'])?.path).toBe('real.step')
    expect(newestArtifact(join(workspace, 'missing'), ['.step'])).toBeNull()
  })
})

describe('isCandidateArtifact', () => {
  it('matches by extension and refuses ignored directories', () => {
    expect(isCandidateArtifact('/ws/models/a.step', ['.step'])).toBe(true)
    expect(isCandidateArtifact('/ws/a.txt', ['.step'])).toBe(false)
    expect(isCandidateArtifact('/ws/node_modules/a.step', ['.step'])).toBe(false)
    expect(isCandidateArtifact('/ws/models/.a.step.glb', ['.glb'])).toBe(false)
  })
})

describe('bundledDshRegistry', () => {
  it('reads the registry off the source tree in dev, with Autonomous Circuit, Autonomous Workshop and Marp present', () => {
    resetBundledDshRegistry()
    const ids = bundledDshRegistry().map((entry) => entry.id)
    expect(ids).toEqual(expect.arrayContaining(['autonomous/autonomous-circuit', 'autonomous/autonomous-workshop', 'autonomous/marp']))
    expect(ids).not.toContain('autonomous/copper')
    expect(resolveInstallSource('autonomous/autonomous-circuit')).toMatchObject({ source: 'https://github.com/autonomous-ai/openharness', path: 'store/agents/autonomous-circuit', id: 'autonomous/autonomous-circuit' })
    expect(resolveInstallSource('https://example.com/x.git')).toEqual({ source: 'https://example.com/x.git' })
    expect(resolveInstallSource('bad\nsource')).toBeNull()
  })
})
