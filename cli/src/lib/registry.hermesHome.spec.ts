import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { registry as Registry } from './registry.js'

const HOME = '/data/agents/a1/.hermes'
const id = 'hermes-agent'
const processIdentity = { pid: 1041, executable: '/fixture/hermes', startMarker: 'fixture-1041' }
const bind = { engine: 'hermes' as const, tmuxPane: '%41', cwd: '/fixture/project', processIdentity }

let directory: string
let file: string
let registry: typeof Registry

const readRows = () => JSON.parse(readFileSync(file, 'utf8'))
async function reload(): Promise<typeof Registry> {
  vi.resetModules()
  const reloaded = (await import('./registry.js')).registry
  reloaded.load()
  return reloaded
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'registry-hermes-home-'))
  file = join(directory, 'registry.json')
  for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME', 'HERMES_HOME']) vi.stubEnv(key, directory)
  registry = await reload()
  expect(registry.openProcessAgent({ ...bind, agentId: id })).not.toBeNull()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('keeps the mark with the home through a save, a load and a rebind', async () => {
  expect(registry.setHermesHome(id, HOME, true)).toBe(true)
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  expect(readRows()[0]).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  expect((await reload()).byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  registry.register({ ...bind, sessionId: '20261112_100000_aaaaaa' })                       // a bind rebuilds the row
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  registry.register({ ...bind, sessionId: '20261112_100001_bbbbbb', hermesHome: HOME })       // the repair names the same home
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
})

it('leaves a home the process named unmarked, as a row an older release saved is', async () => {
  registry.setHermesHome(id, '/h/.hermes/profiles/work')
  expect(registry.byAgent(id)).not.toHaveProperty('hermesHomeDerived')
  expect(readRows()[0]).not.toHaveProperty('hermesHomeDerived')
  expect((await reload()).byAgent(id)).not.toHaveProperty('hermesHomeDerived')
})

it('takes the mark with a home a bind brings, and drops it when another home replaces that one', () => {
  registry.register({ ...bind, sessionId: '20261112_100000_aaaaaa', hermesHome: HOME, hermesHomeDerived: true })
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  registry.register({ ...bind, sessionId: '20261112_100001_bbbbbb', hermesHome: '/h/.hermes/profiles/work' })
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: '/h/.hermes/profiles/work' })
  expect(registry.byAgent(id)).not.toHaveProperty('hermesHomeDerived')
})

it('marks again a row an older daemon saved over, and never moves a row to another home', () => {
  registry.setHermesHome(id, HOME)                                              // the home, no mark
  expect(registry.setHermesHome(id, HOME, true)).toBe(true)
  expect(registry.byAgent(id)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })
  expect(registry.setHermesHome(id, HOME, true)).toBe(false)                    // nothing to change, nothing saved
  expect(registry.setHermesHome(id, '/elsewhere/.hermes', true)).toBe(false)
  expect(registry.byAgent(id)!.hermesHome).toBe(HOME)
})

it('drops a mark that has no home, or is not true', async () => {
  registry.setHermesHome(id, HOME, true)
  const [saved] = readRows()
  const { strictPersistedRow } = await import('./registry.js')
  expect(strictPersistedRow(saved)).toMatchObject({ hermesHome: HOME, hermesHomeDerived: true })   // a stopped row keeps it
  for (const edited of [{ hermesHome: null, hermesHomeDerived: true }, { hermesHome: HOME, hermesHomeDerived: 'yes' }]) {
    writeFileSync(file, JSON.stringify([{ ...saved, ...edited }]))
    expect((await reload()).byAgent(id)).not.toHaveProperty('hermesHomeDerived')
    expect(strictPersistedRow({ ...saved, ...edited })).not.toHaveProperty('hermesHomeDerived')
  }
})
