import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { ensureBundledCoreHarnesses, ensureBundledDevices, ensureBundledHarnessMonitor, ensureBundledMemories, ensureBundledModelManager,
  DEVICES_HARNESS_ID, HARNESS_MONITOR_ID, HARNESS_MONITOR_BUILTIN_SOURCE, MEMORIES_BUILTIN_SOURCE, MEMORIES_ID, MODEL_MANAGER_ID, type BundledFiles } from './builtins.js'
import { dshListRows } from './wire.js'
import { installedDsh, invalidateInstalledDsh, readInstalledIndex, upsertInstalledRecord } from './installed.js'
import { lockDsh } from './lock.js'
import * as packageLock from './lock.js'

let root: string
let original: string
it('ships Devices as an unlisted DSH with the shared daemon commands and reusable workspace', () => {
  const files = Object.fromEntries(['harness.json', 'AGENTS.md', 'template/devices.json'].map(path => [path,
    { content: readFileSync(new URL(`../../../store/agents/devices/${path}`, import.meta.url), 'utf8'), executable: false }]))
  expect(ensureBundledDevices(files)).toBe(true)
  const installed = installedDsh(DEVICES_HARNESS_ID)!
  expect(installed.manifest.workspace?.marker).toBe('devices.json')
  expect(installed.manifest.agent?.env?.DSH_PERMISSION_MODE).toBe('ask')
  expect(dshListRows([installed], [])).toEqual([])
  expect(files['AGENTS.md']!.content).toContain('harness hardware list --json')
  expect(ensureBundledDevices(files)).toBe(true)
  expect(installedDsh(DEVICES_HARNESS_ID)?.dir).toBe(installed.dir)
})
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'model-manager-bundle-'))
  original = env.DSH_DIR
  env.DSH_DIR = root
  invalidateInstalledDsh()
})
afterEach(() => {
  vi.unstubAllGlobals()
  env.DSH_DIR = original
  invalidateInstalledDsh()
  rmSync(root, { recursive: true, force: true })
})

it('uses the embedded release bundle and returns unavailable in unbundled development', () => {
  expect(ensureBundledModelManager()).toBe(false)
  expect(ensureBundledModelManager({})).toBe(false)
  vi.stubGlobal('__MODEL_MANAGER_BUNDLE__', JSON.stringify(bundle()))
  expect(ensureBundledModelManager()).toBe(true)
  expect(installedDsh(MODEL_MANAGER_ID)?.manifest.name).toBe('Model Manager')
})

it('joins a later attempt after another installer releases the package lock', () => {
  const release = lockDsh(MODEL_MANAGER_ID)!
  expect(ensureBundledModelManager(bundle())).toBe(false)
  expect(installedDsh(MODEL_MANAGER_ID)).toBeUndefined()
  release()
  expect(ensureBundledModelManager(bundle())).toBe(true)
})

it('reuses an already materialized package when restoring an older bundled revision', () => {
  ensureBundledModelManager(bundle('one'))
  const first = installedDsh(MODEL_MANAGER_ID)!
  ensureBundledModelManager(bundle('two'))
  expect(ensureBundledModelManager(bundle('one'))).toBe(true)
  expect(installedDsh(MODEL_MANAGER_ID)?.dir).toBe(first.dir)
})

it.each(['not json', JSON.stringify({ spec: 1, id: 'other/package', name: 'Wrong', engine: 'codex' })])('rejects an invalid embedded manifest and releases its lock', content => {
  expect(() => ensureBundledModelManager({ ...bundle(), 'harness.json': { content, executable: false } })).toThrow('Invalid bundled Model Manager')
  expect(installedDsh(MODEL_MANAGER_ID)).toBeUndefined()
  expect(ensureBundledModelManager(bundle())).toBe(true)
})
const bundle = (instructions = 'Help with local models') => ({
  'harness.json': { content: JSON.stringify({ spec: 1, id: MODEL_MANAGER_ID, name: 'Model Manager', engine: 'codex' }), executable: false },
  'AGENTS.md': { content: instructions, executable: false },
  'toolchain/fleet': { content: '#!/bin/sh\nexit 0\n', executable: true },
})

it('installs offline, preserves executable files, and reuses the installed version', () => {
  expect(ensureBundledModelManager(bundle())).toBe(true)
  const first = installedDsh(MODEL_MANAGER_ID)!
  expect(first.manifest.name).toBe('Model Manager')
  expect(statSync(join(first.dir, 'toolchain/fleet')).mode & 0o777).toBe(0o700)
  expect(ensureBundledModelManager(bundle())).toBe(true)
  expect(installedDsh(MODEL_MANAGER_ID)?.dir).toBe(first.dir)
})

