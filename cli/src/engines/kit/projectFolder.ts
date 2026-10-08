/**
 * Which folder a transcript belongs to, for an engine that keeps transcripts by the folder they began in
 * (facets/discovery.ts `projectFolder`). Moved from lib/claudeProject.ts, whose every answer this reproduces
 * (engines/discovery.golden.spec.ts).
 *
 * The registry's `cwd` is where a resume, restore or restart `cd`s before exec'ing the engine, so it must be
 * the folder the transcript belongs to, not wherever the shell last went. These answer that from the
 * transcript's location alone: the mapping is lossy, but exact in one direction, so a cwd either maps to the
 * directory name or it does not.
 */
import { closeSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { DiscoveryContract } from '../facets/discovery.js'

type Rule = NonNullable<DiscoveryContract['projectFolder']>

/** The project directory's name for a folder. */
export function projectDirectoryName(rule: Rule, cwd: string): string {
  return cwd.replace(rule.mangle, rule.with)
}

/** Whether the transcript sits in a project directory at all: a spec's temp dir or another engine's layout
 *  does not, and is never read. */
export function isProjectTranscript(rule: Rule, transcriptPath: string): boolean {
  return basename(dirname(transcriptPath)).startsWith(rule.marker)
}

/** Whether `cwd` is the folder this transcript belongs to. Checked as given and as its real path: the
 *  transcript carries `process.cwd()` (physical, `/private/tmp/…`) while a row written from a picker may say
 *  `/tmp/…`. */
export function projectMatches(rule: Rule, cwd: string, transcriptPath: string): boolean {
  const project = basename(dirname(transcriptPath))
  if (projectDirectoryName(rule, cwd) === project) return true
  try { return projectDirectoryName(rule, realpathSync(cwd)) === project } catch { return false }
}

/**
 * The folder a transcript belongs to, read from the transcript: the first line whose folder field maps to
 * the file's own directory name. Null when no line does within the scan cap (an old transcript whose folder
 * was renamed since), when the file cannot be read, or when it is not in a project directory. Exact by
 * construction: a fork copies its source's history, and a `/clear` rotation can open on a drifted line, and
 * both still resolve to the directory the file lives in.
 */
export function transcriptFolder(rule: Rule, transcriptPath: string, limit = rule.scanBytes): string | null {
  if (!isProjectTranscript(rule, transcriptPath)) return null
  const project = basename(dirname(transcriptPath))
  let fd: number
  try { fd = openSync(transcriptPath, 'r') } catch { return null }
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024)
    // A multi-byte character split across two chunks must not become U+FFFD: a cwd with one in it
    // would then fail to match on exactly the line that named the folder.
    const decoder = new StringDecoder('utf8')
    let carry = ''
    let read = 0
    while (read < limit) {
      let n: number
      try { n = readSync(fd, chunk, 0, Math.min(chunk.length, limit - read), read) } catch { return null }
      if (n <= 0) break
      read += n
      const text = carry + decoder.write(chunk.subarray(0, n))
      const lines = text.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const cwd = lineFolder(rule, line, project)
        if (cwd) return cwd
      }
    }
    carry += decoder.end()
    return carry ? lineFolder(rule, carry, project) : null
  } finally {
    closeSync(fd)
  }
}

function lineFolder(rule: Rule, line: string, project: string): string | null {
  // Cheap reject before parsing: most lines (tool results, assistant text) are large and carry the folder
  // only as one field among many; the ones without the key never need JSON.parse.
  if (!line.includes(`"${rule.field}"`)) return null
  let record: unknown
  try { record = JSON.parse(line) } catch { return null }
  const cwd = (record as Record<string, unknown> | null)?.[rule.field]
  return typeof cwd === 'string' && cwd && projectDirectoryName(rule, cwd) === project ? cwd : null
}
