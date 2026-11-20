/**
 * The path a watch is given (fs.watch, chokidar). On Windows, libuv's watch of a folder names each change by asking
 * Windows for the changed entry's long path (GetLongPathNameW), then asserts that it starts with the folder as given
 * (libuv src/win/fs-event.c, uv__relative_path): a folder given with an 8.3 short name anywhere in it, as TEMP often
 * is (C:\Users\HXDIAL~1\AppData\Local\Temp), aborts the process at its first change. Every service runs in the core's
 * process there, so the abort ends every session. A watch of a file is never checked so, but chokidar watches the
 * nearest folder of a file not there yet: every path a watch is given comes through here.
 */
import { realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { errorKind } from './log.js'

export interface PathToWatchDeps {
  platform: NodeJS.Platform
  /** The long name of a path that is there, as Windows names its open handle (GetFinalPathNameByHandleW). */
  realpath(path: string): string
  log(line: string): void
}

/** The lines said: a watch held on a folder asks for a nearer one at each change, and one line a cause is enough. */
const said = new Set<string>()

const thisComputer: PathToWatchDeps = {
  platform: process.platform,
  realpath: (path) => realpathSync.native(path),
  log: (line) => {
    if (said.has(line)) return
    said.add(line)
    console.log(line)
  },
}

/** `path` as a watch is to be given it: off Windows, as it is; on Windows, its long name, and for a path not there,
 *  its nearest parent's that is, with the rest as given (a name made later is its own long name). None when a long
 *  name cannot be read: the path is not watched, and a line says why, never the path. */
export function pathToWatch(path: string, deps: PathToWatchDeps = thisComputer): string | undefined {
  if (deps.platform !== 'win32') return path
  for (let at = path; ; at = dirname(at)) {
    try {
      return join(deps.realpath(at), relative(at, path))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        deps.log(`[watch] long name unreadable · not watched · ${errorKind(error)}`)
        return undefined
      }
      if (dirname(at) === at) return path
    }
  }
}
