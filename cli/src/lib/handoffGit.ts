/** Resolve git's exclusion destination from bounded, retained local metadata, without spawning git. */
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { NativeFiles } from '../engines/kit/nativeFiles.js'
import { HandoffError, type HandoffGit } from './handoffAuthority.js'
import { readHandoffFile } from './handoffFiles.js'

export function handoffGitRoute(cwd: string): HandoffGit {
  const paths = new NativeFiles(), files: HandoffGit['files'] = []
  const hold = (): never => { throw new HandoffError('HANDOFF_UNAVAILABLE') }
  const pointer = (path: string, prefix = ''): string => {
    const file = readHandoffFile(path, 16 * 1024)
    if (file.text === null || !file.text.startsWith(prefix)) return hold()
    const target = file.text.slice(prefix.length).trim()
    if (!target || /[\r\n\0]/.test(target)) return hold()
    files.push({ path, version: file.version! })
    return isAbsolute(target) ? target : resolve(dirname(path), target)
  }
  for (let at = cwd, hops = 0; ; at = dirname(at), hops++) {
    if (hops >= 128) return hold()
    const dot = paths.locate(join(at, '.git'), true)
    if (dot) {
      const git = dot.info.isDirectory() ? dot : dot.info.isFile() ? paths.locate(pointer(dot.path, 'gitdir:')) : null
      if (!git?.info.isDirectory()) return hold()
      const common = paths.locate(join(git.path, 'commondir'), true)
      const base = common ? paths.locate(pointer(common.path)) : git
      if (!base?.info.isDirectory()) return hold()
      return { exclude: join(base.path, 'info', 'exclude'), route: paths.paths.snapshot(), files }
    }
    if (dirname(at) === at) return { exclude: null, route: paths.paths.snapshot(), files }
  }
}
