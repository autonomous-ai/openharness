import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from './settings.js'
import { StateFile } from './stateFile.js'

const settings = defaultSettings({ timeZone: 'UTC', languages: 'en-US' })

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-browser-state-'))
  path = join(dir, 'agent-browser.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('StateFile', () => {
  it('a missing file reads as empty', () => {
    expect(new StateFile(path).read()).toEqual({ browsers: {}, deleting: [], setup: null })
  })

  it('update is atomic and 0600', () => {
    const file = new StateFile(path)
    file.update(s => { s.browsers.a1 = settings })
    file.update(s => { s.deleting.push('a2'); s.setup = { step: 'starting_podman' } })
    expect(file.read()).toEqual({ browsers: { a1: settings }, deleting: ['a2'], setup: { step: 'starting_podman' } })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    // Written beside and renamed over: no half-written file, and nothing left behind.
    expect(readdirSync(dir)).toEqual(['agent-browser.json'])
    const before = readFileSync(path, 'utf8')
    expect(() => file.update(() => { throw new Error('changed my mind') })).toThrow('changed my mind')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('a file with no told reads as nobody told, and update keeps a told it does not know', () => {
    writeFileSync(path, JSON.stringify({ browsers: { a1: settings }, deleting: [], setup: null }))
    const file = new StateFile(path)
    expect(file.read().told?.a1).toBeUndefined()
    file.update(s => { s.told = { a1: true } })
    file.update(s => { s.deleting.push('a2') })
    expect(file.read()).toEqual({ browsers: { a1: settings }, deleting: ['a2'], setup: null, told: { a1: true } })
  })

  it("an entry's profile is read back as written, and an entry without one is read as before", () => {
    // a2 took a1's browser with its pane; a3's never moved, and its entry is what an older CLI writes and reads.
    writeFileSync(path, JSON.stringify({ browsers: { a3: settings }, deleting: [], setup: null }))
    const file = new StateFile(path)
    file.update(s => { s.browsers.a2 = { ...settings, profile: 'a1' } })
    expect(file.read().browsers).toEqual({ a2: { ...settings, profile: 'a1' }, a3: settings })
    expect(file.read().browsers.a2!.profile).toBe('a1')
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).browsers.a3)).toEqual(Object.keys(settings))
  })

  it('a file that cannot be parsed throws state_unreadable and is not rewritten', () => {
    for (const broken of ['{"browsers": {', '[]', '{"browsers": {}, "deleting": "a1", "setup": null}']) {
      writeFileSync(path, broken)
      const file = new StateFile(path)
      expect(() => file.read()).toThrow(expect.objectContaining({ state: 'state_unreadable' }))
      expect(() => file.update(s => { s.deleting.push('a1') })).toThrow(expect.objectContaining({ state: 'state_unreadable' }))
      expect(readFileSync(path, 'utf8')).toBe(broken)
    }
  })
})
