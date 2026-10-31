import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SWARM_TOOLS_SKILL } from './swarmTools.js'
import { prepareSwarmSkill } from './swarmSkills.js'
import { instructionsSkillText, recordProjectSkillsNotice, refreshProjectSkills, type ProjectDoc } from './swarmInstructionsSkill.js'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const roots: string[] = []
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'swarm-instructions-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
// A Buddy that reads its folder alone (lib/buddyGuard.ts has the wide mode's tests).
const folderOnly = () => null

const TEXT = '# How we work\nEvery task gets a review.\n'
/** When launched() sessions start: the launch's tools record's mtime, in whole seconds so every file system keeps it. */
const LAUNCHED_AT = 1_790_000_000_000
/** By default the revision was saved a minute before the launch, so the launch's instructions command printed it. */
const doc = (over: Partial<ProjectDoc> = {}): ProjectDoc =>
  ({ revision: 1, text: TEXT, summary: null, roleName: 'Tester', coordinatorName: 'Ken', coordinator: false, savedAt: LAUNCHED_AT - 60_000, ...over })
const q = (path: string) => JSON.stringify(path)

/** A dev session launched by this release at LAUNCHED_AT: its role file, its tools skill and the tools record. */
function launched(key = 'session') {
  const workspace = fixture(), saved = { role: 'dev' as const, key }
  const { file } = prepareSwarmSkill(workspace, saved)
  const skills = dirname(dirname(file)), tools = join(skills, 'swarm-tools', 'SKILL.md')
  utimesSync(join(dirname(tools), 'version.json'), new Date(LAUNCHED_AT), new Date(LAUNCHED_AT))
  return { workspace, saved, file, skills, tools, instructions: join(skills, 'swarm-instructions', 'SKILL.md') }
}

