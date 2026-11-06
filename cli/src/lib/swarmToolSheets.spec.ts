import { describe, expect, it } from 'vitest'
import { SWARM_TOOLS_SKILL } from './swarmTools.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { manualBlocks, PM_SHEET_NOTE, sheetEntries, sourceFingerprints, staleSheetEntries, swarmToolsSheet, TOOLS_ROLES, toolsRoleFor, type ToolsRole } from './swarmToolSheets.js'

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
const sheet = (role: ToolsRole) => swarmToolsSheet(role)

// Task #3448 (anh Dee's Swarm redesign): each role reads what it uses; the full manual stays one command away.
describe('the role tools sheets', () => {
  it('keeps the PM sheet at most 3 KB and every other sheet at most 6 KB', () => {
    expect(bytes(sheet('pm'))).toBeLessThanOrEqual(3 * 1024)
    for (const role of TOOLS_ROLES.filter(r => r !== 'pm')) expect(bytes(sheet(role)), role).toBeLessThanOrEqual(6 * 1024)
  })

  it('holds, in the PM sheet, every command the PM runs', () => {
    const pm = sheet('pm')
    for (const word of ['`status', '`mine`', '`task GROUP`', '`messages GROUP', '`message GROUP', '`instructions [PROJECT]`', '`decisions', '`costs', '`screen AGENT', '`type AGENT',
      '`post GROUP TEXT OPERATION_ID', '`react GROUP', '`command OPERATION_ID', 'conversation.create', 'work.define', 'conversation.agent', 'conversation.requester',
      'work.queue', 'work.priority', 'work.assign', 'work.status', 'work.cancel', 'agent.release', 'proposal.close', 'conversation.merged', 'decision.ask', 'person.tell',
      'project.report', 'project.digest', 'tab.tidy', 'machine.engineResume', 'instructions.save', 'note.add', 'note.remove',
      '`route GROUP JSON', '`plan', '`capacity', '`start OPERATION_ID JSON', '`resume START_ID`', 'help tools']) {
      expect(pm, word).toContain(word)
    }
  })

  // Task #3581 (anh Dee, 11-06): lamp's PM did not know the Swarm v2 process. Its sheet says how the crew works.
  it('explains, in the PM sheet, the crew, lanes and when to start an agent', () => {
    const pm = sheet('pm')
    for (const word of ['crew.add', 'role', 'lane', 'backend, cli, desktop, mobile, docs', 'work.lane', 'only to replace a broken one', '`answer GROUP ID', 'process.confirm']) {
      expect(pm, word).toContain(word)
    }
  })

  // Task #3581: a release that changes the PM's sheet carries a what-changed note, which reaches each PM (backend
  // superTabs/processNotes.ts). The sheet is pinned to the note it was last announced with.
  it('pins the PM sheet to a what-changed note the backend sends: changing it needs a new note', () => {
    expect(createHash('sha256').update(sheet('pm')).digest('hex').slice(0, 12),
      'the PM sheet changed: add a what-changed note in backend/src/superTabs/processNotes.ts and pin it in PM_SHEET_NOTE').toBe(PM_SHEET_NOTE.sheet)
    const notes = readFileSync(fileURLToPath(new URL('../../../backend/src/superTabs/processNotes.ts', import.meta.url)), 'utf8')
    expect(notes).toContain(`id: '${PM_SHEET_NOTE.id}'`)
  })

  it('holds, in each other sheet, the commands that role uses', () => {
    const common = ['`mine`', '`task GROUP`', '`messages GROUP', '`instructions [PROJECT]`', '`post GROUP TEXT OPERATION_ID', '`react GROUP', '`command OPERATION_ID', 'work.status', 'help tools']
    const more: Record<Exclude<ToolsRole, 'pm'>, string[]> = {
      engineer: ['work.check', 'needs_human', 'conversation.create', 'reviewOf', 'work.assign', '`route GROUP JSON', '`start OPERATION_ID JSON', 'agent.release', 'decision.ask'],
      reviewer: ['work.check', 'needs_human'],
      tester: ['work.check', 'needs_human'],
      guide: ['`status', '`message GROUP'],
    }
    for (const role of TOOLS_ROLES.filter((r): r is Exclude<ToolsRole, 'pm'> => r !== 'pm')) {
      for (const word of [...common, ...more[role]]) expect(sheet(role), `${role}: ${word}`).toContain(word)
    }
  })

  // #3394 (review of #3218 after the merge with the role sheets): a verdict counts only at the head and base its checker
  // names, so every sheet that records checks asks for both.
  it('asks, in each sheet that records checks, for the head and base read', () => {
    for (const role of ['engineer', 'reviewer', 'tester'] as const) {
      const line = sheet(role).split('\n').find(l => l.includes('work.check'))!
      expect(line, role).toContain('head')
      expect(line, role).toContain('base')
    }
  })

  it('names, in some sheet, every command the full manual documents', () => {
    const all = TOOLS_ROLES.map(sheet).join('\n')
    const commands = [...SWARM_TOOLS_SKILL.matchAll(/`\{"type":"([a-z.A-Z]+)"/g)].map(m => m[1]!)
    expect(commands.length).toBeGreaterThan(20)
    for (const type of commands) expect(all, type).toContain(type)
    for (const verb of ['status', 'mine', 'task', 'messages', 'message', 'instructions', 'decisions', 'costs', 'screen', 'type', 'post', 'react', 'route', 'plan', 'capacity', 'start', 'resume']) {
      expect(all, verb).toMatch(new RegExp('`' + verb + '[ `]'))
    }
  })

  it('gives every rule of the full manual exactly one owner, and the table no rule the manual lacks', () => {
    const blocks = manualBlocks()
    const entries = sheetEntries()
    expect(blocks.length).toBeGreaterThan(60)
    // The blocks and their headings are the manual: nothing in it is lost between them.
    expect(blocks.map(b => b.text).join('\n')).toContain('Print little to save quota.')
    for (const block of blocks) {
      const owners = entries.filter(e => block.first.startsWith(e.at))
      expect(owners.map(e => e.at), block.first).toHaveLength(1)
      expect(['core', ...TOOLS_ROLES]).toContain(owners[0]!.owner)
    }
    for (const entry of entries) expect(blocks.filter(b => b.first.startsWith(entry.at)), entry.at).toHaveLength(1)
  })

  it('says in every sheet where the rest is and keeps the front matter of the manual', () => {
    for (const role of TOOLS_ROLES) {
      const text = sheet(role)
      expect(text.startsWith('---\nname: swarm-tools\n'), role).toBe(true)
      expect(text, role).toContain('`harness super-tab help tools`')
    }
  })

  it('reads the role of a session: the coordinator is the PM, an agent by its project role, the rest the Engineer', () => {
    expect(toolsRoleFor({ coordinator: true })).toBe('pm')
    expect(toolsRoleFor({ coordinator: true, roleName: 'Reviewer' })).toBe('pm')
    expect(toolsRoleFor({ coordinator: false })).toBe('engineer')
    expect(toolsRoleFor({ coordinator: false, roleName: 'Engineer' })).toBe('engineer')
    expect(toolsRoleFor({ coordinator: false, roleName: 'Reviewer' })).toBe('reviewer')
    expect(toolsRoleFor({ coordinator: false, roleName: 'Security reviewer' })).toBe('reviewer')
    expect(toolsRoleFor({ coordinator: false, roleName: 'Tester' })).toBe('tester')
    expect(toolsRoleFor({ coordinator: false, roleName: 'Guide' })).toBe('guide')
    expect(toolsRoleFor({ coordinator: false, roleName: 'Integrator' })).toBe('engineer')
    expect(toolsRoleFor({ coordinator: false, fallback: 'review' })).toBe('reviewer')
  })

  // Review of #3240: the opening of a block says which row is its own, but a rule\'s body can change under it. Each row carries
  // a fingerprint of the block it summarises; a changed block is a stale one-liner until someone reads it and re-seals the row.
  it('binds each row to the text of its block, so an edited rule, or a sub-bullet added, leaves its one-liner stale', () => {
    expect(staleSheetEntries(), 'a rule of the manual changed: update its one-line form in swarmToolSheets.ts, then its fingerprint').toEqual([])
    expect(Object.keys(sourceFingerprints()).sort()).toEqual(sheetEntries().map(e => e.at).sort())
    const changed = (from: string, to: string) => {
      expect(SWARM_TOOLS_SKILL, from).toContain(from)
      return SWARM_TOOLS_SKILL.replace(from, to)
    }
    // Body-only edits: the first line, which names the row, still starts the same.
    expect(staleSheetEntries(changed('Quote TEXT so the shell keeps it one argument.', 'Quote TEXT.'))).toEqual(['- Quote TEXT'])
    expect(staleSheetEntries(changed('size is how long the work runs', 'size is how long the work takes'))).toEqual(['- `route GROUP JSON'])
    expect(staleSheetEntries(changed('  - Starts can be refused when too many starts are pending.', '  - Starts can be refused when too many starts are pending.\n  - A new sub-rule.')))
      .toEqual(['- `start OPERATION_ID JSON`'])
    // An edit to a block with no one-liner is stale too: its row may be switched on later.
    expect(staleSheetEntries(changed('A post stays inside your project. Private', 'A post stays inside your project, and private'))).toEqual(['- A post stays inside your project'])
    // The first line is what names a row: edited, the block matches none, and is reported as it now reads.
    expect(staleSheetEntries(changed('A post stays inside your project.', 'A post stays in your project.'))).toEqual(['- A post stays in your project. Private chats and Buddy chats keep their own members.'])
  })
})
