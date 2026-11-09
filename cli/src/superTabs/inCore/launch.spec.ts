import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { swarmGitHubLaunch } from '../../lib/swarmGitHub.js'
import { env } from '../../config/env.js'
import { SWARM_BASICS, swarmBasics, swarmBasicsSince } from '../../lib/swarmSkills.js'
import { SWARM_LAUNCH } from './launch.js'

// The Harness GitHub App's launch writes files in the daemon's folder (lib/swarmGitHub.ts): never this machine's here.
vi.mock('../../lib/swarmGitHub.js', () => ({ swarmGitHubLaunch: vi.fn(() => null) }))

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

it('lets a start ask for the three role kinds and two skill modes, and nothing else', () => {
  // The wire's older values (lead, dev, review) are read into kinds before this check (core/agents/launches.ts roleFromWire).
  for (const role of ['coordinator', 'agent', 'buddy']) expect(SWARM_LAUNCH.role(role), role).toBe(true)
  for (const role of ['lead', 'dev', 'review', 'builder', '', 7, null, undefined]) expect(SWARM_LAUNCH.role(role), String(role)).toBe(false)
  for (const mode of ['default', 'orchestration']) expect(SWARM_LAUNCH.mode(mode), mode).toBe(true)
  for (const mode of ['light', 7, null]) expect(SWARM_LAUNCH.mode(mode), String(mode)).toBe(false)
})

// Swarm v4: no skill file; the engine starts with the team's basics as its launch line and reads the repo's own files.
it('tells the engine the team\'s basics at launch and writes nothing in its folder', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'swarm-launch-'))
  folders.push(cwd)
  const { instructions } = SWARM_LAUNCH.prepare(cwd, { role: 'agent', fallback: 'review', key: 'harness-claude-1' })
  expect(instructions).toBe(SWARM_BASICS)
  expect(readdirSync(cwd)).toEqual([])
  expect(() => SWARM_LAUNCH.prepare(cwd, { role: 'agent', fallback: 'review', key: '' })).toThrow('A Swarm skill needs a role and session key')
})

it('notes when this computer first launched an agent with these basics, and keeps that moment', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'swarm-launch-'))
  folders.push(cwd)
  SWARM_LAUNCH.prepare(cwd, { role: 'agent', fallback: 'review', key: 'harness-claude-1' })
  const since = swarmBasicsSince(env.ADAPTER_DATA_DIR, swarmBasics(false).version)
  expect(since).toBeLessThanOrEqual(Date.now())
  SWARM_LAUNCH.prepare(cwd, { role: 'coordinator', fallback: 'review', key: 'harness-claude-2' })
  expect(swarmBasicsSince(env.ADAPTER_DATA_DIR, swarmBasics(false).version)).toBe(since)
  expect(swarmBasicsSince(env.ADAPTER_DATA_DIR, swarmBasics(true).version)).toBe(since)
})

it('hands the GitHub App\'s git and gh for the session it is asked for', () => {
  vi.mocked(swarmGitHubLaunch).mockReturnValueOnce({ env: { GH_CONFIG_DIR: '/fixture/gh' }, clearEnv: ['GH_TOKEN'] })
  expect(SWARM_LAUNCH.github('harness-codex-2')).toEqual({ env: { GH_CONFIG_DIR: '/fixture/gh' }, clearEnv: ['GH_TOKEN'] })
  expect(swarmGitHubLaunch).toHaveBeenCalledWith('harness-codex-2')
})