it('updates the bundled version without deleting resources a running manager uses', () => {
  ensureBundledModelManager(bundle('version one'))
  const first = installedDsh(MODEL_MANAGER_ID)!
  ensureBundledModelManager(bundle('version two'))
  const second = installedDsh(MODEL_MANAGER_ID)!
  expect(second.dir).not.toBe(first.dir)
  expect(readFileSync(join(second.dir, 'AGENTS.md'), 'utf8')).toBe('version two')
  expect(existsSync(join(first.dir, 'AGENTS.md'))).toBe(true)
})

it('keeps a developer linked package and refuses invalid bundled paths', () => {
  expect(() => ensureBundledModelManager({ ...bundle(), '../escape': { content: 'no', executable: false } })).toThrow('Invalid built-in package path')
  expect(installedDsh(MODEL_MANAGER_ID)).toBeUndefined()
  ensureBundledModelManager(bundle())
  const first = installedDsh(MODEL_MANAGER_ID)!
  upsertInstalledRecord({ ...first, linked: true, source: '/my/checkout' })
  expect(ensureBundledModelManager(bundle('release update'))).toBe(true)
  expect(installedDsh(MODEL_MANAGER_ID)?.source).toBe('/my/checkout')
  expect(readFileSync(join(first.dir, 'AGENTS.md'), 'utf8')).toBe('Help with local models')
})

const coreFiles = (id: string, text = 'release resources'): BundledFiles => ({
  'harness.json': { content: JSON.stringify({ spec: 1, id, name: 'Core tool', engine: 'opencode' }), executable: false },
  'AGENTS.md': { content: text, executable: false },
})

it('migrates existing official monitor installations, retaining old files and workspace content', () => {
  const oldDir = join(root, 'autonomous', 'harness-monitor')
  const workspace = join(root, 'existing-workspace')
  mkdirSync(oldDir, { recursive: true }); mkdirSync(workspace)
  for (const [name, file] of Object.entries(coreFiles(HARNESS_MONITOR_ID, 'old instructions'))) writeFileSync(join(oldDir, name), file.content)
  writeFileSync(join(workspace, 'NOTES.md'), 'user notes and history')
  upsertInstalledRecord({ id: HARNESS_MONITOR_ID, dir: oldDir,
    source: 'https://github.com/autonomous-ai/autonomous-harness.git', path: 'store/agents/harness-monitor',
    ref: 'old-release', commit: 'a'.repeat(40), revision: 'b'.repeat(40), linked: false, installedAt: 123 })
  expect(ensureBundledHarnessMonitor(coreFiles(HARNESS_MONITOR_ID))).toBe(true)
  const updated = installedDsh(HARNESS_MONITOR_ID)!
  expect(updated.source).toBe(HARNESS_MONITOR_BUILTIN_SOURCE)
  expect(updated.installedAt).toBe(123)
  expect(updated.dir).not.toBe(oldDir)
  expect(readFileSync(join(updated.dir, 'AGENTS.md'), 'utf8')).toBe('release resources')
  expect(readFileSync(join(oldDir, 'AGENTS.md'), 'utf8')).toBe('old instructions')
  expect(readFileSync(join(workspace, 'NOTES.md'), 'utf8')).toBe('user notes and history')
  expect(dshListRows([updated], [{ id: HARNESS_MONITOR_ID, name: 'Monitor', engine: 'opencode',
    repo: 'https://github.com/autonomous-ai/openharness', path: 'store/agents/harness-monitor', ref: 'c'.repeat(40) }])[0].updateAvailable).toBe(false)
})

it.each([
  { source: '/developer/monitor', path: undefined, linked: true },
  { source: 'https://github.com/example/monitor', path: 'store/agents/harness-monitor', linked: false },
  { source: 'https://github.com/autonomous-ai/openharness', path: 'custom/monitor', linked: false },
])('preserves linked and custom monitor installations, including broken ones: %j', record => {
  upsertInstalledRecord({ id: HARNESS_MONITOR_ID, dir: join(root, 'missing-custom-copy'),
    ref: 'main', commit: null, installedAt: 123, ...record })
  const before = readInstalledIndex()
  expect(ensureBundledHarnessMonitor(coreFiles(HARNESS_MONITOR_ID))).toBe(true)
  expect(readInstalledIndex()).toEqual(before)
})

