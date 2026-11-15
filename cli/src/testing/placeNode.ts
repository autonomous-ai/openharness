import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'

/** What tells a Node that Rosetta runs from any other: `process.platform`, `process.arch` and the first CPU's model. */
interface Machine { platform: string; arch: string; cpu: string | undefined }

/** The Node running the tests is an x86_64 build on an Apple Silicon Mac. */
export class RosettaNodeError extends Error {
  override readonly name = 'RosettaNodeError'
  constructor() {
    super('This Node is an x86_64 build, so Rosetta runs it and translates it again at each new path, about 15 s for every copy or link a test starts. Run the tests with an arm64 Node.')
  }
}

/**
 * A copy of this test's Node at [path] (a clone where the filesystem can), that starts from [path]'s folder and from each
 * of [runFrom], where a test hard-links it further.
 *
 * Never a hard link of the running Node: macOS may name a hard-linked file by any of its links, and Homebrew's Node loads
 * libnode from beside the path it runs as. While a test held such a link, Node failed to start anywhere on the Mac, the
 * other specs' fake launchctl included ('Library not loaded: @rpath/libnode.147.dylib', #4395). So the copy gets that
 * library linked beside it in each folder it runs from; an official Node has none and needs nothing.
 *
 * Never a Node that Rosetta runs: it translates a binary again at each new path. On an M1 Pro (2026-11-15) the first
 * run of a fresh x86_64 copy took 15.3 s and of a hard link of it 16.1 s, against 0.30 s for an arm64 copy. A test
 * that runs two such paths outlasts master.spec.ts's 30 s waits (2 failed in 141 s; on an arm64 Node 60 of 60 in
 * 23 s). No wait is long enough for that, so [machine] is refused by name before anything is copied. A test names
 * another machine.
 */
export function placeNode(path: string, runFrom: string[] = [], machine: Machine = { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }): void {
  if (machine.platform === 'darwin' && machine.arch === 'x64' && machine.cpu?.startsWith('Apple')) throw new RosettaNodeError()
  copyFileSync(process.execPath, path, constants.COPYFILE_FICLONE)
  chmodSync(path, 0o755)
  const lib = join(dirname(dirname(realpathSync(process.execPath))), 'lib')
  const libnode = existsSync(lib) ? readdirSync(lib).filter((name) => name.startsWith('libnode.')) : []
  for (const folder of [dirname(path), ...runFrom]) {
    mkdirSync(folder, { recursive: true })
    for (const name of libnode) symlinkSync(join(lib, name), join(folder, name))
  }
}
