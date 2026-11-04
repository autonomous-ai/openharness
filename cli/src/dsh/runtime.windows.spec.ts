// A harness launch on real Windows (the Windows workflow runs it). From Oct 22, the day after Harness on Windows
// shipped, launches failed with dsh_runtime_failed: the runtime folder was split on '/', so a fresh workspace's
// first launch failed in mkdir, and skill links were directory symlinks, which need Developer Mode or an
// administrator. The runner is an administrator, so this proves the junction works, not that a symlink would not.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstalledDsh } from './installed.js'
import { forkRuntimeKey, prepareHarnessLaunch } from './runtime.js'

let root: string
let ws: string
let pkg: InstalledDsh
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'windows harness-')))
  ws = join(root, 'project with spaces')
  mkdirSync(ws)
  const dir = join(root, 'package')
  mkdirSync(join(dir, 'skills', 'draw'), { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), '# Make a drawing\n')
  writeFileSync(join(dir, 'skills', 'draw', 'SKILL.md'), '# Draw\n')
  pkg = { id: 'acme/draw', dir, realDir: dir, source: dir, ref: null, commit: null, linked: true, installedAt: 1,
    manifest: { spec: 1, id: 'acme/draw', name: 'Drawing', engine: 'claude', agent: { instructions: 'AGENTS.md', skills: ['skills'] } } }
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe.runIf(process.platform === 'win32')('a harness launch on Windows', () => {
  it('launches in a fresh workspace, relaunches over its own skill link, and forks', () => {
    const first = prepareHarnessLaunch(pkg, ws, 'claude', 'session')
    expect(readFileSync(first.env.HARNESS_CONTEXT_FILE!, 'utf8')).toContain('# Make a drawing')
    expect(readFileSync(join(first.env.HARNESS_SKILLS_DIR!, 'draw', 'SKILL.md'), 'utf8')).toBe('# Draw\n')
    const again = prepareHarnessLaunch(pkg, ws, 'claude', 'session')
    expect(again.env.HARNESS_SKILLS_DIR).toBe(first.env.HARNESS_SKILLS_DIR)
    const fork = prepareHarnessLaunch(pkg, ws, 'claude', 'fork', {}, forkRuntimeKey({ cwd: ws, agentId: 'session', dshRuntime: 'session' }))
    expect(readFileSync(join(fork.env.HARNESS_SKILLS_DIR!, 'draw', 'SKILL.md'), 'utf8')).toBe('# Draw\n')
  })
})
