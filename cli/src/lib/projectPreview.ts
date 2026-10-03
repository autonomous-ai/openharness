import { execFile } from 'node:child_process'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { withinRoots } from './pathContainment.js'

const exec = promisify(execFile)

/** Existing local content only. Paths/README symlinks stay inside the browsable
 * home or an agent's known workspace; all Git commands are read-only/bounded. */
export async function projectPreview(path: string, knownRoots: string[] = []) {
  if (!isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) return { error: 'INVALID_PATH' }
  try {
    const target = await realpath(path)
    if (!(await withinRoots(target, [homedir(), ...knownRoots]))) return { error: 'FORBIDDEN' }
    if (!(await stat(target)).isDirectory()) return { error: 'NOT_FOUND' }
    const files: string[] = []
    let readme: string | undefined
    const directory = await opendir(target)
    let seen = 0
    for await (const entry of directory) {
      if (!entry.name.startsWith('.')) files.push(entry.name)
      if (!readme && entry.isFile() && /^readme(?:\.(?:md|markdown|txt))?$/i.test(entry.name)) {
        const file = await open(join(target, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const buffer = Buffer.alloc(32 * 1024)
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
          const bytes = buffer.subarray(0, bytesRead)
          if (!bytes.includes(0)) readme = bytes.toString('utf8')
        } finally { await file.close() }
      }
      if (++seen >= 200) break
    }
    const git = async (args: string[]) => {
      try {
        return (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', target, ...args], {
          timeout: 2000, maxBuffer: 32 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        })).stdout.trim()
      } catch { return undefined }
    }
    const [branch, status, last, authors] = await Promise.all([
      git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
      git(['status', '--porcelain=v1', '--untracked-files=no']),
      git(['log', '-1', '--format=%s%n%an%n%aI']),
      git(['log', '-100', '--format=%an']),
    ])
    const commit = last?.split('\n')
    return { path: target, readme, files: files.sort().slice(0, 12), branch,
      ...(status !== undefined ? { changedFiles: status ? status.split('\n').length : 0 } : {}),
      ...(commit && commit.length >= 3 ? { commit: { subject: commit[0], author: commit[1], date: commit[2] } } : {}),
      contributors: authors ? [...new Set(authors.split('\n'))].slice(0, 5) : [],
    }
  } catch { return { error: 'UNREADABLE' } }
}
