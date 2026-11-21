/**
 * git and gh run by the paths gitPath and ghPath find (./gitOnPath.ts): Node on Windows runs a bare name from the
 * child's working folder before PATH, so a `git.exe` committed to a repository would run as `git` there. The bare names
 * are read as text, as systemProgram.spec.ts reads Windows' own programs.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sourceFiles } from '../testing/sourceFiles.js'

/** git or gh by its bare name, as what a call runs: a spawn's or an exec's first argument, a command's `file`, the
 *  fallback for a variable that names one (`GIT ?? 'git'`), or the first word of a shell command. */
const BARE = /(?:\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(|\bfile:|\?\?|\|\|)\s*(['"`])(?:git|gh)(?:\.exe)?\1|\bexec(?:Sync)?\(\s*(['"`])(?:git|gh)\s/g

describe('git and gh by their paths', () => {
  it('the check finds a bare git or gh as what a call runs', () => {
    const found = (text: string) => [...text.matchAll(BARE)].length
    expect(found("spawn('git', ['status'])")).toBe(1)
    expect(found('execFileSync("gh", args)')).toBe(1)
    expect(found("({ file: 'git.exe', args })")).toBe(1)
    expect(found("process.env.GIT ?? 'git'")).toBe(1)
    expect(found('exec(`git status`)')).toBe(1)
    expect(found('execFile(await gitPath(), args)')).toBe(0)
    // The pull request reader's label for the program, which it runs by gitPath's or ghPath's answer.
    expect(found("execute('git', ['symbolic-ref'])")).toBe(0)
    expect(found("cleanText(stderr) || 'gh failed.'")).toBe(0)
  })

  // Test code runs in the repository; what a person runs does not.
  it('no file under cli/src runs one by its bare name', () => {
    const src = fileURLToPath(new URL('..', import.meta.url))
    const bare = sourceFiles(src)
      .filter((file) => /\.(ts|mts|js|mjs)$/.test(file) && !/\.(spec|test)\.ts$/.test(file) && !file.startsWith('testing/'))
      .flatMap((file) => [...readFileSync(join(src, file), 'utf8').matchAll(BARE)].map((match) => `${file}: ${match[0]}`))
    expect(bare).toEqual([])
  })
})
