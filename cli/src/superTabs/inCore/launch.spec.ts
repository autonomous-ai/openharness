import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { swarmGitHubLaunch } from '../../lib/swarmGitHub.js'
import { env } from '../../config/env.js'
import { PM_BASICS, SWARM_BASICS, swarmBasics, swarmBasicsSince } from '../../lib/swarmSkills.js'
import { coreShare, HANDED_FOR_MS, OWN_CARRIED_MAX, swarmLaunch, type MachineSession } from './launch.js'

// The Harness GitHub App's launch writes files in the daemon's folder (lib/swarmGitHub.ts): never this machine's here.
vi.mock('../../lib/swarmGitHub.js', () => ({ swarmGitHubLaunch: vi.fn(() => null) }))

/** The Swarm's part of a launch on a machine with no session yet. */
const SWARM_LAUNCH = swarmLaunch(() => [])

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
      + 'which your person keeps and which come first wherever they differ from anything else you are told, your project\'s AGENTS.md included:\nBe brief.\nNever push to main.')
    expect(SWARM_LAUNCH.basics(true, { cwd, name: 'Faye' })).toContain(`${PM_BASICS}\n\nYour own instructions, from agents/Faye.md`)
    writeFileSync(join(cwd, 'agents', 'Faye.md'), 'x'.repeat(OWN_CARRIED_MAX + 1))
    expect(SWARM_LAUNCH.basics(false, { cwd, name: 'Faye' })).toBe(`${SWARM_BASICS}\n\nYour own instructions are in agents/Faye.md, `
      + 'which your person keeps and which come first wherever they differ from anything else you are told, your project\'s AGENTS.md included: read them now, and again after a compaction.')
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

// anh Dee, 2026-11-11: "with multiple agents, it's CPU constraint". Every agent's test runner sized its workers to the whole
// machine: four runs at once took twice as long as one, and every one failed (docs/research/2026-11-11-agents-share-cpu.md).
it('starts each of the Swarm\'s agents with its share of this machine\'s cores, among the Swarm\'s agents here', () => {
  /** The machine's sessions: a key for one the Swarm started, null for a person's own. */
  const machine = (...keys: Array<string | null>) => (): MachineSession[] => keys.map(key => key ? { swarmSkill: { key } } : {})
  const share = (sessions: () => MachineSession[], key: string) => swarmLaunch(sessions, () => 16).cores(key)
  // A first launch: its row is not among the machine's sessions yet.
  expect(share(machine(), 'one')).toEqual({ HARNESS_CORES: '16' })
  expect(share(machine('one'), 'two')).toEqual({ HARNESS_CORES: '8' })
  expect(share(machine('one', 'two', 'three'), 'four')).toEqual({ HARNESS_CORES: '4' })
  // A relaunch: its row is there, and it is counted once.
  expect(share(machine('one', 'two', 'three', 'four'), 'four')).toEqual({ HARNESS_CORES: '4' })
  expect(share(machine('one'), 'one')).toEqual({ HARNESS_CORES: '16' })
  // A person's own sessions take no part of it.
  expect(share(machine('one', null, null, null), 'two')).toEqual({ HARNESS_CORES: '8' })
})

it('rounds a share of the cores down, and never below one core', () => {
  expect(coreShare(16, 3)).toBe(5)
  expect(coreShare(16, 6)).toBe(2)
  expect(coreShare(4, 6)).toBe(1)
  expect(coreShare(1, 1)).toBe(1)
})

it('shares the cores this machine has', () => {
  expect(swarmLaunch(() => []).cores('one')).toEqual({ HARNESS_CORES: String(availableParallelism()) })
})

// The review of #4150: agents started at the same moment each worked out their share before any of their rows was
// registered, so each took the whole machine.
it('counts the agents handed a share whose rows are not registered yet, as agents started at the same moment are', () => {
  let rows: MachineSession[] = []
  const launch = swarmLaunch(() => rows, () => 16)
  // Three started at once: none of their rows is there yet.
  expect(['one', 'two', 'three'].map(key => launch.cores(key).HARNESS_CORES)).toEqual(['16', '8', '5'])
  // Their rows came: each is counted once, by its row, and a fourth starts beside them.
  rows = ['one', 'two', 'three'].map(key => ({ swarmSkill: { key } }))
  expect(launch.cores('four')).toEqual({ HARNESS_CORES: '4' })
  // A relaunch of one of them is counted once, with the fourth whose row has not come yet.
  expect(launch.cores('two')).toEqual({ HARNESS_CORES: '4' })
})

it('stops counting an agent whose row never came, two minutes after it was handed its share', () => {
  vi.useFakeTimers({ toFake: ['Date'], now: 0 })
  try {
    const launch = swarmLaunch(() => [], () => 16)
    expect(launch.cores('failed')).toEqual({ HARNESS_CORES: '16' })
    // Two minutes on, it still counts.
    vi.setSystemTime(HANDED_FOR_MS)
    expect(launch.cores('next')).toEqual({ HARNESS_CORES: '8' })
    // A moment later it does not; the one after it still does.
    vi.setSystemTime(HANDED_FOR_MS + 1)
    expect(launch.cores('third')).toEqual({ HARNESS_CORES: '8' })
  } finally { vi.useRealTimers() }
})

// Standard 8: each share is measured where it is given, in counts only.
it('says each share it gives in the log, with no name', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    swarmLaunch(() => [{ swarmSkill: { key: 'harness-claude-1' } }, {}], () => 16).cores('harness-codex-2')
    expect(log.mock.calls).toEqual([['[swarm] a Swarm agent\'s share of this machine\'s cores: 8 of 16, among 2 of the Swarm\'s agents here']])
  } finally { log.mockRestore() }
})
