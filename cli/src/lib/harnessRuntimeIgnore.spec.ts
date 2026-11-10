import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ignoreHarnessRuntime } from './harnessRuntimeIgnore.js'

const roots: string[] = []
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'runtime-ignore-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** A workspace with Harness's folder made, as a launch makes it before writing the ignore file. */
const workspace = () => { const root = fixture(); mkdirSync(join(root, '.harness')); return root }

describe('the Harness folder\'s ignore file', () => {
  it('keeps the whole Harness folder out of Git, including git add -A, while a file someone adds there still shows', () => {
    const root = workspace()
    execFileSync('git', ['init', '-q', root])
    mkdirSync(join(root, '.harness', 'runtime'))
    writeFileSync(join(root, '.harness', 'runtime', 'session'), 'runtime')
    ignoreHarnessRuntime(root)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('')
    execFileSync('git', ['add', '-A'], { cwd: root })
    expect(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })).toBe('')
    writeFileSync(join(root, '.harness', 'notes.md'), 'mine')
    // Review of #2266: the rule names only Harness's own file, so an ignore file someone adds deeper still shows.
    mkdirSync(join(root, '.harness', 'mine'))
    writeFileSync(join(root, '.harness', 'mine', '.gitignore'), 'scratch/\n')
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }))
      .toBe('?? .harness/mine/.gitignore\n?? .harness/notes.md\n')
  })

  it('accepts the self rule in either form and adds only the runtime rules missing beside it', () => {
    for (const self of ['.gitignore', '/.gitignore']) {
      const root = workspace(), file = join(root, '.harness', '.gitignore')
      writeFileSync(file, `legacy-AGENTS.md\n${self}\n`)
      ignoreHarnessRuntime(root)
      expect(readFileSync(file, 'utf8')).toBe(`legacy-AGENTS.md\n${self}\nruntime/\n`)
    }
  })

  it('preserves custom ignore rules and adds the runtime rules only once', () => {
    const root = workspace(), file = join(root, '.harness', '.gitignore')
    writeFileSync(file, '# Mine\nprivate-data')
    ignoreHarnessRuntime(root)
    expect(readFileSync(file, 'utf8')).toBe('# Mine\nprivate-data\nruntime/\nlegacy-AGENTS.md\n/.gitignore\n')
    ignoreHarnessRuntime(root)
    expect(readFileSync(file, 'utf8')).toBe('# Mine\nprivate-data\nruntime/\nlegacy-AGENTS.md\n/.gitignore\n')
  })

  // A project may have committed the ignore file (git add -A staged it before). Adding a line to a committed file would
  // itself be uncommitted work and land in every worker's pull request, so a file that has its rules is left as it is.
  it('leaves an ignore file that already has the runtime rules byte for byte as it was', () => {
    const root = workspace(), file = join(root, '.harness', '.gitignore')
    writeFileSync(file, 'runtime/\nlegacy-AGENTS.md\n')
    ignoreHarnessRuntime(root)
    expect(readFileSync(file, 'utf8')).toBe('runtime/\nlegacy-AGENTS.md\n')
  })

  it('refuses a redirected runtime ignore file without modifying its target', () => {
    const root = workspace(), target = join(fixture(), 'rules')
    writeFileSync(target, 'Keep these rules')
    symlinkSync(target, join(root, '.harness', '.gitignore'))
    expect(() => ignoreHarnessRuntime(root)).toThrow(/symlink|plain/i)
    expect(readFileSync(target, 'utf8')).toBe('Keep these rules')
  })
})
