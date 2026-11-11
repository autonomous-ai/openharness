import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteSwarmBasics, parseSwarmSkill, PM_BASICS, SWARM_BASICS, swarmBasics, swarmBasicsSince } from './swarmSkills.js'
import { buildLaunchOverrides } from './launchOverrides.js'
import { gridLaunchInProcess } from '../testing/gridLaunchInProcess.js'

/** The Swarm's relaunch preparation, as the core hands it in while the Swarm is on (lib/launchOverrides.ts `swarm`). */
const SWARM = { basics: (lead: boolean) => swarmBasics(lead).text, github: () => null, args: () => [], cores: () => ({}) }

const roots: string[] = []
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'swarm-skills-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Swarm sessions without skill files (task #4673)', () => {
  // Swarm v4 (anh Dee, 2026-11-09): the team's basics are the product's, told at launch, never written into the project.
  it('tells an agent or a Reviewer the team\'s basics at launch, and the PM its part too', () => {
    for (const saved of [{ role: 'coordinator', key: 'lead' }, { role: 'agent', key: 'dev' }, { role: 'agent', fallback: 'review', key: 'review' }] as const) {
      expect(swarmBasics(saved.role === 'coordinator').text).toBe(saved.role === 'coordinator' ? `${SWARM_BASICS}\n${PM_BASICS}` : SWARM_BASICS)
    }
  })

  // Swarm v4 (anh Dee, 2026-11-09): the team's talk is visible to people only if agents post it. Harness labels who gets a task;
  // the PM announces it once in the project's channel, as "@Pip #12 is yours", and the rest of that task's record stays on its
  // issue (the basics' own rule). No other agent is told to.
  it('tells the PM to announce each hand-off once in the project\'s channel, and no other agent', () => {
    const lead = swarmBasics(true).text
    expect(lead.split('\n').filter(row => row.includes('hand-off'))).toHaveLength(1)
    expect(lead).toMatch(/announce that hand-off once in your project's channel, as "@Pip #12 is yours"/)
    expect(lead).toContain('the rest of that task\'s record stays on its issue')
    expect(swarmBasics(false).text).not.toMatch(/hand-off|is yours"/)
  })

  // Swarm v4 (anh Dee, 2026-11-10: "channel chat here replaces the queue"): the channel is where agents talk to each other, as
  // lampOS's builders do on their Queue issue, each post opening with @Name for whom it is for (Harness shows who wrote it and
  // when); a task's own record stays on GitHub, where Harness shows it in the task's chat.
  // Step 1, item 7 of docs/plans/2026-11-10-swarm-plan.md: every agent's basics held 507 words and grew with each incident.
  // What code does left them, and they are held under 200 words: the next rule is code, or the project's own AGENTS.md.
  it('holds every agent\'s basics under 200 words', () => {
    expect(SWARM_BASICS.split(/\s+/).filter(Boolean).length).toBeLessThan(200)
  })
  it('names the commands that make a claim and a verdict, and tells no agent to type either by hand', () => {
    expect(SWARM_BASICS).toContain('harness super-tab take OWNER/REPO#N')
    expect(SWARM_BASICS).toContain('harness super-tab read ok|hold OWNER/REPO#N SHA \'what you found\'')
    for (const byHand of ['status:taken', 'taken by', 'READ-OK <sha>', 'HOLD <sha>']) expect(SWARM_BASICS, byHand).not.toContain(byHand)
  })
  it('keeps what code reads from an agent: its name opening each post on GitHub and its branch, and its label on its pull request', () => {
    // githubMentions.ts signedBy: its own post is not brought back to it. githubMerge.ts authorOf: whose pull request it is.
    expect(SWARM_BASICS).toContain('open each post with your name')
    expect(SWARM_BASICS).toContain('Branch <your name>/<N>')
    // githubMentions.ts: what is said on a pull request is brought to the agent whose builder label it carries, matched whole:
    // the agent copies the label its task carries, and never spells one from its name.
    expect(SWARM_BASICS).toContain('Your tasks are GitHub issues labelled builder:<your name>')
    expect(SWARM_BASICS).toContain('has that label')
    expect(SWARM_BASICS).not.toContain('Harness tells you your tasks')
  })
  it('tells every agent where the team talks and how a post wakes someone', () => {
    for (const saved of [{ role: 'agent', key: 'dev' }, { role: 'coordinator', key: 'lead' }] as const) {
      const rules = swarmBasics(saved.role === 'coordinator').text
      expect(rules).toContain('Your project\'s channel is the team\'s chat')
      expect(rules).toContain('harness super-tab post CHANNEL \'message\' NEW_ID')
      expect(rules).toContain('Open with @Name to wake someone')
    }
  })
  // AGENTS.md standard 13: a safety rule about processes keeps its line. The shell guard that enforced these is gone with team
  // machines (an agent runs on its own person's computer), so every agent, the PM too, is told them once, in one plain line.
  it('tells every agent, the PM too, the rules about processes, privilege, temporary files and worktrees, in one line', () => {
    for (const saved of [{ role: 'coordinator', key: 'lead' }, { role: 'agent', key: 'dev' }, { role: 'agent', fallback: 'review', key: 'review' }] as const) {
      const rows = swarmBasics(saved.role === 'coordinator').text.split('\n').filter(row => row.startsWith('- Stop only processes you started'))
      expect(rows, saved.key).toHaveLength(1)
      // By id, never by name; no privilege; a template a Mac's mktemp honours, and Windows' own folder; no other agent's worktree.
      for (const part of ['by the process id you recorded, never by name (pkill, killall, taskkill /IM)', 'no sudo or system-wide installs',
        'mktemp -d "${TMPDIR:-/tmp}/name.XXXXXX"', '$env:TEMP', 'never remove another agent\'s worktree']) expect(rows[0], part).toContain(part)
    }
  })

  it('tells no agent to send a person a private line: their chat with their own agent is theirs alone (task #4547)', () => {
    for (const text of [SWARM_BASICS, PM_BASICS]) {
      expect(text).not.toContain('person.tell')
      expect(text).not.toContain("PM's private lines")
    }
  })

  it('validates persisted role metadata and refuses an empty key', () => {
    for (const value of [null, undefined, {}, { role: 'builder', key: 'x' }, { role: 'dev', key: '' }, { role: 'lead', key: 7 }]) expect(parseSwarmSkill(value)).toBeUndefined()
    expect(parseSwarmSkill({ role: 'dev', key: 'x' })).toEqual({ role: 'agent', key: 'x' })
    // A skill mode an older release saved is dropped (the modes are gone, PM 2026-11-11): the session keeps its role.
    for (const mode of ['light', 'default', 'orchestration']) expect(parseSwarmSkill({ role: 'dev', key: 'x', mode })).toEqual({ role: 'agent', key: 'x' })
    // The Harness GitHub App's flag is kept for relaunches, and only as true.
    expect(parseSwarmSkill({ role: 'dev', key: 'x', github: true })).toEqual({ role: 'agent', key: 'x', github: true })
    expect(parseSwarmSkill({ role: 'dev', key: 'x', github: 'yes' })).toEqual({ role: 'agent', key: 'x' })
  })

  it.each(['claude', 'codex'] as const)('tells a %s agent the team\'s basics again on relaunch', async engine => {
    const cwd = fixture(), swarmSkill = { role: 'agent' as const, key: 'original' }
    const result = await buildLaunchOverrides({ capabilities: async () => ({ sessionEnv: true }), installCodexHooks: () => true, machine: () => ({ hermesSystemManaged: false }), gridLaunch: gridLaunchInProcess(),
      writeGridConfigDir: async () => '/unused', readCodexConfig: () => null, readAttribution: () => null, swarm: SWARM }, engine, { cwd, swarmSkill }, 'new-registry-id')
    expect(result.ok).toBe(true)
    // A relaunch is told the same basics again, as the engine starts from nothing.
    if (result.ok) expect(result.overrides?.extraArgs.join(' ')).toContain('Never watch GitHub yourself')
  })

})

describe('when this computer first ran the team\'s basics (noteSwarmBasics)', () => {
  it('notes each text once, as the core starts, and keeps the first moment', () => {
    const dir = fixture()
    const agent = swarmBasics(false), pm = swarmBasics(true)
    expect([agent.text, pm.text]).toEqual([SWARM_BASICS, `${SWARM_BASICS}\n${PM_BASICS}`])
    expect(swarmBasicsSince(dir, agent.version)).toBeNull()
    noteSwarmBasics(dir, 100)
    // A restart of the same release changes nothing.
    noteSwarmBasics(dir, 200)
    expect([swarmBasicsSince(dir, agent.version), swarmBasicsSince(dir, pm.version)]).toEqual([100, 100])
    expect(statSync(join(dir, 'super-tab-basics.json')).mode & 0o777).toBe(0o600)
  })

  it('keeps the last few texts, and reads a broken record as none', () => {
    const dir = fixture()
    const file = join(dir, 'super-tab-basics.json')
    writeFileSync(file, JSON.stringify(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`old-${i}`, i]))))
    noteSwarmBasics(dir, 300)
    const kept = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>
    expect(Object.keys(kept)).toEqual(['old-2', 'old-3', 'old-4', 'old-5', swarmBasics(false).version, swarmBasics(true).version])
    writeFileSync(file, '{ not json')
    expect(swarmBasicsSince(dir, swarmBasics(false).version)).toBeNull()
    noteSwarmBasics(dir, 400)
    expect(swarmBasicsSince(dir, swarmBasics(false).version)).toBe(400)
  })

  it('says so when the record cannot be saved, and the launch goes on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    noteSwarmBasics(join(fixture(), 'missing', 'folder'), 1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('The basics record was not saved'))
    warn.mockRestore()
  })
})