it('refreshes every bundled core tool together and leaves ordinary Store apps alone', () => {
  const blender = { id: 'autonomous/blender', dir: join(root, 'blender'), source: 'https://github.com/autonomous-ai/openharness',
    path: 'store/agents/blender', ref: 'old-ref', commit: 'a'.repeat(40), linked: false, installedAt: 123 }
  upsertInstalledRecord(blender)
  vi.stubGlobal('__MODEL_MANAGER_BUNDLE__', JSON.stringify(coreFiles(MODEL_MANAGER_ID)))
  vi.stubGlobal('__DEVICES_BUNDLE__', JSON.stringify(coreFiles(DEVICES_HARNESS_ID)))
  vi.stubGlobal('__HARNESS_MONITOR_BUNDLE__', JSON.stringify(coreFiles(HARNESS_MONITOR_ID)))
  vi.stubGlobal('__MEMORIES_BUNDLE__', JSON.stringify(coreFiles(MEMORIES_ID)))
  expect(ensureBundledCoreHarnesses()).toBe(true)
  expect(installedDsh(MEMORIES_ID)!.source).toBe(MEMORIES_BUILTIN_SOURCE)
  const oldDevices = installedDsh(DEVICES_HARNESS_ID)!, oldMonitor = installedDsh(HARNESS_MONITOR_ID)!
  vi.stubGlobal('__DEVICES_BUNDLE__', JSON.stringify(coreFiles(DEVICES_HARNESS_ID, 'next release')))
  vi.stubGlobal('__HARNESS_MONITOR_BUNDLE__', JSON.stringify(coreFiles(HARNESS_MONITOR_ID, 'next release')))
  expect(ensureBundledCoreHarnesses()).toBe(true)
  expect(installedDsh(DEVICES_HARNESS_ID)!.dir).not.toBe(oldDevices.dir)
  expect(installedDsh(HARNESS_MONITOR_ID)!.dir).not.toBe(oldMonitor.dir)
  expect(existsSync(oldDevices.dir)).toBe(true)
  expect(existsSync(oldMonitor.dir)).toBe(true)
  expect(readInstalledIndex().find(row => row.id === blender.id)).toEqual(blender)
  // A CLI rollback restores its corresponding core revision without touching the retained one.
  vi.stubGlobal('__HARNESS_MONITOR_BUNDLE__', JSON.stringify(coreFiles(HARNESS_MONITOR_ID)))
  expect(ensureBundledCoreHarnesses()).toBe(true)
  expect(installedDsh(HARNESS_MONITOR_ID)!.dir).toBe(oldMonitor.dir)
})

it('an unavailable or invalid core bundle does not prevent the remaining tools from updating', () => {
  const log = vi.fn()
  expect(ensureBundledCoreHarnesses(log)).toBe(false)
  vi.stubGlobal('__MODEL_MANAGER_BUNDLE__', 'invalid json')
  vi.stubGlobal('__DEVICES_BUNDLE__', JSON.stringify(coreFiles(DEVICES_HARNESS_ID)))
  vi.stubGlobal('__HARNESS_MONITOR_BUNDLE__', JSON.stringify(coreFiles(HARNESS_MONITOR_ID)))
  expect(ensureBundledCoreHarnesses(log)).toBe(false)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Model Manager'))
  expect(installedDsh(DEVICES_HARNESS_ID)).toBeDefined()
  expect(installedDsh(HARNESS_MONITOR_ID)).toBeDefined()
})

