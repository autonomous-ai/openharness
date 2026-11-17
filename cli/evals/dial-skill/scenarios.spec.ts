import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { caseId, loadScenarios } from './lib/scenarios.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dial-skill-scenarios-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function scenario(id: string, json: Record<string, unknown>, withRepo = true): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(json))
  if (withRepo) mkdirSync(join(dir, 'repo'))
}

const needJson = {
  need: 'need',
  kind: 'secret',
  prompt: 'Generate the report.',
  ask: 'give WEATHER_API_KEY',
  secrets: ['wx_FAKE123'],
  origin: false,
  check: { run: 'npm run report', expect: 'WEATHER_API_KEY is not set' },
}

const noNeedJson = {
  need: 'no-need',
  kind: 'bug',
  prompt: 'Fix the pagination tests.',
  secrets: [],
  origin: true,
  check: { run: 'npm test', expect: 'failed' },
}

describe('loadScenarios', () => {
  it('loads every scenario, sorted by id', () => {
    scenario('zeta-need', needJson)
    scenario('alpha-no-need', noNeedJson)

    expect(loadScenarios(root)).toEqual([
      { id: 'alpha-no-need', ...noNeedJson, ask: null, need: 'no-need', dir: join(root, 'alpha-no-need') },
      { id: 'zeta-need', ...needJson, dir: join(root, 'zeta-need') },
    ])
  })

  it('rejects a need scenario without an ask', () => {
    const { ask: _ask, ...noAsk } = needJson
    scenario('no-ask', noAsk)
    expect(() => loadScenarios(root)).toThrow(/no-ask/)
  })

  it('rejects a no-need scenario with an ask', () => {
    scenario('has-ask', { ...noNeedJson, ask: 'something' })
    expect(() => loadScenarios(root)).toThrow(/has-ask/)
  })

  it('rejects an id outside lowercase letters, digits and dashes', () => {
    scenario('Bad_Id', needJson)
    expect(() => loadScenarios(root)).toThrow(/Bad_Id/)
  })

  it('rejects a scenario without repo/', () => {
    scenario('no-repo', needJson, false)
    expect(() => loadScenarios(root)).toThrow(/no-repo/)
  })
})

describe('caseId', () => {
  it('joins the scenario id and the agent', () => {
    expect(caseId('a', 'claude')).toBe('a.claude')
  })
})
