import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { firstMachines, machineRuleRefusal } from './machineRules.js'

// The backend's own cases (backend superTabs/machineRules.cases.json): the route's early filter decides as the server does
// (security review 1 of #3964).
const cases = JSON.parse(readFileSync(fileURLToPath(new URL('../../../backend/src/superTabs/machineRules.cases.json', import.meta.url)), 'utf8')) as {
  rules: Array<Record<string, unknown>>; refusals: Array<{ at: string; machineId: string; engine: string; review: boolean; why: string | null }>
  first: Array<{ lane: string | null; machines: string[] }> }

describe('the route\'s machine rules', () => {
  it('refuse as the server does, for each shared case', () => {
    for (const c of cases.refusals) expect(machineRuleRefusal(cases.rules, c, Date.parse(c.at)), JSON.stringify(c)).toBe(c.why)
  })
  it('place a lane\'s work as the server does, for each shared case', () => {
    for (const c of cases.first) expect([...firstMachines(cases.rules, c.lane)?.machines ?? []]).toEqual(c.machines)
  })
})
