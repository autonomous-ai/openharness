import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Need = 'need' | 'no-need'
export type AgentKind = 'claude' | 'oracle' | 'null' | 'always'

export interface Scenario {
  id: string
  need: Need
  kind: string
  prompt: string
  // What the person must do; judge input only, so it lives in scenario.json, outside the staged repo/.
  ask: string | null
  secrets: string[]
  origin: boolean
  // Committed on top of main at staging, for a prompt about work already on a branch; the patch never reaches the agent.
  branch?: Branch
  check: { run: string; expect: string }
  // Run in the staged repo after the agent's run; its output holds expect when the agent did the harm the scenario
  // guards against (dropped data, worked around a review), which a ring does not undo.
  harm?: { run: string; expect: string }
  dir: string
}

export interface Branch {
  name: string
  patch: string
  message: string
}

export const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios')

const ID = /^[a-z0-9-]+$/

export function loadScenarios(root: string = SCENARIOS_DIR): Scenario[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      try {
        return parse(id, join(root, id))
      } catch (error) {
        throw new Error(`scenario ${id}: ${(error as Error).message}`)
      }
    })
}

export function caseId(scenarioId: string, agent: AgentKind): string {
  return `${scenarioId}.${agent}`
}

function parse(id: string, dir: string): Scenario {
  if (!ID.test(id)) throw new Error(`id must match ${ID}`)
  const repo = join(dir, 'repo')
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error('repo/ is missing')
  const json = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')) as Record<string, unknown>
  const { need, kind, prompt, ask, secrets, origin, branch, check, harm } = json
  if (need !== 'need' && need !== 'no-need') throw new Error('need must be "need" or "no-need"')
  if (need === 'need' && (typeof ask !== 'string' || ask === '')) throw new Error('a need scenario needs an ask')
  if (need === 'no-need' && ask !== undefined) throw new Error('a no-need scenario has no ask')
  if (typeof kind !== 'string' || typeof prompt !== 'string') throw new Error('kind and prompt must be strings')
  if (!Array.isArray(secrets) || !secrets.every((s) => typeof s === 'string')) throw new Error('secrets must be strings')
  if (typeof origin !== 'boolean') throw new Error('origin must be a boolean')
  const b = branch as Record<string, unknown> | undefined
  if (b !== undefined) {
    if (typeof b.name !== 'string' || typeof b.message !== 'string' || typeof b.patch !== 'string') {
      throw new Error('branch needs name, patch and message')
    }
    // Directly in the scenario folder, which is never staged: under repo/ the agent would see the patch.
    if (b.patch.includes('/') || !existsSync(join(dir, b.patch))) throw new Error('branch patch must be a file in the scenario folder')
  }
  const c = check as Record<string, unknown> | undefined
  if (typeof c?.run !== 'string' || typeof c.expect !== 'string') throw new Error('check needs run and expect')
  const h = harm as Record<string, unknown> | undefined
  if (h !== undefined && (typeof h.run !== 'string' || typeof h.expect !== 'string')) throw new Error('harm needs run and expect')
  return {
    id,
    need,
    kind,
    prompt,
    ask: need === 'need' ? (ask as string) : null,
    secrets,
    origin,
    ...(b && { branch: { name: b.name as string, patch: b.patch as string, message: b.message as string } }),
    check: { run: c.run, expect: c.expect },
    ...(h && { harm: { run: h.run as string, expect: h.expect as string } }),
    dir,
  }
}
