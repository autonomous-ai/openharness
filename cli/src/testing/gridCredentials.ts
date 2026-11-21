/** Unit-fixture credential custody. Real storage/recovery tests use the actual child. */
import { randomUUID, createHash } from 'node:crypto'
import type { GridLaunchOverride } from '../lib/gridLaunchWire.js'
import type { CredentialRow, StoredGridLaunch } from '../lib/sessionStorageWire.js'
import { afterEach, expect } from 'vitest'
import { storedGridLaunch } from '../lib/sessionStorageWire.js'

const selected = new Map<string, GridLaunchOverride>()
afterEach(() => selected.clear())

export function storedGridFixture(override: GridLaunchOverride, row: CredentialRow = { agentId: 'fixture', registeredAt: 1 }): StoredGridLaunch {
  const { apiKey: _key, ...metadata } = override
  const reference: StoredGridLaunch = { ...metadata, credential: {
    version: 1, binding: createHash('sha256').update(randomUUID()).digest('hex'), row,
    source: { kind: 'import', lease: randomUUID() },
  } }
  selected.set(reference.credential.binding, { ...override })
  return reference
}

export const fixtureGridOverride = (reference: StoredGridLaunch): GridLaunchOverride | undefined => selected.get(reference.credential.binding)

/** Only a fixture reference backed by the private resolver may become a stable golden value. */
export function gridFixtureSnapshot(_key: string, value: unknown): unknown {
  if (!storedGridLaunch(value)) return value
  const original = fixtureGridOverride(value)
  expect(original !== undefined).toBe(true)
  const { apiKey: _secret, ...metadata } = original!
  const { credential, ...actual } = value
  expect(actual).toEqual(metadata)
  expect(credential.source.kind).toBe('import')
  return { ...actual, credential: { version: credential.version, binding: '<fixture-binding>', row: credential.row,
    source: { kind: 'import', lease: '<fixture-lease>' } } }
}
