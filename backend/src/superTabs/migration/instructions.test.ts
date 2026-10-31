import { describe, expect, it } from 'vitest'
import { documentFor, printableReport, type InstructionsMigrationReport } from './instructions.js'
import { INSTRUCTIONS_TEMPLATE, TEMPLATE_ROUTING, TEMPLATE_WORKFLOW } from '../instructionsTemplate.js'
import { DEFAULT_ROUTING_POLICY, type RoutingPolicy } from '../routingPolicy.js'
import type { SwarmProject } from '../projects.js'
import type { SwarmRule } from '../rules.js'

const project: SwarmProject = { id: 'lead', name: 'App', ownerId: 'owner', leadConversationId: 'lead', visibility: 'public', members: [], updateMinutes: 5, skillMode: 'default' }
const rule = (text: string, projectId = 'lead'): SwarmRule => ({ id: text, projectId, rule: { kind: 'preferIdle' }, text, askedBy: 'owner', askedIn: null,
  addedBy: 'owner', createdAt: '2026-10-29T00:00:00.000Z' })

describe('the document the migration writes', () => {
  it('copies the template for a built-in skill set with no rules and the default policy', () => {
    expect(documentFor({ project, roleTexts: {}, rules: [], policy: DEFAULT_ROUTING_POLICY })).toEqual({ from: 'template', text: INSTRUCTIONS_TEMPLATE })
    expect(documentFor({ project: { ...project, skillMode: 'orchestration' }, roleTexts: {}, rules: [], policy: DEFAULT_ROUTING_POLICY }).from).toBe('template')
  })

  it('writes a custom role set one section per role, then the template\'s workflow and routing', () => {
    const custom: SwarmProject = { ...project, skillSet: 'custom', roles: [
      { id: 'lead', name: 'Coordinator', kind: 'lead', version: 'v1' },
      { id: 'dev', name: 'Builder', kind: 'builder', version: 'v2', defaults: { engine: 'codex', model: 'gpt-6-astra', effort: 'xhigh' } },
      { id: 'aaaaaaaaaaaa', name: 'QA on the device', kind: 'reviewer', version: 'v3' }] }
    const long = 'Q'.repeat(70_000)
    const { from, text } = documentFor({ project: custom, roleTexts: { lead: 'Coordinate.', dev: 'Build it.', aaaaaaaaaaaa: long }, rules: [], policy: DEFAULT_ROUTING_POLICY })
    expect(from).toBe('custom')
    expect(text).toContain('## Roles\n\n### Coordinator\n\nCoordinate.\n\n### Builder\n\nBuild it.\n\n### QA on the device\n\n')
    // Nothing is cut for length: the 64 KB limit is a save's.
    expect(text).toContain(long)
    expect(text).toContain(TEMPLATE_WORKFLOW)
    expect(text).toContain(TEMPLATE_ROUTING)
    expect(text.indexOf(TEMPLATE_WORKFLOW)).toBeGreaterThan(text.indexOf(long))
    expect(text).toContain('- Builder runs on Codex gpt-6-astra at xhigh effort unless its start names another.')
  })

  it('adds the project\'s rules in the owner\'s words, and the policy\'s notes and differences as plain lines, under Routing', () => {
    const policy: RoutingPolicy = { ...DEFAULT_ROUTING_POLICY,
      models: [...DEFAULT_ROUTING_POLICY.models.filter(m => !(m.engine === 'claude' && m.model === 'haiku'))
        .map(m => m.model === 'sonnet' ? { ...m, enabled: true } : m.model === 'opus' && m.effort === 'high' ? { ...m, cost: 5 } : m),
      { engine: 'codex', model: 'gpt-7', effort: 'high', quality: 2, cost: 9, enabled: true }],
      floor: { low: 1, medium: 3, high: 3 }, quotaReserve: 20, notes: 'Keep Opus for hard work.',
      localModels: { quality: 2, enabled: false, models: [{ model: 'kimi k3', quality: 3 }] },
      priorOverrides: [{ model: 'opus', kind: 'review', quality: 3 }] }
    const { from, text } = documentFor({ project, roleTexts: {}, rules: [rule('No Codex on machine A.'), rule('Another project\'s rule.', 'other')], policy })
    expect(from).toBe('template')
    expect(text.startsWith(INSTRUCTIONS_TEMPLATE.trimEnd())).toBe(true)
    const added = text.slice(INSTRUCTIONS_TEMPLATE.trimEnd().length)
    expect(added).toContain('- No Codex on machine A.')
    expect(added).not.toContain('Another project')
    expect(added).toContain('- Routing notes: Keep Opus for hard work.')
    expect(added).toContain('- Claude sonnet at medium effort is on.')
    expect(added).toContain('- Claude haiku at auto effort is not offered.')
    expect(added).toContain('- Claude opus at high effort counts as strength 3 of 3 at cost 5.')
    expect(added).toContain('- Codex gpt-7 at high effort is offered at strength 2 of 3, cost 9.')
    expect(added).toContain('- Work of medium difficulty needs a model of strength 3 of 3 or more.')
    expect(added).not.toContain('low difficulty')
    expect(added).toContain('- Keep 20% of each engine\'s quota in reserve.')
    expect(added).toContain('- Models on the Swarm\'s grid are off.')
    expect(added).toContain('- A model on the Swarm\'s grid counts as strength 2 of 3 unless it is named here.')
    expect(added).toContain('- Grid model kimi k3 counts as strength 3 of 3.')
    expect(added).toContain('- Grid model deepseek v4.1 has no strength of its own.')
    expect(added).toContain('- For review work, opus counts as strength 3 of 3.')
  })
})

describe('the report the script prints', () => {
  it('leaves every document\'s text out, as it holds a Swarm\'s private role texts and rules, unless that Swarm is named (review of phase 2)', () => {
    const report: InstructionsMigrationReport = { apply: false, swarms: 2, alreadyDone: 1, skipped: ['old'], failed: [{ tabId: 'bad', error: 'Changed meanwhile.' }],
      documents: [{ tabId: 'a', projectId: 'lead', from: 'template', bytes: 11, text: 'Rules of a.' },
        { tabId: 'b', projectId: 'p2', from: 'custom', bytes: 11, text: 'Roles of b.' }] }
    const sizes = [{ tabId: 'a', projectId: 'lead', from: 'template', bytes: 11 }, { tabId: 'b', projectId: 'p2', from: 'custom', bytes: 11 }]
    expect(printableReport(report)).toEqual({ ...report, documents: sizes })
    expect(printableReport(report, { textOf: 'b' }).documents).toEqual([sizes[0], { ...sizes[1], text: 'Roles of b.' }])
    expect(printableReport(report, { textOf: 'none' }).documents).toEqual(sizes)
    // The report itself keeps them: the script prints a copy.
    expect(report.documents.map(d => d.text)).toEqual(['Rules of a.', 'Roles of b.'])
  })
})
