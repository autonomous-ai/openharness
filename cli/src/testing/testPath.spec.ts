/**
 * The PATH of everything an end-to-end test starts holds the test's own tools and the system's folders, and nothing of
 * the developer's: their PATH's folders are absolute, so a throwaway HOME hid none of them, and every engine the
 * harness does not fake was found there by name (audit of 2026-11-15, docs/plans/2026-11-15-e2e-isolation-2-design.md:
 * 5 `opencode` and 4 `cursor-agent` among the processes tests left on one Mac). Every folder and file here is made up.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

  // The product looks beside the Node it runs on for npm-installed engines (lib/engineLaunch.ts npmRuntimeBins), and a
  // CLI run by `node` in a pane names itself by the real path behind the link (audit of 2026-11-16,
  // docs/plans/2026-11-16-e2e-isolation-3-design.md). So the link is to the run's own Node, alone in its folder.
  it('links node to the run\'s Node where the run made one, and to the Node running the tests where it did not', () => {
    const run = join(folder('node'), 'node'), worker = folder('git')
    const tools = workerTools({ PATH: worker, E2E_NODE_PATH: run })
    // A yes or a no: at the base the answer is the developer's own Node.
    expect(tools.get('node') === run, 'node is the run\'s Node').toBe(true)
    const root = folder()
    testPath(root, tools)
    expect(readlinkSync(join(root, 'tools', 'node')) === run, 'and so is the link in <root>/tools').toBe(true)
    // A unit spec's tmux fixture runs no daemon and no engine, and no setup made it a Node.
    expect(workerTools({ PATH: worker }).get('node')).toBe(process.execPath)
    expect(workerTools({ PATH: worker, E2E_NODE_PATH: '' }).get('node')).toBe(process.execPath)
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
      // Read first, unbounded: a tool's first run reads its whole file from disk, podman's 40 MB, and a CI runner's disk
      // can be slow. On a disk held to 4 MB/s podman's `--version` took over 10 s cold and 0.8 s once read; CI timed it
      // out twice (runs 44107058213, 44222372009). The bound below is for a tool that hangs, not for the disk.
      readFileSync(join(root, 'tools', name))
      expect(() => execFileSync(join(root, 'tools', name), ASKED[name], { env: { PATH: path, HOME: root }, stdio: 'ignore', timeout: 10_000 }), name).not.toThrow()
    }
  })
})
