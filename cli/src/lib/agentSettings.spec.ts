import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SETTING_NAMES, agentSettingsPath, readAgentSettings, writeAgentSettings } from './agentSettings.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-settings-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('what the person lets agents do', () => {
  it('lets agents start agents until the person turns it off', () => {
    expect(readAgentSettings(dir)).toEqual({ agentsStartAgents: true })
    expect(writeAgentSettings(dir, { agentsStartAgents: false })).toEqual({ agentsStartAgents: false })
    expect(readAgentSettings(dir)).toEqual({ agentsStartAgents: false })
    expect(JSON.parse(readFileSync(agentSettingsPath(dir), 'utf8'))).toEqual({ version: 1, agentsStartAgents: false })
    expect(statSync(agentSettingsPath(dir)).mode & 0o777).toBe(0o600)
    expect(AGENT_SETTING_NAMES['agents-start-agents']).toBe('agentsStartAgents')
  })

  it('applies only booleans it knows, and reads a broken file as the defaults', () => {
    expect(writeAgentSettings(dir, null)).toBeNull()
    expect(writeAgentSettings(dir, 'off')).toBeNull()
    expect(writeAgentSettings(dir, { agentsStartAgents: 'no', other: true })).toBeNull()
    expect(writeAgentSettings(dir, { agentsStartAgents: false, other: true })).toEqual({ agentsStartAgents: false })
    writeFileSync(agentSettingsPath(dir), '{"agentsStartAgents": "nope"}')
    expect(readAgentSettings(dir)).toEqual({ agentsStartAgents: true })
    writeFileSync(agentSettingsPath(dir), 'not json')
    expect(readAgentSettings(dir)).toEqual({ agentsStartAgents: true })
  })
})
