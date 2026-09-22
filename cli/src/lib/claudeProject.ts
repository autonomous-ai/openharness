/**
 * Which folder a Claude Code transcript belongs to.
 *
 * Claude writes `{CLAUDE_PROJECTS_DIR}/<mangled launch dir>/<sessionId>.jsonl` (see paths.ts) and never
 * moves the file: a session resumed or forked from elsewhere still lives, and keeps writing, under the
 * folder it was first started in. The `cwd` on each transcript LINE is something else — the session's
 * tracked shell directory, which follows every Bash `cd` — so a line's cwd can name a subfolder, a
 * sibling repo or a temp dir while the file's own directory still says where the project is.
 *
 * The registry's `cwd` is where a resume, restore or restart `cd`s before exec'ing the engine, so it
 * must be the folder the transcript belongs to, not wherever the shell last went. These helpers answer
 * that from the transcript's location alone: the mangling is lossy, but exact in one direction, so a
 * cwd either round-trips to the directory name or it does not.
 */
import { closeSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** Claude's project directory name for a folder: every non-alphanumeric character becomes `-`. */
export function mangleClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Whether the transcript sits in a Claude project directory at all. A mangled absolute path always
 *  starts with `-`; a spec's temp dir or another engine's layout does not, and is never read. */
export function isClaudeProjectTranscript(transcriptPath: string): boolean {
  return basename(dirname(transcriptPath)).startsWith('-')
}

/** Whether `cwd` is the folder this transcript belongs to. Checked as given and as its real path: the
 *  transcript carries `process.cwd()` (physical, `/private/tmp/…`) while a row written from a picker
 *  may say `/tmp/…`. */
export function claudeProjectMatches(cwd: string, transcriptPath: string): boolean {
  const project = basename(dirname(transcriptPath))
  if (mangleClaudeProjectDir(cwd) === project) return true
  try { return mangleClaudeProjectDir(realpathSync(cwd)) === project } catch { return false }
}

/** How much of a transcript is read looking for its folder. The matching line is on the first few lines
 *  of every file seen so far; the cap is for the pathological one, since this can run while an engine
 *  is blocked on its startup hook. */
export const CLAUDE_TRANSCRIPT_SCAN_BYTES = 2 * 1024 * 1024

/**
 * The folder a transcript belongs to, read from the transcript: the first line whose `cwd` mangles to
 * the file's own directory name. Null when no line does within the scan cap (an old transcript whose
 * folder was renamed since), when the file cannot be read, or when it is not in a Claude project
 * directory. Exact by construction — a fork copies its source's history, and a `/clear` rotation can
 * open on a drifted line, and both still resolve to the directory the file lives in.
 */
export function claudeTranscriptCwd(transcriptPath: string, limit = CLAUDE_TRANSCRIPT_SCAN_BYTES): string | null {
  if (!isClaudeProjectTranscript(transcriptPath)) return null
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
        const cwd = lineCwd(line, project)
        if (cwd) return cwd
      }
    }
    carry += decoder.end()
    return carry ? lineCwd(carry, project) : null
  } finally {
    closeSync(fd)
  }
}

function lineCwd(line: string, project: string): string | null {
  // Cheap reject before parsing: most lines (tool results, assistant text) are large and carry a cwd
  // only as one field among many; the ones without the key never need JSON.parse.
  if (!line.includes('"cwd"')) return null
  let record: unknown
  try { record = JSON.parse(line) } catch { return null }
  const cwd = (record as { cwd?: unknown } | null)?.cwd
  return typeof cwd === 'string' && cwd && mangleClaudeProjectDir(cwd) === project ? cwd : null
}
