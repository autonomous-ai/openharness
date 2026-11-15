/**
 * The PATH of everything an end-to-end test starts holds the test's own tools and the system's folders, and nothing of
 * the developer's: their PATH's folders are absolute, so a throwaway HOME hid none of them, and every engine the
 * harness does not fake was found there by name (audit of 2026-11-15, docs/plans/2026-11-15-e2e-isolation-2-design.md:
 * 5 `opencode` and 4 `cursor-agent` among the processes tests left on one Mac). Every folder and file here is made up.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import { ENGINE_CLI_ALIASES, ENGINE_CLI_COMMANDS } from '../lib/engineBin.js'
import { SYSTEM_FOLDERS, TEST_TOOLS, testPath, workerTools } from './testPath.js'

/** What each tool is asked through its link: something it answers without doing anything. */
const ASKED: Record<string, string[]> = {
  node: ['--version'], tmux: ['-V'], git: ['--version'], podman: ['--version'],
  zsh: ['-fc', 'exit 0'], bash: ['--norc', '-c', 'exit 0'], tcsh: ['-fc', 'exit 0'], dash: ['-c', 'exit 0'],
}

describe.skipIf(process.platform === 'win32')('the PATH of what a test starts', () => {
  let scratch = ''
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'test-path-')) })
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })
  /** A folder of [scratch] holding [names], each a file that would only fail. */
  const folder = (...names: string[]): string => {
    const dir = mkdtempSync(join(scratch, 'folder-'))
    for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
    return dir
  }

  it('names no engine, by the command it is started with or an alias it is found by, and no package manager', () => {
    const engines = new Set([...Object.values(ENGINE_CLI_COMMANDS), ...Object.values(ENGINE_CLI_ALIASES).flat()].filter(Boolean))
    expect(TEST_TOOLS.filter((tool) => engines.has(tool))).toEqual([])
    // `npm prefix -g` is where a developer's npm engines are, and the launch script looks there (lib/engineLaunch.ts).
    expect(TEST_TOOLS.filter((tool) => ['npm', 'npx', 'pnpm', 'yarn', 'bun', 'brew'].includes(tool))).toEqual([])
    // Every tool is asked something below: one added to the list is added there.
    expect(TEST_TOOLS.filter((tool) => !ASKED[tool])).toEqual([])
  })

  it('finds each tool where the worker\'s PATH has it, node as the Node running the tests, and leaves out one it lacks', () => {
    const worker = folder('git', 'tmux', 'opencode')
    expect([...workerTools({ PATH: worker })]).toEqual([['node', process.execPath], ['tmux', join(worker, 'tmux')], ['git', join(worker, 'git')]])
    // This worker's own are found once.
    expect(workerTools()).toBe(workerTools())
  })

  it('links them in <root>/tools, each to an absolute file, and puts no folder of the worker\'s PATH on the result', () => {
    const worker = folder('git', 'opencode'), root = folder()
    const path = testPath(root, workerTools({ PATH: worker }))
    expect(path).toBe([join(root, 'tools'), ...SYSTEM_FOLDERS].join(':'))
    expect(readdirSync(join(root, 'tools')).sort()).toEqual(['git', 'node'])
    for (const name of ['git', 'node']) {
      expect(isAbsolute(readlinkSync(join(root, 'tools', name))), name).toBe(true)
      expect(statSync(join(root, 'tools', name)).isFile(), name).toBe(true)
    }
    expect(resolveBinaryOnPath('git', { PATH: path })).toBe(join(root, 'tools', 'git'))
    // The developer's engine, a folder away from a tool they also have: not found.
    expect(resolveBinaryOnPath('opencode', { PATH: path })).toBeNull()
  })

  it('runs each tool the worker has through its link, with nothing else on PATH', () => {
    const root = folder(), path = testPath(root)
    for (const [name] of workerTools()) {
      expect(() => execFileSync(join(root, 'tools', name), ASKED[name], { env: { PATH: path, HOME: root }, stdio: 'ignore', timeout: 10_000 }), name).not.toThrow()
    }
  })
})
