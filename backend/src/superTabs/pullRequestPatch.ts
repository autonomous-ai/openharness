/**
 * A pull request's patch id (Dee, #3394), as `git patch-id` is for a commit: the same while the pull request's own diff is
 * the same, so a verdict read at one head still counts at a plain rebase or a main merge that leaves that diff unchanged
 * (checkVerdicts.ts). Read from GitHub's per-file patches of the pull request, which compare its head with its merge base.
 * Where a hunk starts is left out, as main's changes elsewhere in a file move it; every line of the hunk, context included,
 * is kept, so a change near the pull request's lines makes a new id (the safe side: the verdict then needs a new read).
 */
import { createHash } from 'node:crypto'

/** One file of a pull request, as GitHub lists it (GET /repos/{owner}/{repo}/pulls/{number}/files). */
export interface PullRequestFile {
  filename: string
  status: string
  previousFilename?: string
  /** The file's diff; GitHub gives none for a binary file or one too large. */
  patch?: string
  /** The file's blob at the head. */
  sha: string
}

const HUNK = /^@@ [^@]* @@.*$/gm

/** The patch id of a pull request's [files] (any order), or null for none. */
export function patchId(files: readonly PullRequestFile[]): string | null {
  if (!files.length) return null
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)) {
    hash.update(`${file.status}\0${file.previousFilename ?? ''}\0${file.filename}\0`)
    hash.update(file.patch === undefined ? `blob ${file.sha}` : file.patch.replace(HUNK, '@@'))
    hash.update('\0\0')
  }
  return hash.digest('hex')
}
