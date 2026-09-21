import { describe, expect, it } from 'vitest'
import { automaticAgentName, engineLabel, isAutomaticName, projectFolderName } from './agentNames.js'
import { ENGINES } from '../engines/types.js'

describe('agent names: who and when', () => {
  it('names every engine the way the app does, and passes an unknown one through', () => {
    for (const engine of ENGINES) expect(engineLabel(engine)).toMatch(/^[A-Z]/)
    expect(engineLabel('claude')).toBe('Claude')
    expect(engineLabel('agy')).toBe('Antigravity')
    expect(engineLabel('newcomer')).toBe('newcomer')
  })

  it('writes the name in local time, no zero on month, day or hour, two digits for minutes and seconds', () => {
    expect(automaticAgentName('Codex', new Date(2026, 8, 17, 15, 26))).toBe('Codex harness 9-17 15:26')
    expect(automaticAgentName('Blender', new Date(2026, 8, 3, 9, 5, 7))).toBe('Blender harness 9-3 9:05')
    expect(automaticAgentName('Blender', new Date(2026, 8, 3, 9, 5, 7), true)).toBe('Blender harness 9-3 9:05:07')
    expect(automaticAgentName('Claude', new Date(2026, 11, 25, 0, 0))).toBe('Claude harness 12-25 0:00')
    expect(automaticAgentName('  ', new Date(2026, 0, 1, 23, 59))).toBe('Agent harness 1-1 23:59')
  })

  it('knows a name Harness gave from one somebody chose', () => {
    for (const name of ['Codex harness 9-17 15:26', 'Blender harness 9-3 9:05:07', 'Autonomous Circuit harness 12-25 0:00', 'harness-43', 'agent-7']) {
      expect(isAutomaticName(name)).toBe(true)
    }
    for (const name of ['Local model', 'My harness', 'Codex harness', 'harness-0', 'harness-4x', 'Codex harness 9-17', '', null, undefined]) {
      expect(isAutomaticName(name)).toBe(false)
    }
  })

  it('writes the folder as a slug and a sortable date and time', () => {
    expect(projectFolderName('Autonomous Circuit', new Date(2026, 8, 3, 9, 5, 7))).toBe('autonomous-circuit-2026-09-03-09-05')
    expect(projectFolderName('text-to-cad', new Date(2026, 8, 3, 9, 5, 7), true)).toBe('text-to-cad-2026-09-03-09-05-07')
    expect(projectFolderName('Café Studio', new Date(2026, 11, 25, 15, 26))).toBe('cafe-studio-2026-12-25-15-26')
    expect(projectFolderName('***', new Date(2026, 11, 25, 15, 26))).toBe('harness-2026-12-25-15-26')
  })
})
