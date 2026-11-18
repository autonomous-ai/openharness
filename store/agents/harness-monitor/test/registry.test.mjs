import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { registryPath } from '../lib/registry.mjs'

test("the registry is read from the daemon's data folder, HPS_REGISTRY and HARNESS_HOME first", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  t.after(() => Object.defineProperty(process, 'platform', platform))
  const home = mkdtempSync(join(tmpdir(), 'hps-home-'))
  mkdirSync(join(home, '.harness'))

  Object.defineProperty(process, 'platform', { value: 'linux' })
  assert.equal(registryPath({ HOME: home }), join(home, '.harness', 'cli', 'data', 'registry.json'), 'a Linux home not moved yet')
  mkdirSync(join(home, '.local', 'share', 'harness'), { recursive: true })
  assert.equal(registryPath({ HOME: home }), join(home, '.local', 'share', 'harness', 'cli', 'data', 'registry.json'), 'a Linux home moved')
  assert.equal(registryPath({ HOME: home, ADAPTER_DATA_DIR: '/d' }), join('/d', 'registry.json'))
  assert.equal(registryPath({ HOME: home, ADAPTER_DATA_DIR: '/d', HARNESS_HOME: '/h' }), join('/h', 'cli', 'data', 'registry.json'))
  assert.equal(registryPath({ HOME: home, HARNESS_HOME: '/h', HPS_REGISTRY: '/r.json' }), '/r.json')

  Object.defineProperty(process, 'platform', { value: 'darwin' })
  assert.equal(registryPath({ HOME: home }), join(home, '.harness', 'cli', 'data', 'registry.json'), 'macOS keeps ~/.harness')
})
