import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathToWatch, type PathToWatchDeps } from './pathToWatch.js'

const notThere = (): never => { throw Object.assign(new Error('not there'), { code: 'ENOENT' }) }

/** Windows as a watch's path meets it: `long` names each path that is there by its long name, as GetFinalPathNameByHandleW
 *  does; any other path is not there. Run with this computer's separators, which Windows' are on Windows. */
function windows(long: Record<string, string>, lines: string[] = []): PathToWatchDeps {
  return { platform: 'win32', realpath: (path) => long[path] ?? notThere(), log: (line) => lines.push(line) }
}

const short = join('/Users', 'HXDIAL~1', 'AppData', 'Local', 'Temp')
const long = join('/Users', 'hxdialtest', 'AppData', 'Local', 'Temp')

describe('the path a watch is given', () => {
  it('off Windows it is the path as given, never looked up', () => {
    const deps: PathToWatchDeps = { platform: 'darwin', realpath: () => { throw new Error('looked up') }, log: () => {} }
    expect(pathToWatch(short, deps)).toBe(short)
  })

  // Every short name Windows makes has a `~` (HXDIAL~1). A path without one is watched as it was before: no open of it
  // on each watch's start, and none refused where long names cannot be read (realpath.native fails on a RAM disk).
  it('on Windows a path with no short name in it is the path as given, never looked up', () => {
    const lines: string[] = []
    const deps: PathToWatchDeps = { ...windows({}, lines), realpath: () => { throw Object.assign(new Error('looked up'), { code: 'EISDIR' }) } }
    expect(pathToWatch(long, deps)).toBe(long)
    expect(lines).toEqual([])
  })

  it('on Windows a folder with a short name in it is given by its long name', () => {
    expect(pathToWatch(short, windows({ [short]: long }))).toBe(long)
  })

  it('on Windows a path not there yet is its nearest parent\'s long name, with the rest as given', () => {
    expect(pathToWatch(join(short, 'claude', 'projects'), windows({ [short]: long }))).toBe(join(long, 'claude', 'projects'))
  })

  it('on Windows a path none of which is there is the path as given', () => {
    expect(pathToWatch(short, windows({}))).toBe(short)
  })

  it('on Windows a path whose long name cannot be read is not watched, and the line says why, never the path', () => {
    const lines: string[] = []
    const deps: PathToWatchDeps = { ...windows({}, lines), realpath: () => { throw Object.assign(new Error(short), { code: 'EPERM' }) } }
    expect(pathToWatch(short, deps)).toBeUndefined()
    expect(lines).toEqual(['[watch] long name unreadable · not watched · EPERM'])
  })
})
