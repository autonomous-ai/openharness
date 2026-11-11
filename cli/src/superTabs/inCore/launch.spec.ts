import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { swarmGitHubLaunch } from '../../lib/swarmGitHub.js'
import { env } from '../../config/env.js'
import { PM_BASICS, SWARM_BASICS, swarmBasics, swarmBasicsSince } from '../../lib/swarmSkills.js'
import { OWN_CARRIED_MAX, SWARM_LAUNCH } from './launch.js'

// The Harness GitHub App's launch writes files in the daemon's folder (lib/swarmGitHub.ts): never this machine's here.
vi.mock('../../lib/swarmGitHub.js', () => ({ swarmGitHubLaunch: vi.fn(() => null) }))

it('lets a start ask for the two role kinds, and nothing else', () => {
  // The wire's older values (lead, dev, review) are read into kinds before this check (core/agents/launches.ts roleFromWire).
  for (const role of ['coordinator', 'agent']) expect(SWARM_LAUNCH.role(role), role).toBe(true)
  for (const role of ['lead', 'dev', 'review', 'builder', '', 7, null, undefined]) expect(SWARM_LAUNCH.role(role), String(role)).toBe(false)
  expect(SWARM_LAUNCH).not.toHaveProperty('mode')
  expect(SWARM_LAUNCH).not.toHaveProperty('prepare')
})

// Swarm v4: no skill file and no skill mode; the engine starts with the team's basics as its launch line and reads the repo's
// own files. The basics are these texts, byte for byte, until the plan's item 7 cuts them.
it('tells the engine the team\'s basics at launch, and the PM\'s part to the PM alone', () => {
  expect(SWARM_LAUNCH.basics(false)).toBe(SWARM_BASICS)
  expect(SWARM_LAUNCH.basics(true)).toBe(`${SWARM_BASICS}\n${PM_BASICS}`)
})

// anh Dee, 2026-11-11: Alba never read the rules its person wrote in agents/Alba.md. Its own file goes into the instructions its
// engine starts with, after the basics, at each launch and relaunch, so it holds through a compaction.
it('adds the agent\'s own agents/<name>.md after the basics, says where a file too long is, and adds nothing without one', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'swarm-own-'))
  try {
    expect(SWARM_LAUNCH.basics(false, { cwd, name: 'Faye' })).toBe(SWARM_BASICS)
    mkdirSync(join(cwd, 'agents'))
    writeFileSync(join(cwd, 'agents', 'Faye.md'), '  Be brief.\nNever push to main.\n\n')
    expect(SWARM_LAUNCH.basics(false, { cwd, name: 'Faye' })).toBe(`${SWARM_BASICS}\n\nYour own instructions, from agents/Faye.md, `
      + 'which your person keeps and which come first where they differ from the above:\nBe brief.\nNever push to main.')
    expect(SWARM_LAUNCH.basics(true, { cwd, name: 'Faye' })).toContain(`${PM_BASICS}\n\nYour own instructions, from agents/Faye.md`)
    writeFileSync(join(cwd, 'agents', 'Faye.md'), 'x'.repeat(OWN_CARRIED_MAX + 1))
    expect(SWARM_LAUNCH.basics(false, { cwd, name: 'Faye' })).toBe(`${SWARM_BASICS}\n\nYour own instructions are in agents/Faye.md, `
      + 'which your person keeps and which come first where they differ from the above: read them now, and again after a compaction.')
    writeFileSync(join(cwd, 'agents', 'Faye.md'), '   \n')
    for (const own of [{ cwd, name: 'Faye' }, { cwd: null, name: 'Faye' }, { cwd, name: null }]) expect(SWARM_LAUNCH.basics(false, own)).toBe(SWARM_BASICS)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

it('notes when this computer first launched an agent with these basics, and keeps that moment', () => {
  rmSync(join(env.ADAPTER_DATA_DIR, 'super-tab-basics.json'), { force: true })
  expect(swarmBasicsSince(env.ADAPTER_DATA_DIR, swarmBasics(false).version)).toBeNull()
  SWARM_LAUNCH.basics(false)
  const since = swarmBasicsSince(env.ADAPTER_DATA_DIR, swarmBasics(false).version)
  expect(since).toBeLessThanOrEqual(Date.now())
  SWARM_LAUNCH.basics(true)
  expect(swarmBasicsSince(env.ADAPTER_DATA_DIR, swarmBasics(false).version)).toBe(since)
  expect(swarmBasicsSince(env.ADAPTER_DATA_DIR, swarmBasics(true).version)).toBe(since)
})

it('hands the GitHub App\'s git and gh for the session it is asked for', () => {
  vi.mocked(swarmGitHubLaunch).mockReturnValueOnce({ env: { GH_CONFIG_DIR: '/fixture/gh' }, clearEnv: ['GH_TOKEN'] })
  expect(SWARM_LAUNCH.github('harness-codex-2')).toEqual({ env: { GH_CONFIG_DIR: '/fixture/gh' }, clearEnv: ['GH_TOKEN'] })
  expect(swarmGitHubLaunch).toHaveBeenCalledWith('harness-codex-2')
})