it('ships a complete monitor viewer with byte-identical binary icons and executable launchers', async () => {
  // @ts-expect-error — production build helper is plain ESM without a declaration file
  const { readHarnessMonitorBundle } = await import('../../scripts/lib/modelManagerBundle.mjs')
  const source = new URL('../../../store/agents/harness-monitor/', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  const files = readHarnessMonitorBundle(fileURLToPath(source)) as BundledFiles
  vi.stubGlobal('__HARNESS_MONITOR_BUNDLE__', JSON.stringify(files))
  expect(ensureBundledHarnessMonitor()).toBe(true)
  const installed = installedDsh(HARNESS_MONITOR_ID)!
  for (const name of ['harness.json', 'viewer.mjs', 'viewer/index.html', 'viewer/table.js', 'lib/bridge.mjs',
    'toolchain/hps.mjs', 'viewer/icons/codex.png', 'viewer/icons/claude.png', 'skills/fleet-operations/SKILL.md']) {
    expect(readFileSync(join(installed.dir, name))).toEqual(readFileSync(new URL(name, source)))
  }
  for (const name of ['viewer.sh', 'toolchain/hps', 'toolchain/init-workspace.sh']) expect(statSync(join(installed.dir, name)).mode & 0o111).not.toBe(0)
})


// Quiet-machine QA found these rollback and failure-isolation paths outside the coverage gate.
it.each(['invalid JSON', 'a different package'])('refuses a retained revision with %s without replacing the current package', scenario => {
  ensureBundledModelManager(bundle('one'))
  const retained = installedDsh(MODEL_MANAGER_ID)!
  ensureBundledModelManager(bundle('two'))
  const current = installedDsh(MODEL_MANAGER_ID)!
  writeFileSync(join(retained.dir, 'harness.json'), scenario === 'invalid JSON' ? '{' :
    JSON.stringify({ spec: 1, id: 'example/other', name: 'Other package', engine: 'codex' }))

  expect(() => ensureBundledModelManager(bundle('one'))).toThrow('Invalid bundled Model Manager')
  expect(installedDsh(MODEL_MANAGER_ID)?.dir).toBe(current.dir)
  expect(readFileSync(join(current.dir, 'AGENTS.md'), 'utf8')).toBe('two')
  // The failed rollback releases the lock, so the next valid revision can still be installed.
  expect(ensureBundledModelManager(bundle('three'))).toBe(true)
  expect(readFileSync(join(installedDsh(MODEL_MANAGER_ID)!.dir, 'AGENTS.md'), 'utf8')).toBe('three')
})

it('reports a non-Error dependency failure and still prepares the other bundled tools', () => {
  const log = vi.fn()
  vi.stubGlobal('__MODEL_MANAGER_BUNDLE__', JSON.stringify(bundle()))
  vi.stubGlobal('__DEVICES_BUNDLE__', JSON.stringify(coreFiles(DEVICES_HARNESS_ID)))
  vi.stubGlobal('__HARNESS_MONITOR_BUNDLE__', JSON.stringify(coreFiles(HARNESS_MONITOR_ID)))
  const failure = vi.spyOn(packageLock, 'lockDsh').mockImplementationOnce(() => { throw 'lock backend unavailable' })
  try {
    expect(ensureBundledCoreHarnesses(log)).toBe(false)
    expect(log).toHaveBeenCalledExactlyOnceWith('[core-harnesses] Could not prepare Model Manager: lock backend unavailable')
    expect(installedDsh(MODEL_MANAGER_ID)).toBeUndefined()
    expect(installedDsh(DEVICES_HARNESS_ID)).toBeDefined()
    expect(installedDsh(HARNESS_MONITOR_ID)).toBeDefined()
  } finally { failure.mockRestore() }
})

it('ships Memories with the release, adopting the Store copy and never a developer\'s linked one', () => {
  // A person who got Memories from the Store before it shipped with Harness: the release takes it over.
  const storeDir = join(root, 'autonomous', 'memories')
  mkdirSync(storeDir, { recursive: true })
  for (const [name, file] of Object.entries(coreFiles(MEMORIES_ID, 'from the store'))) writeFileSync(join(storeDir, name), file.content)
  upsertInstalledRecord({ id: MEMORIES_ID, dir: storeDir, source: 'https://github.com/autonomous-ai/openharness', path: 'store/agents/memories',
    ref: 'main', commit: 'b'.repeat(40), linked: false, installedAt: 9 })
  expect(ensureBundledMemories(coreFiles(MEMORIES_ID))).toBe(true)
  expect(installedDsh(MEMORIES_ID)!.source).toBe(MEMORIES_BUILTIN_SOURCE)
  expect(installedDsh(MEMORIES_ID)!.installedAt).toBe(9)
  const linked = join(root, 'developer-memories')
  upsertInstalledRecord({ id: MEMORIES_ID, dir: linked, source: linked, ref: 'main', commit: null, linked: true, installedAt: 1 })
  expect(ensureBundledMemories(coreFiles(MEMORIES_ID, 'next release'))).toBe(true)
  expect(readInstalledIndex().find(row => row.id === MEMORIES_ID)!.dir).toBe(linked)
  expect(ensureBundledMemories({})).toBe(false)
})
