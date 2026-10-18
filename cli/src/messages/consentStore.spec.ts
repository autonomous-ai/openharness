import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Roster } from './roster.js'
import { ConsentStore, consentKey } from './consentStore.js'

const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6', OTHER = 'f'.repeat(24)
const listing = (...agents: string[]) => ({ harnesses: agents.map((agentId) => ({ machineId: 'bob-mac', agentId })) }) as unknown as Roster

describe('the consent store', () => {
  let dir: string, path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'consent-')); path = join(dir, 'consent.json') })
  afterEach(() => { try { chmodSync(path, 0o600) } catch { /* not there */ } rmSync(dir, { recursive: true, force: true }) })

  it('keeps what this machine asked for across a restart, privately, and says it changed after each save', () => {
    let changes = 0
    const store = new ConsentStore(path, Date.now, () => { changes++ })
    expect(ConsentStore.read(path)).toEqual(new Set())
    store.grant(TAB, 'bob-mac', 'api', false)
    store.grant(OTHER, 'bob-mac', 'web', true)
    expect(changes).toBe(2)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(ConsentStore.read(path)).toEqual(new Set([consentKey(TAB, 'bob-mac', 'api'), consentKey(OTHER, 'bob-mac', 'web')]))
    expect(new ConsentStore(path).keys()).toEqual(store.keys())
    // Asking again for what is held saves nothing.
    store.grant(OTHER, 'bob-mac', 'web', true)
    store.revoke(TAB, 'bob-mac', 'nothing')
    expect(changes).toBe(2)
    store.revoke(TAB, 'bob-mac', 'api')
    expect(store.keys()).toEqual(new Set([consentKey(OTHER, 'bob-mac', 'web')]))
    store.forgetTab(OTHER)
    expect(ConsentStore.read(path)).toEqual(new Set())
    expect(changes).toBe(4)
  })

  it('follows the rosters: a harness listed and then taken out by the owner needs asking again', () => {
    const store = new ConsentStore(path)
    store.grant(TAB, 'bob-mac', 'api', false)
    store.grant(TAB, 'bob-mac', 'web', false)
    store.grant(OTHER, 'bob-mac', 'db', true)
    // Asked but not yet listed (the owner has not applied it): kept. A tab with no roster held (pinned again): kept.
    store.reconcile((id) => (id === TAB ? listing('web') : null))
    expect(store.keys()).toEqual(new Set([consentKey(TAB, 'bob-mac', 'api'), consentKey(TAB, 'bob-mac', 'web'), consentKey(OTHER, 'bob-mac', 'db')]))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toContainEqual({ sharedTabId: TAB, machineId: 'bob-mac', agentId: 'web', listed: true })
    // The owner took `web` out: listed before and listed no more, it goes; `api`, never listed, stays.
    store.reconcile((id) => (id === TAB ? listing() : listing()))
    expect(store.keys()).toEqual(new Set([consentKey(TAB, 'bob-mac', 'api')]))
  })

  it('moves a file that holds no list aside and starts empty; Share reads it as unreadable, revoking nothing', () => {
    writeFileSync(path, '{"half":')
    expect(ConsentStore.read(path)).toBeNull()
    const store = new ConsentStore(path, () => 7)
    expect(store.keys()).toEqual(new Set())
    expect(readdirSync(dir)).toContain('consent.json.unreadable-7')
    writeFileSync(path, '[{"sharedTabId":1}]')
    expect(ConsentStore.read(path)).toBeNull()
    // Moved aside already by someone else: still starts empty.
    rmSync(path)
    writeFileSync(path, 'x')
    chmodSync(dir, 0o500)
    try { expect(new ConsentStore(path).keys()).toEqual(new Set()) } finally { chmodSync(dir, 0o700) }
  })

  it('writes nothing over a file it cannot read, and applies what changed meanwhile once it reads again', () => {
    const store = new ConsentStore(path)
    store.grant(TAB, 'bob-mac', 'api', true)
    store.grant(TAB, 'bob-mac', 'web', true)
    chmodSync(path, 0o000)
    expect(ConsentStore.read(path)).toBeNull()
    const blind = new ConsentStore(path)
    blind.revoke(TAB, 'bob-mac', 'api')
    blind.grant(OTHER, 'bob-mac', 'db', false)
    blind.revoke(TAB, 'bob-mac', 'nothing')
    chmodSync(path, 0o600)
    expect(ConsentStore.read(path)).toEqual(new Set([consentKey(TAB, 'bob-mac', 'api'), consentKey(TAB, 'bob-mac', 'web')]))
    // Readable again: the file's entries, with the removal and the grant made meanwhile, in order.
    blind.forgetTab('none')
    expect(ConsentStore.read(path)).toEqual(new Set([consentKey(TAB, 'bob-mac', 'web'), consentKey(OTHER, 'bob-mac', 'db')]))
    // Unreadable from the start and readable at once: nothing waited, nothing to write.
    chmodSync(path, 0o000)
    const late = new ConsentStore(path)
    chmodSync(path, 0o600)
    late.revoke(OTHER, 'bob-mac', 'none')
    expect(late.keys()).toEqual(new Set([consentKey(TAB, 'bob-mac', 'web'), consentKey(OTHER, 'bob-mac', 'db')]))
  })

  it('keeps a change in memory when the disk refuses it, and says nothing changed on disk', () => {
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    let changes = 0
    try {
      const store = new ConsentStore(join(locked, 'consent.json'), Date.now, () => { changes++ })
      store.grant(TAB, 'bob-mac', 'api', false)
      expect(store.keys()).toEqual(new Set([consentKey(TAB, 'bob-mac', 'api')]))
      expect(changes).toBe(0)
    } finally { chmodSync(locked, 0o700) }
  })
})
