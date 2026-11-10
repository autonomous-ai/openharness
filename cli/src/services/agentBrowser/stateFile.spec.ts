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
    file.update(s => { s.deleting.push('a2'); s.setup = { step: 'restart_needed', bootTime: 1_700_000_000 } })
    expect(file.read()).toEqual({ browsers: { a1: settings }, deleting: ['a2'], setup: { step: 'restart_needed', bootTime: 1_700_000_000 } })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    // Written beside and renamed over: no half-written file, and nothing left behind.
    expect(readdirSync(dir)).toEqual(['agent-browser.json'])
    const before = readFileSync(path, 'utf8')
    expect(() => file.update(() => { throw new Error('changed my mind') })).toThrow('changed my mind')
    expect(readFileSync(path, 'utf8')).toBe(before)
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
