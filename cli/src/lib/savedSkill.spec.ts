import { describe, expect, it } from 'vitest'
import { isSwarmRole, parseSwarmSkill, roleFromWire, wireRole } from './savedSkill.js'

describe('Swarm role kinds (project instructions, phase 4)', () => {
  it('reads saved rows of both shapes', () => {
    // An older CLI saved the wire's values.
    expect(parseSwarmSkill({ role: 'lead', key: 'k' })).toEqual({ role: 'coordinator', key: 'k' })
    expect(parseSwarmSkill({ role: 'dev', key: 'k' })).toEqual({ role: 'agent', key: 'k' })
    expect(parseSwarmSkill({ role: 'review', key: 'k', github: true })).toEqual({ role: 'agent', fallback: 'review', key: 'k', github: true })
    // This one saves the kinds.
    expect(parseSwarmSkill({ role: 'agent', key: 'k' })).toEqual({ role: 'agent', key: 'k' })
    // A skill mode an older release saved is read as nothing (the modes are gone, PM 2026-11-11).
    expect(parseSwarmSkill({ role: 'coordinator', key: 'k', mode: 'orchestration' })).toEqual({ role: 'coordinator', key: 'k' })
    expect(parseSwarmSkill({ role: 'agent', fallback: 'review', key: 'k' })).toEqual({ role: 'agent', fallback: 'review', key: 'k' })
    // A fallback is a Reviewer's file only, kept for an agent alone.
    expect(parseSwarmSkill({ role: 'agent', fallback: 'lead', key: 'k' })).toEqual({ role: 'agent', key: 'k' })
    expect(parseSwarmSkill({ role: 'coordinator', fallback: 'review', key: 'k' })).toEqual({ role: 'coordinator', key: 'k' })
    // The v3 Buddy is gone: a row saved for one starts no Swarm role.
    for (const role of ['buddy', 'pm', 'builder', 'reviewer', 'Coordinator', 7, null]) expect(parseSwarmSkill({ role, key: 'k' })).toBeUndefined()
    expect(parseSwarmSkill({ role: 'agent', key: '' })).toBeUndefined()
  })

  it('takes both value sets from the wire and gives back the values an older machine knows', () => {
    expect(roleFromWire('lead')).toEqual({ role: 'coordinator' })
    expect(roleFromWire('dev')).toEqual({ role: 'agent' })
    expect(roleFromWire('review')).toEqual({ role: 'agent', fallback: 'review' })
    expect(roleFromWire('coordinator')).toEqual({ role: 'coordinator' })
    expect(roleFromWire('agent')).toEqual({ role: 'agent' })
    for (const value of ['buddy', 'pm', 'reviewer', 'builder', '', 7, null, undefined, { role: 'dev' }]) expect(roleFromWire(value)).toBeNull()
    for (const value of ['lead', 'dev', 'review'] as const) expect(wireRole(roleFromWire(value)!)).toBe(value)
    for (const skill of [{ role: 'coordinator' }, { role: 'agent' }, { role: 'agent', fallback: 'review' }] as const) {
      expect(roleFromWire(wireRole(skill))).toEqual(skill)
    }
  })

  it('checks a role against the kinds only', () => {
    for (const role of ['coordinator', 'agent']) expect(isSwarmRole(role)).toBe(true)
    for (const role of ['buddy', 'lead', 'dev', 'review', 'pm']) expect(isSwarmRole(role)).toBe(false)
  })
})
