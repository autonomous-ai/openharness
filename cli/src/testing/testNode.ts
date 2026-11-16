/**
 * The run's Node: one copy of the Node running the tests, alone in a folder of its own, for every daemon an end-to-end
 * test starts and for `node` in its panes.
 *
 * Why nothing else is in its folder: the product looks for npm-installed engines beside the Node it runs on, whatever
 * PATH says (lib/engineLaunch.ts `npmRuntimeBins`), and a version manager's Node folder holds the developer's real
 * engines, which a daemon under test would find and run under their login (audit of 2026-11-16,
 * docs/plans/2026-11-16-e2e-isolation-3-design.md).
 *
 * Why a copy and not a link: a symbolic link does not move `process.execPath`, since Node names itself by the real path;
 * a hard link of the running Node made Homebrew's Node fail to load its libnode anywhere on the Mac (#4395, placeNode.ts).
 *
 * What it costs: one copy (a clone where the filesystem can) and one first start for each run, about 1.1 to 1.6 s on a
 * Mac (the design's Cost), and one `readdirSync` for each daemon start.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { placeNode } from './placeNode.js'

/** The refusal lists this many programs at most: a developer's Node folder can hold dozens. */
const NAMED = 5

/**
 * One run of [node]. A fresh copy's first start is the slow one, so the run pays it here once; and a copy that cannot
 * start fails the run before any test. Node puts the copy's standard error in the error's message.
 */
const firstStart = (node: string): void => {
  execFileSync(node, ['-e', ''], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 })
}

/** Makes the run's Node, starts it once and names it in E2E_NODE_PATH. Returns the teardown, which removes its folder.
 *  [machine] and [start] are for the spec: this Node's own machine, and one run of the copy. */
export function setUpTestNode(machine?: Parameters<typeof placeNode>[2], start: (node: string) => void = firstStart): () => void {
  // By its real path, as Node names itself: macOS's temporary folder is behind a link.
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'harness-e2e-node-')))
  const node = join(folder, 'bin', 'node')
  // A refused Node, a failed copy and a copy that cannot start all leave no folder behind.
  try {
    mkdirSync(dirname(node))
    placeNode(node, [], machine)
    try {
      start(node)
    } catch (error) {
      throw new Error(`A copy of ${process.execPath} cannot start, so no end-to-end daemon can run: ${(error as Error).message}`, { cause: error })
    }
    process.env.E2E_NODE_PATH = node
  } catch (error) {
    rmSync(folder, { recursive: true, force: true })
    throw error
  }
  return () => rmSync(folder, { recursive: true, force: true })
}

/** Throws unless [node], by its real path, is alone in its folder but for `libnode.*`. */
export function assertNodeAlone(node: string): void {
  // The folder Node names itself by: a link in a clean folder to a Node beside other programs would pass the link's.
  const folder = dirname(realpathSync(node))
  // libnode is the library Homebrew's Node loads from beside the path it runs as (placeNode links it there).
  const names = readdirSync(folder).filter((name) => name !== 'node' && !name.startsWith('libnode.')).sort()
  if (names.length === 0) return
  const named = names.length > NAMED ? `${names.slice(0, NAMED).join(', ')} and ${names.length - NAMED} more` : names.join(', ')
  throw new Error(`${folder} holds ${named}: a daemon under test must run on a Node alone in its folder`)
}
