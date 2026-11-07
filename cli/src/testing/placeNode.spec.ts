import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { placeNode } from './placeNode.js'

describe('placeNode', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'place-node-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // macOS may name a hard-linked file by any of its links. Homebrew's Node loads libnode from beside the
  // path it runs as, so while a test held a link of it, Node failed to start anywhere on the Mac (#4395).
  it('is a file of its own, never a link of the running Node', () => {
    const running = statSync(realpathSync(process.execPath))
    const node = join(dir, 'bin', 'node')
    mkdirSync(join(dir, 'bin'))
    placeNode(node)
    expect(statSync(node).ino).not.toBe(running.ino)
    expect(statSync(realpathSync(process.execPath)).nlink).toBe(running.nlink)
  })

  it('starts from its own folder and from each folder it is linked into', () => {
    const bin = join(dir, 'node-v1', 'bin')
    const libexec = join(dir, 'node-v1', 'libexec', 'harnessd')
    for (const folder of [bin, libexec]) mkdirSync(folder, { recursive: true })
    const node = join(bin, 'node')
    placeNode(node, [libexec])
    const named = join(libexec, 'harnessd-core')
    linkSync(node, named)
    for (const path of [node, named]) {
      const run = spawnSync(path, ['-p', '6 * 7'], { encoding: 'utf8', timeout: 30_000 })
      expect(run.stderr + run.stdout).toBe('42\n')
    }
  })
})
