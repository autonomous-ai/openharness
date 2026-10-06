import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import type { RegisteredSession } from './registry.js'
import { parseRuntimeProfile, RuntimeProfileManager } from './runtimeProfile.js'

const shell = vi.hoisted(() => ({ environment: {} as NodeJS.ProcessEnv }))
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => shell.environment }))
let root: string
const defaults = { codex: env.CODEX_HOME, claude: env.CLAUDE_PROJECTS_DIR }
const write = (folder: string, file: string, value: unknown): void => {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, file), JSON.stringify(value))
}
const session = (engine: 'claude' | 'codex') => ({
  agentId: 'agent', sessionId: 'conversation', engine, codexHome: null, transcriptPath: null,
  cwd: join(root, 'project'), cliVersion: engine === 'codex' ? '0.160.0' : '2.1.280',
} as RegisteredSession)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profile-homes-'))
  env.CODEX_HOME = join(root, 'daemon-codex')
  env.CLAUDE_PROJECTS_DIR = join(root, 'daemon-claude', 'projects')
  shell.environment = { CODEX_HOME: join(root, 'shell-codex'), CLAUDE_CONFIG_DIR: join(root, 'shell-claude') }
})
afterEach(() => {
  shell.environment = {}
  env.CODEX_HOME = defaults.codex
  env.CLAUDE_PROJECTS_DIR = defaults.claude
  rmSync(root, { recursive: true, force: true })
})

it('offers the model catalog of the shell login, with an explicit Codex profile taking precedence', async () => {
  for (const [home, slug] of [[env.CODEX_HOME, 'daemon-model'], [shell.environment.CODEX_HOME!, 'shell-model'], [join(root, 'profile'), 'profile-model']]) {
    write(home, 'models_cache.json', { models: [{ slug, display_name: slug, visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] }] })
  }
  const manager = new RuntimeProfileManager(), agent = session('codex')
  expect((await manager.codexCatalog(agent)).map(model => model.slug)).toEqual(['shell-model'])
  expect((await manager.modelsForSession(agent)).map(model => parseRuntimeProfile(model.id)?.model)).toEqual(['shell-model', 'shell-model'])
  expect((await manager.codexCatalog({ ...agent, codexHome: join(root, 'profile') })).map(model => model.slug)).toEqual(['profile-model'])
})

it('offers the Claude model families allowed by the settings in its moved home', async () => {
  write(join(root, 'daemon-claude'), 'settings.json', { availableModels: ['haiku'] })
  write(shell.environment.CLAUDE_CONFIG_DIR!, 'settings.json', { availableModels: ['sonnet'] })
  const models = (await new RuntimeProfileManager().modelsForSession(session('claude'))).map(model => parseRuntimeProfile(model.id)?.model)
  expect(models).toContain('sonnet')
  expect(models).not.toContain('haiku')
})

it('reads Claude effort from its moved settings, keeping the project override last', async () => {
  write(join(root, 'daemon-claude'), 'settings.json', { effortLevel: 'low' })
  write(shell.environment.CLAUDE_CONFIG_DIR!, 'settings.json', { effortLevel: 'high' })
  const manager = new RuntimeProfileManager(), agent = session('claude')
  await manager.ingestConfig(agent, true)
  expect(manager.getState(agent.sessionId).effort).toBe('high')
  write(join(agent.cwd!, '.claude'), 'settings.local.json', { effortLevel: 'medium' })
  await manager.ingestConfig(agent, true)
  expect(manager.getState(agent.sessionId).effort).toBe('medium')
})
