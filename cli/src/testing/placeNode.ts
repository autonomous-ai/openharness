import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A copy of this test's Node at [path] (a clone where the filesystem can), that starts from [path]'s folder and from each
 * of [runFrom], where a test hard-links it further.
 *
 * Never a hard link of the running Node: macOS may name a hard-linked file by any of its links, and Homebrew's Node loads
 * libnode from beside the path it runs as. While a test held such a link, Node failed to start anywhere on the Mac, the
 * other specs' fake launchctl included ('Library not loaded: @rpath/libnode.147.dylib', #4395). So the copy gets that
 * library linked beside it in each folder it runs from; an official Node has none and needs nothing.
 */
export function placeNode(path: string, runFrom: string[] = []): void {
  copyFileSync(process.execPath, path, constants.COPYFILE_FICLONE)
  chmodSync(path, 0o755)
  const lib = join(dirname(dirname(realpathSync(process.execPath))), 'lib')
  const libnode = existsSync(lib) ? readdirSync(lib).filter((name) => name.startsWith('libnode.')) : []
  for (const folder of [dirname(path), ...runFrom]) {
    mkdirSync(folder, { recursive: true })
    for (const name of libnode) symlinkSync(join(lib, name), join(folder, name))
  }
}
