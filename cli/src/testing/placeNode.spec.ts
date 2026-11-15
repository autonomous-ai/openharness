import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { placeNode, RosettaNodeError } from './placeNode.js'

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

  // On an Apple Silicon Mac, Rosetta translates an x86_64 Node again at each new path it runs from: 15.3 s for the
  // first run of a fresh copy and 16.1 s for a hard link of it, against 0.30 s for an arm64 copy (M1 Pro, 2026-11-15).
  // Two such paths in one test ran past master.spec.ts's 30 s waits, and the failure named a timeout, not the Node.
  it('refuses an x86_64 Node that Rosetta runs, by name, and copies nothing', () => {
    const refusal = (() => {
      try { placeNode(join(dir, 'node'), [join(dir, 'libexec')], { platform: 'darwin', arch: 'x64', cpu: 'Apple M1 Pro' }) } catch (error) { return error }
    })()
    expect(String(refusal)).toBe('RosettaNodeError: This Node is an x86_64 build, so Rosetta runs it and translates it again at each new path, about 15 s for every copy or link a test starts. Run the tests with an arm64 Node.')
    expect(refusal).toBeInstanceOf(RosettaNodeError)
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    ['an arm64 Node on Apple Silicon', { platform: 'darwin', arch: 'arm64', cpu: 'Apple M1 Pro' }],
    ['an x86_64 Node on an Intel Mac', { platform: 'darwin', arch: 'x64', cpu: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz' }],
    ['an x86_64 Node off the Mac', { platform: 'linux', arch: 'x64', cpu: 'Apple M1 Pro' }],
    ['a Node whose machine names no CPU', { platform: 'darwin', arch: 'x64', cpu: undefined }],
  ])('copies %s as before', (_, machine) => {
    const node = join(dir, 'node')
    placeNode(node, [], machine)
    expect(statSync(node).size).toBe(statSync(process.execPath).size)
  })
})
