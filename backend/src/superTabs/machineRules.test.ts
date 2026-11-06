import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { firstMachines, machineRuleRefusal } from './machineRules.js'
import { projectRulesSchema, SEED_RULES, validMachineRules, type MachineRule } from './policy.js'

// Task #3964: the four Machines rules of the Routing instructions, as the project rules record holds them. Generic machines
// and hours: never a person's real ones in source (River, 11-05).
const RULES: MachineRule[] = [
  { machineIds: ['travels', 'travels-team'], why: 'Away while its owner travels', away: { days: [1, 2, 3, 4, 5], windows: [['07:30', '09:30'], ['18:00', '21:00']], timeZone: 'Asia/Ho_Chi_Minh' } },
  { machineIds: ['phone-mac'], why: 'The phone setup is there', first: { lanes: ['mobile'] } },
  { machineIds: ['no-codex'], why: 'No Codex there', noEngines: ['codex'] },
  { machineIds: ['local-codex'], why: 'Its Codex defaults to a local model', noReviews: true },
]
// Monday 2026-11-09 in Vietnam (UTC+7): 08:00 there is 01:00 UTC, 10:00 there 03:00 UTC, 18:30 there 11:30 UTC.
const MONDAY_8 = Date.parse('2026-11-09T01:00:00Z'), MONDAY_10 = Date.parse('2026-11-09T03:00:00Z'), MONDAY_1830 = Date.parse('2026-11-09T11:30:00Z')
// Saturday 2026-11-14 08:00 there.
const SATURDAY_8 = Date.parse('2026-11-14T01:00:00Z')
const work = (machineId: string, engine = 'claude', review = false) => ({ machineId, engine, review })

describe('machineRuleRefusal', () => {
  it('refuses a machine inside its away window, on its days, in its own time zone, for each of its ids', () => {
    expect(machineRuleRefusal(RULES, work('travels'), MONDAY_8)).toBe('Away while its owner travels')
    expect(machineRuleRefusal(RULES, work('travels-team'), MONDAY_1830)).toBe('Away while its owner travels')
    expect(machineRuleRefusal(RULES, work('travels'), MONDAY_10)).toBeNull()
    expect(machineRuleRefusal(RULES, work('travels'), SATURDAY_8)).toBeNull()
  })

  it('refuses an engine where a rule says no agent of it runs, and only that engine', () => {
    expect(machineRuleRefusal(RULES, work('no-codex', 'codex'), MONDAY_8)).toBe('No Codex there')
    expect(machineRuleRefusal(RULES, work('no-codex', 'claude'), MONDAY_8)).toBeNull()
  })

  it('refuses a review where a rule says no Reviewer runs, and nothing else there', () => {
    expect(machineRuleRefusal(RULES, work('local-codex', 'claude', true), MONDAY_8)).toBe('Its Codex defaults to a local model')
    expect(machineRuleRefusal(RULES, work('local-codex', 'codex', false), MONDAY_8)).toBeNull()
  })

  it('refuses nothing on a machine no rule names, or with no rules', () => {
    expect(machineRuleRefusal(RULES, work('other', 'codex', true), MONDAY_8)).toBeNull()
    expect(machineRuleRefusal([], work('travels', 'codex', true), MONDAY_8)).toBeNull()
  })
})

describe('firstMachines', () => {
  it('names the machines a lane goes to first, in any case, and none for another lane', () => {
    expect(firstMachines(RULES, 'mobile')).toEqual(['phone-mac'])
    expect(firstMachines(RULES, 'Mobile')).toEqual(['phone-mac'])
    expect(firstMachines(RULES, 'backend')).toEqual([])
    expect(firstMachines(RULES, null)).toEqual([])
  })
})

// The CLI route's early filter reads the same cases (cli/src/superTabs/machineRules.spec.ts): the two cannot drift (security review 1).
describe('the shared machine rule cases', () => {
  const cases = JSON.parse(readFileSync(new URL('./machineRules.cases.json', import.meta.url), 'utf8')) as {
    rules: MachineRule[]; refusals: Array<{ at: string; machineId: string; engine: string; review: boolean; why: string | null }>
    first: Array<{ lane: string | null; machines: string[] }> }
  it('are rules the record holds', () => {
    expect(projectRulesSchema.parse({ ...structuredClone(SEED_RULES), machines: cases.rules }).machines).toEqual(cases.rules)
  })
  it('refuse and place as each case says', () => {
    for (const c of cases.refusals) expect(machineRuleRefusal(cases.rules, c, Date.parse(c.at)), JSON.stringify(c)).toBe(c.why)
    for (const c of cases.first) expect(firstMachines(cases.rules, c.lane)).toEqual(c.machines)
  })
})

// Security review 1 of #3964: a record that fails the schema elsewhere still applies its machine rules that pass.
describe('validMachineRules', () => {
  it('keeps each machine rule that passes, from a record that may not', () => {
    const broken = { ...structuredClone(SEED_RULES), dispatch: { maxHanded: 0 }, machines: [RULES[2], { machineIds: [], why: 'Bad' }, RULES[3], 'junk'] }
    expect(projectRulesSchema.safeParse(broken).success).toBe(false)
    expect(validMachineRules(broken)).toEqual([RULES[2], RULES[3]])
    expect(validMachineRules({ machines: 'none' })).toEqual([])
    expect(validMachineRules(null)).toEqual([])
  })
})
