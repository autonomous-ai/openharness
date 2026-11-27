import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { homes } from '../lib/agents.mjs'

/** A home holding the given Harness folders, as a fresh, a legacy or a moved install leaves it. */
function homeWith(...folders) {
  const home = mkdtempSync(join(tmpdir(), 'memories-home-'))
  for (const folder of folders) mkdirSync(join(home, ...folder), { recursive: true })
  return home
}

test('About You is in <data>/memory, MEMORIES_HOME first', () => {
  const fresh = homeWith()
  assert.equal(homes({}, fresh, 'linux').memory, join(fresh, '.local', 'share', 'harness', 'memory'))
  const base = join(fresh, 'data')
  assert.equal(homes({ XDG_DATA_HOME: base }, fresh, 'linux').memory, join(base, 'harness', 'memory'))
  assert.equal(homes({ MEMORIES_HOME: '/elsewhere/memory' }, fresh, 'linux').memory, '/elsewhere/memory')
})

test('the session index is read from the daemon\'s data folder', () => {
  const moved = homeWith(['.local', 'share', 'harness'], ['.harness'])
  assert.equal(homes({}, moved, 'linux').harnessData, join(moved, '.harness', 'cli', 'data'), 'a data root without the marker')
  writeFileSync(join(moved, '.local', 'share', 'harness', '.harness-root'), '1\n', { mode: 0o600 })
  assert.equal(homes({}, moved, 'linux').harnessData, join(moved, '.local', 'share', 'harness', 'cli', 'data'))
  assert.equal(homes({ ADAPTER_DATA_DIR: '/elsewhere/data' }, moved, 'linux').harnessData, '/elsewhere/data')
  assert.equal(homes({ ADAPTER_DATA_DIR: 'own/data' }, moved, 'linux').harnessData, join(moved, 'own', 'data'), 'a relative one is under the home')
})

test('on macOS and on a Linux home not moved yet, both stay under ~/.harness', () => {
  const legacy = homeWith(['.harness'])
  const mac = homeWith(['.local', 'share', 'harness'])
  for (const [home, platform] of [[legacy, 'linux'], [mac, 'darwin']]) {
    const h = homes({}, home, platform)
    assert.equal(h.memory, join(home, '.harness', 'memory'), platform)
    assert.equal(h.harnessData, join(home, '.harness', 'cli', 'data'), platform)
  }
})
