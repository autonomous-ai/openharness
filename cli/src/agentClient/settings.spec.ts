import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAgentSettings } from '../lib/agentSettings.js'
import { settingsCommand, SETTINGS_USAGE } from './settings.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'settings-command-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('harness settings', () => {
  it('lists the settings, and turns one off and on', () => {
    const out: string[] = [], err: string[] = []
    const run = (...argv: string[]) => settingsCommand(argv, dir, (l) => out.push(l), (l) => err.push(l))
    expect(run()).toBe(0)
    expect(out.pop()).toBe('agents-start-agents   on   agents may start, wait for and close harnesses of their own')
    expect(run('agents-start-agents', 'off')).toBe(0)
    expect(out.pop()).toBe('agents-start-agents is off.')
    expect(readAgentSettings(dir).agentsStartAgents).toBe(false)
    expect(run()).toBe(0)
    expect(out.pop()).toMatch(/^agents-start-agents +off /)
    expect(run('agents-start-agents', 'on')).toBe(0)
    expect(readAgentSettings(dir).agentsStartAgents).toBe(true)
  })

  it('refuses what it does not know with the usage, and prints it for --help', () => {
    const out: string[] = [], err: string[] = []
    const run = (...argv: string[]) => settingsCommand(argv, dir, (l) => out.push(l), (l) => err.push(l))
    expect(run('nope', 'on')).toBe(2)
    expect(run('agents-start-agents', 'maybe')).toBe(2)
    expect(run('agents-start-agents', 'on', 'extra')).toBe(2)
    expect(err).toEqual([SETTINGS_USAGE, SETTINGS_USAGE, SETTINGS_USAGE])
    expect(run('--help')).toBe(0)
    expect(out).toEqual([SETTINGS_USAGE])
  })
})
