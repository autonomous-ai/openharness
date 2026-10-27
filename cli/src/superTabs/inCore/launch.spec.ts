import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { swarmGitHubLaunch } from '../../lib/swarmGitHub.js'
import { SWARM_LAUNCH } from './launch.js'

// The Harness GitHub App's launch writes files in the daemon's folder (lib/swarmGitHub.ts): never this machine's here.
vi.mock('../../lib/swarmGitHub.js', () => ({ swarmGitHubLaunch: vi.fn(() => null) }))

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

it('lets a start ask for the three roles and two skill modes, and nothing else', () => {
  for (const role of ['lead', 'dev', 'review']) expect(SWARM_LAUNCH.role(role), role).toBe(true)
  for (const role of ['builder', '', 7, null, undefined]) expect(SWARM_LAUNCH.role(role), String(role)).toBe(false)
  for (const mode of ['default', 'orchestration']) expect(SWARM_LAUNCH.mode(mode), mode).toBe(true)
  for (const mode of ['light', 7, null]) expect(SWARM_LAUNCH.mode(mode), String(mode)).toBe(false)
})

it('writes the role\'s skill into the project folder and tells the engine where to read it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'swarm-launch-'))
  folders.push(cwd)
  const { instructions } = SWARM_LAUNCH.prepare(cwd, { role: 'review', key: 'harness-claude-1' })
  expect(instructions).toContain('swarm-review/SKILL.md')
  expect(() => SWARM_LAUNCH.prepare(cwd, { role: 'review', key: '' })).toThrow('A Swarm skill needs a role and session key')
})

it('hands the GitHub App\'s git and gh for the session it is asked for', () => {
  vi.mocked(swarmGitHubLaunch).mockReturnValueOnce({ env: { GH_CONFIG_DIR: '/fixture/gh' }, clearEnv: ['GH_TOKEN'] })
  expect(SWARM_LAUNCH.github('harness-codex-2')).toEqual({ env: { GH_CONFIG_DIR: '/fixture/gh' }, clearEnv: ['GH_TOKEN'] })
  expect(swarmGitHubLaunch).toHaveBeenCalledWith('harness-codex-2')
})
