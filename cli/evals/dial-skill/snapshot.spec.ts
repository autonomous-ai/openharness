import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changed, snapshot } from './lib/snapshot.js'

let dir: string
const past = new Date('2001-01-01T00:00:00Z')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dial-skill-snapshot-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Files dated in the past, so any write after the snapshot moves their mtime.
function file(path: string, text: string): void {
  writeFileSync(path, text)
  utimesSync(path, past, past)
}

describe('snapshot and changed', () => {
  it('lists a file written, resized or touched', () => {
    mkdirSync(join(dir, 'sub'))
    for (const name of ['written', 'resized', join('sub', 'touched'), 'kept']) file(join(dir, name), 'abc')
    const before = snapshot([dir])

    writeFileSync(join(dir, 'written'), 'xyz')
    truncateSync(join(dir, 'resized'), 1)
    utimesSync(join(dir, 'sub', 'touched'), new Date(), new Date())

    expect(changed(before, snapshot([dir]))).toEqual([join(dir, 'resized'), join(dir, 'sub', 'touched'), join(dir, 'written')])
  })

  it('lists a file made, a file removed and a folder made', () => {
    file(join(dir, 'gone'), 'abc')
    const before = snapshot([dir])

    file(join(dir, 'new'), 'abc')
    rmSync(join(dir, 'gone'))
    mkdirSync(join(dir, 'empty'))

    expect(changed(before, snapshot([dir]))).toEqual([join(dir, 'empty'), join(dir, 'gone'), join(dir, 'new')])
  })

  it('lists nothing for an untouched tree', () => {
    mkdirSync(join(dir, 'sub'))
    file(join(dir, 'sub', 'a'), 'abc')

    expect(changed(snapshot([dir]), snapshot([dir]))).toEqual([])
  })

  it('records a dangling link and walks on', () => {
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'))
    file(join(dir, 'file'), 'abc')

    expect([...snapshot([dir]).keys()].sort()).toEqual([join(dir, 'dangling'), join(dir, 'file')])
  })

  it('walks a symlinked folder one level down, and not one linked inside it', () => {
    const tree = join(dir, 'tree')
    const linked = join(dir, 'linked')
    const further = join(dir, 'further')
    for (const folder of [tree, linked, further]) mkdirSync(folder)
    file(join(linked, 'one'), 'abc')
    file(join(further, 'two'), 'abc')
    symlinkSync(linked, join(tree, 'link'))
    symlinkSync(further, join(linked, 'link'))

    const paths = [...snapshot([tree]).keys()]

    expect(paths).toContain(join(tree, 'link', 'one'))
    expect(paths.some((path) => path.startsWith(join(tree, 'link', 'link') + '/'))).toBe(false)
  })
})