describe('the project instructions skill', () => {
  it('writes the instructions with the role line', () => {
    const { workspace, saved, instructions } = launched()
    const refresh = refreshProjectSkills(workspace, saved, doc())!
    expect(refresh.instructions).toBe(instructions)
    const text = readFileSync(instructions, 'utf8')
    expect(text).toBe(instructionsSkillText(doc()))
    expect(text).toBe('---\nname: swarm-instructions\ndescription: "This project\'s instructions: its roles, workflow and routing, and your role in them. Read before any project work."\n---\n'
      + 'You are this project\'s Tester. Ken is the project\'s coordinator.\n\nInstructions revision 1:\n\n' + TEXT)
    expect(statSync(instructions).mode & 0o777).toBe(0o600)
    // The coordinator is told what that means, in place of the name of the coordinator.
    const coordinator = instructionsSkillText(doc({ roleName: 'PM', coordinator: true, revision: 4 }))
    expect(coordinator).toContain('\nYou are this project\'s PM, its coordinator: people talk to you when they address no one, and you receive the server\'s notices.\n\nInstructions revision 4:\n\n')
    expect(coordinator).not.toContain('is the project\'s coordinator')
  })

  it('writes a 64 KB document whole', () => {
    const { workspace, saved, instructions } = launched()
    const line = 'Reviews run on Opus — every task gets its own review ✓\n'
    let text = ''
    while (Buffer.byteLength(text + line) <= 64 * 1024) text += line
    text += 'x'.repeat(64 * 1024 - Buffer.byteLength(text))
    expect(Buffer.byteLength(text)).toBe(64 * 1024)
    refreshProjectSkills(workspace, saved, doc({ text }))
    const written = readFileSync(instructions, 'utf8')
    expect(written).toBe(instructionsSkillText(doc({ text })))
    expect(written.endsWith(`Instructions revision 1:\n\n${text}`)).toBe(true)
  })

  it('tells nothing on the first install after a new launch', () => {
    const { workspace, saved, tools, instructions } = launched()
    // Saved at the launch's very millisecond: the launch's instructions command printed it.
    const atLaunch = doc({ savedAt: LAUNCHED_AT })
    const refresh = refreshProjectSkills(workspace, saved, atLaunch)!
    expect(refresh).toMatchObject({ tools, instructions, owed: false, change: 0 })
    expect(refresh.version).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(tools, 'utf8')).toBe(SWARM_TOOLS_SKILL)
    const state = { tools: sha(SWARM_TOOLS_SKILL), doc: sha(instructionsSkillText(atLaunch)), revision: 1, roleName: 'Tester', change: 0 }
    expect(JSON.parse(readFileSync(join(dirname(instructions), 'version.json'), 'utf8'))).toEqual({ ...state, told: state })
    // Each later pass with the same document leaves everything as it is.
    expect(refreshProjectSkills(workspace, saved, atLaunch)).toEqual(refresh)
    // Revision 0 is the built-in template, there at any launch on a backend with instructions: its time is not needed.
    const template = launched('template')
    expect(refreshProjectSkills(template.workspace, template.saved, doc({ revision: 0, savedAt: null }))).toMatchObject({ owed: false, change: 0 })
  })

  it('tells a new session about a revision saved after its launch', () => {
    const { workspace, saved, tools, instructions } = launched()
    const after = doc({ revision: 2, summary: 'Reviews run on Opus', savedAt: LAUNCHED_AT + 1000 })
    const refresh = refreshProjectSkills(workspace, saved, after)!
    expect(refresh).toMatchObject({ owed: true, change: 1,
      notice: `The project's instructions changed: Reviews run on Opus. Before your next step, read ${q(instructions)} again and work by it.` })
    expect(readFileSync(instructions, 'utf8')).toBe(instructionsSkillText(after))
    expect(readFileSync(tools, 'utf8')).toBe(SWARM_TOOLS_SKILL)
    recordProjectSkillsNotice(workspace, saved, refresh)
    expect(refreshProjectSkills(workspace, saved, after)).toMatchObject({ owed: false, change: 1 })
    // A tools text changed since the launch as well: one notice, both parts.
    const other = launched('tools-too')
    writeFileSync(other.tools, 'older tools')
    writeFileSync(join(dirname(other.tools), 'version.json'), JSON.stringify({ text: sha('older tools'), notified: sha('older tools'), change: 0, toldChange: 0 }))
    utimesSync(join(dirname(other.tools), 'version.json'), new Date(LAUNCHED_AT), new Date(LAUNCHED_AT))
    expect(refreshProjectSkills(other.workspace, other.saved, after)).toMatchObject({ owed: true, change: 1,
      notice: `The project's instructions changed: Reviews run on Opus. Harness updated your swarm-tools skill. Before your next step, read ${q(other.instructions)} and ${q(other.tools)} again and work by them.` })
  })

  it('tells a new session whose launch saw no instructions', () => {
    // An old backend at launch (the command answered that there were none, so it used its role file), or a revision whose
    // save time the host could not read: either way the agent may never have read it.
    for (const savedAt of [undefined, null]) {
      const { workspace, saved, instructions } = launched(`unknown-${savedAt}`)
      const refresh = refreshProjectSkills(workspace, saved, doc({ revision: 3, savedAt }))!
      expect(refresh, String(savedAt)).toMatchObject({ owed: true, change: 1,
        notice: `The project's instructions changed. Before your next step, read ${q(instructions)} again and work by it.` })
      expect(refresh.notice.startsWith('The project\'s instructions changed')).toBe(true)
    }
  })

  it('tells a tools update since the launch, and nothing about the instructions it read at launch', () => {
    const { workspace, saved, tools, instructions } = launched()
    // Launched by an earlier release whose tools text differs; the daemon has updated since.
    writeFileSync(tools, 'older tools')
    writeFileSync(join(dirname(tools), 'version.json'), JSON.stringify({ text: sha('older tools'), notified: sha('older tools'), change: 0, toldChange: 0 }))
    const refresh = refreshProjectSkills(workspace, saved, doc())!
    expect(refresh).toMatchObject({ owed: true, change: 1,
      notice: `Harness updated your swarm-tools skill. Before your next step, read ${q(tools)} again and work by it.` })
    expect(readFileSync(tools, 'utf8')).toBe(SWARM_TOOLS_SKILL)
    expect(readFileSync(instructions, 'utf8')).toBe(instructionsSkillText(doc()))
    recordProjectSkillsNotice(workspace, saved, refresh)
    expect(refreshProjectSkills(workspace, saved, doc())).toMatchObject({ owed: false, change: 1 })
  })

  it('tells once when the instructions change', () => {
    const { workspace, saved, instructions } = launched()
    refreshProjectSkills(workspace, saved, doc())
    const next = doc({ revision: 2, text: 'Reviews run on Opus.\n', summary: 'Reviews run on Opus' })
    const refresh = refreshProjectSkills(workspace, saved, next)!
    expect(refresh).toMatchObject({ owed: true, change: 1,
      notice: `The project's instructions changed: Reviews run on Opus. Before your next step, read ${q(instructions)} again and work by it.` })
    expect(refresh.notice.startsWith('The project\'s instructions changed: Reviews run on Opus.')).toBe(true)
    expect(readFileSync(instructions, 'utf8')).toBe(instructionsSkillText(next))
    // Not recorded yet (no open group, a restart): still owed, under the same id.
    expect(refreshProjectSkills(workspace, saved, next)).toEqual(refresh)
    recordProjectSkillsNotice(workspace, saved, refresh)
    expect(refreshProjectSkills(workspace, saved, next)).toMatchObject({ owed: false, change: 1 })
    // A save without a summary, or one that ends its own sentence.
    expect(refreshProjectSkills(workspace, saved, doc({ revision: 3 }))!.notice)
      .toBe(`The project's instructions changed. Before your next step, read ${q(instructions)} again and work by it.`)
    expect(refreshProjectSkills(workspace, saved, doc({ revision: 4, summary: 'Is review optional now?' }))!.notice)
      .toMatch(/^The project's instructions changed: Is review optional now\? Before/)
  })

  it('tells one notice for the newest of several saves, never one per save', () => {
    const { workspace, saved, instructions } = launched()
    refreshProjectSkills(workspace, saved, doc())
    const second = refreshProjectSkills(workspace, saved, doc({ revision: 2, summary: 'Two' }))!
    const third = refreshProjectSkills(workspace, saved, doc({ revision: 3, text: 'Three.\n', summary: 'Three' }))!
    expect(third).toMatchObject({ owed: true, change: 2,
      notice: `The project's instructions changed: Three. Before your next step, read ${q(instructions)} again and work by it.` })
    expect(third.version).not.toBe(second.version)
    // The earlier save's notice, recorded late, covers nothing newer.
    recordProjectSkillsNotice(workspace, saved, second)
    expect(refreshProjectSkills(workspace, saved, doc({ revision: 3, text: 'Three.\n', summary: 'Three' }))).toEqual(third)
    recordProjectSkillsNotice(workspace, saved, third)
    expect(refreshProjectSkills(workspace, saved, doc({ revision: 3, text: 'Three.\n', summary: 'Three' }))).toMatchObject({ owed: false, change: 2 })
  })

  // Project instructions, phase 4 (decision 1): the notice names the role file the session holds, whatever its kind.
  it('names each kind\'s own role file when it moves a session started before this release', () => {
    for (const [skill, name] of [[{ role: 'agent', fallback: 'review' }, 'swarm-review'], [{ role: 'coordinator' }, 'swarm-lead'], [{ role: 'agent' }, 'swarm-dev']] as const) {
      const workspace = fixture(), saved = { ...skill, key: name }
      const { file } = prepareSwarmSkill(workspace, saved)
      rmSync(join(dirname(dirname(file)), 'swarm-tools'), { recursive: true })
      expect(refreshProjectSkills(workspace, saved, doc())!.notice).toMatch(new RegExp(`^Harness now gives you two skills in place of your ${name} skill: `))
    }
  })

  it('moves a session started before this release', () => {
    const { workspace, saved, file, skills, tools, instructions } = launched()
    const role = readFileSync(file, 'utf8')
    // An earlier release launched it: no tools skill, no record.
    rmSync(join(skills, 'swarm-tools'), { recursive: true })
    const refresh = refreshProjectSkills(workspace, saved, doc())!
    expect(refresh).toMatchObject({ tools, instructions, owed: true, change: 1,
      notice: `Harness now gives you two skills in place of your swarm-dev skill: ${q(tools)}, Harness's Swarm commands, and ${q(instructions)}, this project's instructions and your role in them. Before your next step, read both and work by them.` })
    expect(readFileSync(tools, 'utf8')).toBe(SWARM_TOOLS_SKILL)
    expect(readFileSync(instructions, 'utf8')).toBe(instructionsSkillText(doc()))
    // Its role file stays, for an old backend.
    expect(readFileSync(file, 'utf8')).toBe(role)
    expect(refreshProjectSkills(workspace, saved, doc())).toEqual(refresh)
    // A pass cut off after the files and before the record tells the same notice again, under the same id.
    rmSync(join(dirname(instructions), 'version.json'))
    expect(refreshProjectSkills(workspace, saved, doc())).toEqual(refresh)
    recordProjectSkillsNotice(workspace, saved, refresh)
    expect(refreshProjectSkills(workspace, saved, doc())).toMatchObject({ owed: false })
    // A relaunch keeps both files and owes nothing new.
    prepareSwarmSkill(workspace, saved)
    expect(refreshProjectSkills(workspace, saved, doc())).toMatchObject({ owed: false, change: 1 })
  })

  it('tells a role change and a tools update in one notice', () => {
    const { workspace, saved, tools, instructions } = launched()
    refreshProjectSkills(workspace, saved, doc())
    // What an earlier release wrote and told: its own tools text.
    const recordFile = join(dirname(instructions), 'version.json'), record = JSON.parse(readFileSync(recordFile, 'utf8'))
    writeFileSync(recordFile, JSON.stringify({ ...record, tools: sha('older tools'), told: { ...record.told, tools: sha('older tools') } }))
    writeFileSync(tools, 'older tools')
    const refresh = refreshProjectSkills(workspace, saved, doc({ roleName: 'Reviewer' }))!
    expect(refresh).toMatchObject({ owed: true, change: 1,
      notice: `You are now this project's Reviewer. Harness updated your swarm-tools skill. Before your next step, read ${q(instructions)} and ${q(tools)} again and work by them.` })
    expect(readFileSync(tools, 'utf8')).toBe(SWARM_TOOLS_SKILL)
    expect(readFileSync(instructions, 'utf8')).toContain('You are this project\'s Reviewer. Ken is the project\'s coordinator.')
    // A save and a role change before the notice is recorded: one notice, its parts in order.
    expect(refreshProjectSkills(workspace, saved, doc({ roleName: 'Reviewer', revision: 2, summary: 'Reviews run on Opus' }))).toMatchObject({ owed: true, change: 2,
      notice: `The project's instructions changed: Reviews run on Opus. You are now this project's Reviewer. Harness updated your swarm-tools skill. Before your next step, read ${q(instructions)} and ${q(tools)} again and work by them.` })
  })

  it('gives a Buddy the instructions file only', () => {
    const workspace = fixture(), saved = { role: 'buddy' as const, key: 'buddy' }
    const { file } = prepareSwarmSkill(workspace, saved, folderOnly)
    const skills = dirname(dirname(file)), instructions = join(skills, 'swarm-instructions', 'SKILL.md')
    const buddyDoc = doc({ roleName: 'Buddy' })
    const first = refreshProjectSkills(workspace, saved, buddyDoc)!
    expect(first).toMatchObject({ tools: '', instructions, owed: true,
      notice: `Your project's instructions are at ${q(instructions)}: read them as your member's helper; they do not change your limits.` })
    expect(readdirSync(skills).sort()).toEqual(['swarm-buddy', 'swarm-instructions'])
    expect(readFileSync(instructions, 'utf8')).toBe(instructionsSkillText(buddyDoc))
    // In its folder's .harness, which its folder lock leaves alone.
    expect(instructions.startsWith(join(realpathSync(workspace), '.harness') + sep)).toBe(true)
    // Told once.
    recordProjectSkillsNotice(workspace, saved, first)
    expect(refreshProjectSkills(workspace, saved, buddyDoc)).toMatchObject({ owed: false })
    prepareSwarmSkill(workspace, saved, folderOnly)
    expect(refreshProjectSkills(workspace, saved, buddyDoc)).toMatchObject({ owed: false })
    expect(readdirSync(skills).sort()).toEqual(['swarm-buddy', 'swarm-instructions'])
    // A later save is told as to any agent, with no tools part and no switch line.
    expect(refreshProjectSkills(workspace, saved, doc({ roleName: 'Buddy', revision: 2 }))).toMatchObject({ owed: true,
      notice: `The project's instructions changed. Before your next step, read ${q(instructions)} again and work by it.` })
  })

  it('refuses a symlinked skill folder', () => {
    for (const name of ['swarm-instructions', 'swarm-tools']) {
      const { workspace, saved, skills } = launched(name), outside = fixture()
      rmSync(join(skills, name), { recursive: true, force: true })
      symlinkSync(outside, join(skills, name))
      expect(() => refreshProjectSkills(workspace, saved, doc()), name).toThrow(/plain|symlink/i)
      expect(readdirSync(outside), name).toEqual([])
    }
    // And a redirected file, without writing through it.
    const { workspace, saved, instructions } = launched('file'), target = join(fixture(), 'elsewhere.md')
    refreshProjectSkills(workspace, saved, doc())
    writeFileSync(target, 'kept')
    rmSync(instructions); symlinkSync(target, instructions)
    expect(() => refreshProjectSkills(workspace, saved, doc({ revision: 2 }))).toThrow(/plain|symlink/i)
    expect(readFileSync(target, 'utf8')).toBe('kept')
  })

  it('does nothing for a removed worktree', () => {
    const saved = { role: 'dev' as const, key: 'gone' }
    expect(refreshProjectSkills(join(fixture(), 'removed-worktree'), saved, doc())).toBeNull()
    expect(() => recordProjectSkillsNotice(join(fixture(), 'removed-worktree'), saved, { version: 'any', change: 1 })).not.toThrow()
  })
})
