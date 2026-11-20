import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { cpus } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { inject } from 'vitest'

/** What tells a Node that Rosetta runs from any other: `process.platform`, `process.arch` and the first CPU's model. */
export interface Machine { platform: string; arch: string; cpu: string | undefined }

/** The Node running the tests is an x86_64 build on an Apple Silicon Mac. */
export class RosettaNodeError extends Error {
  override readonly name = 'RosettaNodeError'
  constructor() {
    super('This Node is an x86_64 build, so Rosetta runs it and translates it again at each new path, about 15 s for every copy or link a test starts. Run the tests with an arm64 Node.')
  }
}

/** Whether [machine] says Rosetta runs this Node. [machine] is this Node's; a spec names another. */
export const underRosetta = (machine: Machine = { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }): boolean =>
  machine.platform === 'darwin' && machine.arch === 'x64' && machine.cpu?.startsWith('Apple') === true

/**
 * Throws [RosettaNodeError] when [machine] says Rosetta runs this Node: it translates a binary again at each new path.
 * On an M1 Pro (2026-11-15) the first run of a fresh x86_64 copy took 15.3 s and of a hard link of it 16.1 s, against
 * 0.30 s for an arm64 copy. A test that runs two such paths outlasts master.spec.ts's 30 s waits (2 failed in 141 s; on
 * an arm64 Node 60 of 60 in 23 s). No wait is long enough for that, so a test that copies or links its Node asks this
 * first and fails by name. A symlink costs nothing (0.08 s), since it runs the file it names.
 */
export function refuseRosettaNode(machine?: Machine): void {
  if (underRosetta(machine)) throw new RosettaNodeError()
}

/** The libnode Homebrew's Node loads from beside the path it runs as, in the lib folder beside this Node's bin folder.
 *  An official Node has none. */
export function libnode(): string[] {
  const lib = join(dirname(dirname(realpathSync(process.execPath))), 'lib')
  return existsSync(lib) ? readdirSync(lib).filter((name) => name.startsWith('libnode.')).map((name) => join(lib, name)) : []
}

/**
 * A copy of this test's Node at [path] (a clone where the filesystem can), that starts from [path]'s folder and from each
 * of [runFrom], where a test hard-links it further. For a process told apart by the file the kernel ran, and for the
 * run's own Node, which [placeNode] links.
 *
 * Never a hard link of the running Node: macOS may name a hard-linked file by any of its links, and Homebrew's Node loads
 * libnode from beside the path it runs as. While a test held such a link, Node failed to start anywhere on the Mac, the
 * other specs' fake launchctl included ('Library not loaded: @rpath/libnode.147.dylib', #4395). So the copy gets that
 * library linked beside it in each folder it runs from; an official Node has none and needs nothing.
 *
 * Never a Node that Rosetta runs ([refuseRosettaNode], with [machine]): it is refused before anything is copied.
 */
export function copyNode(path: string, runFrom: string[] = [], machine?: Machine): void {
  refuseRosettaNode(machine)
  copyFileSync(process.execPath, path, constants.COPYFILE_FICLONE)
  chmodSync(path, 0o755)
  const libraries = libnode()
  for (const folder of [dirname(path), ...runFrom]) {
    mkdirSync(folder, { recursive: true })
    for (const library of libraries) symlinkSync(library, join(folder, basename(library)))
  }
}

/**
 * One run of [node]. A fresh copy's first start is the slow one, so it is paid once, before any test runs the copy; and
 * a copy that cannot start fails there, by name. Node puts the copy's standard error in the error's message.
 */
export const firstStart = (node: string): void => {
  execFileSync(node, ['-e', ''], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 })
}

/**
 * The run's Node at [node]: a copy of this Node, started once by [start] under a name of its own beside [node], then
 * renamed to it, so [node] is never a copy that has not run. Workers that place their first Node at once may each make
 * one: each rename puts a whole, started copy there, and a link already made keeps the one it linked.
 */
function makeRunNode(node: string, start: (node: string) => void): void {
  const made = `${node}-${randomUUID()}`
  try {
    mkdirSync(dirname(node), { recursive: true })
    copyNode(made)
    start(made)
    renameSync(made, node)
  } catch (error) {
    rmSync(made, { force: true })
    throw new Error(`The run's Node, a copy of ${process.execPath}, could not be made at ${node}: ${(error as Error).message}`, { cause: error })
  }
}

/**
 * This test's Node at [path]: a hard link of the run's Node, the one copy the run makes at its first place and starts
 * once (__fixtures__/vitestRun.ts). macOS checks each new executable file on its first run, one at a time machine-wide, and
 * on arm64 a link of a file that ran is not new, even from another folder: a fresh copy's first start took 2.1 s under
 * load, such a link's 0.05 s. master.spec.ts places seven: on an M2 Max at a load of 38 to 100, its run took a median of
 * 48 s with a copy each and 29 s with links (five runs each, taken in turn, 2026-11-21).
 *
 * A copy as [copyNode] makes, started once as it is placed, where the run makes none ([started] ''): Homebrew's Node loads
 * libnode from beside the path it runs as, so one file linked into every test would let any test's links name it (#4395,
 * [copyNode]). A Node that
 * Rosetta runs is refused first, by name: it translates a link again as it does a copy. [runFrom] is for a copy, which
 * needs libnode beside it there. [started] is the run's Node and [start] its first run; a spec names others.
 */
export function placeNode(path: string, runFrom: string[] = [], machine?: Machine, started: string | undefined = inject('startedNode'),
  start: (node: string) => void = firstStart): void {
  refuseRosettaNode(machine)
  if (started === undefined) throw new Error('placeNode needs src/__fixtures__/vitestRun.ts as the run\'s globalSetup, which names the run\'s Node')
  if (started === '') { copyNode(path, runFrom, machine); start(path) }
  else {
    if (!existsSync(started)) makeRunNode(started, start)
    linkSync(started, path)
  }
}
