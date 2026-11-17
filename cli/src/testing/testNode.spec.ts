/**
 * The run's Node: a copy of the Node running the tests, alone in a folder of its own. The product looks for
 * npm-installed engines beside the Node it runs on, whatever PATH says (lib/engineLaunch.ts `npmRuntimeBins`), and a
 * version manager puts the developer's real engines in that folder (audit of 2026-11-16,
 * docs/plans/2026-11-16-e2e-isolation-3-design.md). Every folder and file here is made up; the one program run is the
 * copy of this Node.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RosettaNodeError } from './placeNode.js'
import { assertNodeAlone, setUpTestNode } from './testNode.js'

// The end-to-end harness and its configuration are outside tsconfig's rootDir (src), so they are loaded untyped, as
// socketPathRoom.spec.ts loads socketRoom.ts.
const setup = (await import('../../e2e/harness/testNode.js' as string) as { default: (project?: unknown) => () => void }).default
const config = (await import('../../vitest.e2e.config.js' as string) as { default: { test: { globalSetup: string[] } } }).default

const ROSETTA = { platform: 'darwin', arch: 'x64', cpu: 'Apple M1 Pro' }
const ALONE = 'a daemon under test must run on a Node alone in its folder'
/** What [folder] holds beside a Node and the library Homebrew's Node loads from beside it. */
const strangers = (folder: string) => readdirSync(folder).filter((name) => name !== 'node' && !name.startsWith('libnode.'))

describe.skipIf(process.platform === 'win32')('the run\'s Node', () => {
  let base = '', tmp = ''
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'test-node-')))
    tmp = join(base, 'tmp')
    mkdirSync(tmp)
    // The temporary folder behind a link, as macOS's is.
    symlinkSync(tmp, join(base, 't'))
    vi.stubEnv('TMPDIR', join(base, 't'))
    // Stubbed first, so that what the setup sets is taken out again.
    vi.stubEnv('E2E_NODE_PATH', undefined)
  })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }) })
  /** A folder of [base] holding [files], each empty: never run. */
  const folder = (name: string, ...files: string[]): string => {
    mkdirSync(join(base, name))
    for (const file of files) writeFileSync(join(base, name, file), '')
    return join(base, name)
  }

  it('is a copy of this Node alone in its folder, named by its real path in E2E_NODE_PATH, and gone at teardown', () => {
    const teardown = setUpTestNode()
    const node = process.env.E2E_NODE_PATH!
    expect(readdirSync(tmp)).toEqual([expect.stringMatching(/^harness-e2e-node-.{6}$/)])
    expect(node).toBe(join(tmp, readdirSync(tmp)[0], 'bin', 'node'))
    expect(strangers(dirname(node))).toEqual([])
    expect(() => assertNodeAlone(node)).not.toThrow()
    // Node names itself by its real path: the folder the daemon looks beside is this one.
    const run = spawnSync(node, ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 20_000 })
    expect(run.stderr + run.stdout).toBe(`${node}\n`)
    teardown()
    expect(readdirSync(tmp)).toEqual([])
  })

  it('refuses a Node that Rosetta runs, by name, and leaves no folder', () => {
    expect(() => setUpTestNode(ROSETTA)).toThrow(RosettaNodeError)
    expect([readdirSync(tmp), process.env.E2E_NODE_PATH]).toEqual([[], undefined])
  })

  it('stops the run when the copy cannot start, naming this Node and the reason, and leaves no folder', () => {
    const refusal = (() => {
      try { setUpTestNode(undefined, () => { throw new Error('made-up: library not loaded') }) } catch (error) { return String(error) }
    })()
    // A yes or a no: the message names the developer's own Node.
    expect(refusal === `Error: A copy of ${process.execPath} cannot start, so no end-to-end daemon can run: made-up: library not loaded`,
      'names this Node and the reason').toBe(true)
    expect([readdirSync(tmp), process.env.E2E_NODE_PATH]).toEqual([[], undefined])
  })

  it('is what the suite\'s setup makes, after the socket room is measured and before the bundle is built', () => {
    // Vitest hands a global setup its project: never read as the machine.
    const teardown = setup(ROSETTA)
    expect(process.env.E2E_NODE_PATH).toBe(join(tmp, readdirSync(tmp)[0], 'bin', 'node'))
    teardown()
    expect(readdirSync(tmp)).toEqual([])
    expect(config.test.globalSetup).toEqual(['./e2e/harness/socketRoom.ts', './e2e/harness/testNode.ts', './e2e/harness/bundle.ts'])
  })

  it('lets a Node be alone but for libnode, which Homebrew\'s Node loads from beside it', () => {
    expect(() => assertNodeAlone(join(folder('alone', 'node', 'libnode.141.dylib', 'libnode.so.141'), 'node'))).not.toThrow()
  })

  it('refuses a Node beside other programs, naming the folder and at most five of them', () => {
    const one = folder('one', 'node', 'codex')
    const many = folder('many', 'node', 'npm', 'npx', 'corepack', 'codex', 'kilo', 'opencode', 'pi')
    expect(() => assertNodeAlone(join(one, 'node'))).toThrow(`${one} holds codex: ${ALONE}`)
    expect(() => assertNodeAlone(join(many, 'node'))).toThrow(`${many} holds codex, corepack, kilo, npm, npx and 2 more: ${ALONE}`)
  })

  it('judges the folder Node names itself by: a link in a clean folder to a Node beside other programs is refused', () => {
    const theirs = folder('theirs', 'node', 'codex'), clean = folder('clean')
    symlinkSync(join(theirs, 'node'), join(clean, 'node'))
    expect(() => assertNodeAlone(join(clean, 'node'))).toThrow(`${theirs} holds codex: ${ALONE}`)
  })
})
