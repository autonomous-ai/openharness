import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { copyNode, placeNode, refuseRosettaNode, RosettaNodeError } from './placeNode.js'

describe('placeNode', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'place-node-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // macOS checks each new executable file on its first run, one at a time machine-wide: a fresh copy's first start took
  // 2.1 s under load, a link of a copy that ran 0.05 s (2026-11-21). So the run starts one copy (vitestRun.ts), which
  // each test links. A Node with libnode beside it gets none: the case after this one.
  it.skipIf(inject('startedNode') === '')('a placed Node is the run\'s started Node', () => {
    const node = join(dir, 'node')
    placeNode(node)
    expect(statSync(node).ino).toBe(statSync(inject('startedNode')).ino)
    expect(statSync(node).ino).not.toBe(statSync(realpathSync(process.execPath)).ino)
  })

  // Homebrew's Node loads libnode from beside the path it runs as: one file linked into every test could bring #4395
  // back across tests, so the run starts none for it, and each test copies its own, as copyNode does.
  it('is a copy of its own where the run started no Node', () => {
    const node = join(dir, 'node')
    placeNode(node, [], undefined, '')
    expect(statSync(node).nlink).toBe(1)
    expect(statSync(node).size).toBe(statSync(process.execPath).size)
  })

  // A fresh copy's first start is the slow one, 2 to 4 s on a loaded Mac: run inside a test's own waits, it failed them
  // (selfUpdate.spec.ts, 2026-11-19). So the copy is started as it is placed, as the run's Node is.
  it('starts its own copy once where the run started no Node', () => {
    const node = join(dir, 'node'), start = vi.fn<(node: string) => void>()
    placeNode(node, [], undefined, '', start)
    expect(start).toHaveBeenCalledExactlyOnceWith(node)
  })

  it.each([['a link of the run\'s Node', join('run', 'node')], ['a copy of its own', '']])('places %s in a folder not made yet', (_, run) => {
    const node = join(dir, 'bin', 'node')
    placeNode(node, [], undefined, run && join(dir, run), () => {})
    expect(statSync(node).size).toBe(statSync(process.execPath).size)
  })

  // macOS may name a hard-linked file by any of its links. Homebrew's Node loads libnode from beside the
  // path it runs as, so while a test held a link of it, Node failed to start anywhere on the Mac (#4395).
  it('copies a file of its own, never a link of the running Node', () => {
    const running = statSync(realpathSync(process.execPath))
    const node = join(dir, 'bin', 'node')
    mkdirSync(join(dir, 'bin'))
    copyNode(node)
    expect(statSync(node).ino).not.toBe(running.ino)
    expect(statSync(realpathSync(process.execPath)).nlink).toBe(running.nlink)
  })

  it.each([['copyNode', copyNode], ['placeNode', placeNode]] as const)('%s starts from its own folder and from each folder it is linked into', (_, place) => {
    const bin = join(dir, 'node-v1', 'bin')
    const libexec = join(dir, 'node-v1', 'libexec', 'harnessd')
    for (const folder of [bin, libexec]) mkdirSync(folder, { recursive: true })
    const node = join(bin, 'node')
    place(node, [libexec])
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
  it.each([['copyNode', copyNode], ['placeNode', placeNode]] as const)('%s refuses an x86_64 Node that Rosetta runs, by name, and copies nothing', (_, place) => {
    const refusal = (() => {
      try { place(join(dir, 'node'), [join(dir, 'libexec')], { platform: 'darwin', arch: 'x64', cpu: 'Apple M1 Pro' }) } catch (error) { return error }
    })()
    expect(String(refusal)).toBe('RosettaNodeError: This Node is an x86_64 build, so Rosetta runs it and translates it again at each new path, about 15 s for every copy or link a test starts. Run the tests with an arm64 Node.')
    expect(refusal).toBeInstanceOf(RosettaNodeError)
    expect(readdirSync(dir)).toEqual([])
  })

  // nodeReferences.e2e.ts copies its Node itself, laid out as an install is, and asks before it does.
  it('refuses the same Node to a test that copies its Node itself', () => {
    expect(() => refuseRosettaNode({ platform: 'darwin', arch: 'x64', cpu: 'Apple M1 Pro' })).toThrow(RosettaNodeError)
    expect(() => refuseRosettaNode({ platform: 'darwin', arch: 'arm64', cpu: 'Apple M1 Pro' })).not.toThrow()
  })

  it.each([
    ['an arm64 Node on Apple Silicon', { platform: 'darwin', arch: 'arm64', cpu: 'Apple M1 Pro' }],
    ['an x86_64 Node on an Intel Mac', { platform: 'darwin', arch: 'x64', cpu: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz' }],
    ['an x86_64 Node off the Mac', { platform: 'linux', arch: 'x64', cpu: 'Apple M1 Pro' }],
    ['a Node whose machine names no CPU', { platform: 'darwin', arch: 'x64', cpu: undefined }],
  ])('copies and places %s as before', (_, machine) => {
    for (const place of [copyNode, placeNode]) {
      const node = join(dir, place.name)
      place(node, [], machine)
      expect(statSync(node).size).toBe(statSync(process.execPath).size)
    }
  })
})
