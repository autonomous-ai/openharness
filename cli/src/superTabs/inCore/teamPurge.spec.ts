import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createConfidentialPurge, purgeRecord, rewriteIfUnchanged, scrubClaudeSession, sweepForSession, type PurgeTarget } from './teamPurge.js'

// A confidential session the Swarm ended for good in a Harness Team account (#895): its data in the Team user's shared
// engine homes goes, and the account stays held until a sweep finds nothing of it (security re-checks of #2089).

const dir = () => mkdtempSync(join(tmpdir(), 'team-purge-'))
const CWD = '/Users/team/swarm/app/.worktrees/pm'
const SLUG = CWD.replace(/[^A-Za-z0-9]/g, '-')
const target = (over: Partial<PurgeTarget> = {}): PurgeTarget => ({ agentId: 'pm', sessionId: 'pm-session', cwd: CWD, engine: 'claude', codexHome: null, ...over })

/** The Team user's home as Claude Code 2.1 leaves it: the PM's traces among another session's, which names the PM too. */
function teamHome() {
  const home = dir(), claude = join(home, '.claude')
  for (const sub of ['paste-cache', `projects/${SLUG}/memory`, 'projects/-other', 'file-history/pm-session', 'session-env/pm-session', 'todos', 'debug', 'backups'])
    mkdirSync(join(claude, sub), { recursive: true })
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(claude, 'history.jsonl'), [
    JSON.stringify({ display: 'the launch slips a week', pastedContents: { 1: { id: 1, type: 'text', contentHash: 'abc123' } }, project: CWD, sessionId: 'pm-session' }),
    JSON.stringify({ display: 'other work', pastedContents: {}, project: '/Users/team/swarm/web', sessionId: 'other' }), ''].join('\n'))
  writeFileSync(join(claude, 'paste-cache', 'abc123.txt'), 'pasted secret')
  writeFileSync(join(claude, 'paste-cache', 'keep.txt'), 'other paste')
  writeFileSync(join(claude, 'projects', SLUG, 'pm-session.jsonl'), 'transcript')
  writeFileSync(join(claude, 'projects', SLUG, 'memory', 'MEMORY.md'), 'remembered')
  // Another agent's own transcript reads the PM's status: it names the PM's session and folder, and is not the PM's to delete.
  writeFileSync(join(claude, 'projects', '-other', 'other.jsonl'), `{"tool":"harness super-tab status","out":"pm-session ${CWD}"}`)
  writeFileSync(join(claude, 'todos', 'pm-session-agent-pm-session.json'), '[]')
  writeFileSync(join(claude, 'todos', 'other-agent-other.json'), '[]')
  writeFileSync(join(claude, 'debug', 'pm-session.txt'), 'debug')
  const config = { numStartups: 3, projects: { [CWD]: { history: ['secret'], allowedTools: [] }, [`${CWD}2`]: { allowedTools: [] }, '/Users/team/swarm/web': { allowedTools: [] } },
    githubRepoPaths: { 'example/app': [CWD, '/Users/team/swarm/app'], 'example/pm-only': [CWD] } }
  writeFileSync(join(home, '.claude.json'), JSON.stringify(config, null, 2))
  writeFileSync(join(claude, 'backups', '.claude.json.backup.1793236000000'), JSON.stringify(config))
  return { home, claude }
}

describe('scrubbing a Claude Code session from the Team user\'s shared home', () => {
  it('removes every file and entry its session or folder names, and keeps every other session\'s', async () => {
    const { home, claude } = teamHome()
    expect(await scrubClaudeSession(home, target())).toEqual(['abc123'])
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe(`${JSON.stringify({ display: 'other work', pastedContents: {}, project: '/Users/team/swarm/web', sessionId: 'other' })}\n`)
    expect([existsSync(join(claude, 'paste-cache', 'abc123.txt')), existsSync(join(claude, 'paste-cache', 'keep.txt'))]).toEqual([false, true])
    for (const gone of [`projects/${SLUG}`, 'file-history/pm-session', 'session-env/pm-session', 'todos/pm-session-agent-pm-session.json', 'debug/pm-session.txt']) {
      expect(existsSync(join(claude, gone)), gone).toBe(false)
    }
    expect(existsSync(join(claude, 'projects', '-other', 'other.jsonl'))).toBe(true)
    expect(existsSync(join(claude, 'todos', 'other-agent-other.json'))).toBe(true)
    // The config and its backups: its folder's entry and its repository paths go, the rest stays as it was.
    const scrubbed = { numStartups: 3, projects: { [`${CWD}2`]: { allowedTools: [] }, '/Users/team/swarm/web': { allowedTools: [] } },
      githubRepoPaths: { 'example/app': ['/Users/team/swarm/app'] } }
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual(scrubbed)
    expect(JSON.parse(readFileSync(join(claude, 'backups', '.claude.json.backup.1793236000000'), 'utf8'))).toEqual(scrubbed)
    // Its sweep then finds nothing, though another session's transcript, and a folder whose name only starts with its own, name it.
    expect(await sweepForSession(home, target(), ['abc123'])).toBeNull()
  })

  it('keeps what does not name it, whatever shape, and never takes another session\'s project folder for a missing one', async () => {
    const home = dir(), claude = join(home, '.claude')
    mkdirSync(join(claude, 'projects', '-other'), { recursive: true })
    writeFileSync(join(claude, 'projects', '-other', 'other.jsonl'), 'other')
    writeFileSync(join(claude, 'history.jsonl'), ['not json, other work', 'not json, pm-session', `not json, ${CWD}`,
      JSON.stringify({ sessionId: 'pm-session', pastedContents: { 1: { contentHash: '../keep' }, 2: null } }), ''].join('\n'))
    writeFileSync(join(home, '.claude.json'), '{ not json')
    expect(await scrubClaudeSession(home, target())).toEqual([])
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe('not json, other work\n')
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{ not json')
    expect(await scrubClaudeSession(home, target({ cwd: null }))).toEqual([])
    expect(await scrubClaudeSession(home, target({ sessionId: '../x', cwd: '/' }))).toEqual([])
    // A paste name from an earlier record that is no file name is never followed out of the paste cache.
    writeFileSync(join(home, 'keep.txt'), 'kept')
    await scrubClaudeSession(home, target(), ['../../keep'])
    expect(existsSync(join(home, 'keep.txt'))).toBe(true)
    expect(existsSync(join(claude, 'projects', '-other', 'other.jsonl'))).toBe(true)
    // Every line its own: the history is left empty; a home where Claude Code never ran has nothing to scrub.
    writeFileSync(join(claude, 'history.jsonl'), `${JSON.stringify({ sessionId: 'pm-session' })}\n`)
    await scrubClaudeSession(home, target())
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe('')
    expect(await scrubClaudeSession(dir(), target())).toEqual([])
  })
})

describe('the sweep for what a scrub left', () => {
  it('finds the session or folder where Claude Code and Codex write its own data, and nowhere else', async () => {
    const { home, claude } = teamHome()
    await scrubClaudeSession(home, target())
    appendFileSync(join(claude, 'history.jsonl'), `${JSON.stringify({ display: 'late', project: CWD, sessionId: 'pm-session' })}\n`)
    expect(await sweepForSession(home, target(), [])).toBe(join(claude, 'history.jsonl'))
    await scrubClaudeSession(home, target())
    writeFileSync(join(claude, 'paste-cache', 'abc123.txt'), 'written again')
    expect(await sweepForSession(home, target(), ['abc123'])).toBe(join(claude, 'paste-cache', 'abc123.txt'))
    writeFileSync(join(claude, 'paste-cache', 'abc123.txt'), '')
    await scrubClaudeSession(home, target(), ['abc123'])
    mkdirSync(join(claude, 'new-feature', 'pm-session'), { recursive: true })
    expect(await sweepForSession(home, target(), ['abc123'])).toBe(join(claude, 'new-feature', 'pm-session'))
    mkdirSync(join(claude, 'later', SLUG), { recursive: true })
    expect(await sweepForSession(home, target(), [])).toBe(join(claude, 'later', SLUG))
    writeFileSync(join(home, '.codex', 'history.jsonl'), '{"session_id":"pm-session"}')
    expect(await sweepForSession(home, target({ cwd: null }), [])).toBe(join(home, '.codex', 'history.jsonl'))
    expect(await sweepForSession(dir(), target(), [])).toBeNull()
  })
})

describe('a scrub and sweep with part of a session unknown', () => {
  it('scrubs by folder alone, by session alone, leaves a config that is no object, and finds its folder left in a backup', async () => {
    const home = dir(), claude = join(home, '.claude')
    mkdirSync(join(claude, 'backups'), { recursive: true })
    writeFileSync(join(claude, 'history.jsonl'), `${JSON.stringify({ project: CWD })}\n`)
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [CWD]: {} } }))
    await scrubClaudeSession(home, target({ sessionId: null }))
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe('')
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({ projects: {} })
    writeFileSync(join(home, '.claude.json'), 'null')
    await scrubClaudeSession(home, target())
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('null')
    writeFileSync(join(claude, 'backups', '.claude.json.backup.1'), 'a copy that is no JSON, naming "' + CWD + '"')
    expect(await sweepForSession(home, target(), [])).toBe(join(claude, 'backups', '.claude.json.backup.1'))
    expect(await sweepForSession(home, target({ sessionId: '../x' }), [])).toBe(join(claude, 'backups', '.claude.json.backup.1'))
    // With no folder, nothing of the config is its; with neither, nothing is.
    expect(await sweepForSession(home, target({ cwd: null }), ['../bad'])).toBeNull()
    expect(await sweepForSession(home, target({ cwd: null, sessionId: null }), [])).toBeNull()
  })

  it('records a session whose engine gave no session id or Codex home', async () => {
    const home = dir()
    const record = purgeRecord(join(home, 'super-tabs', 'team-purges.json'))
    let held = true
    const purge = vi.fn(async (request: Record<string, unknown>) => { if (request.mode === 'delete') held = false; return request.mode === 'inspect' ? { reviewId: 'r' } : { ok: true } })
    const ended = createConfidentialPurge({ confidential: () => true, home, record, purge,
      session: id => held ? { agentId: id, registeredAt: 5, engine: 'claude', cwd: CWD } : null })
    expect(await ended('pm')).toEqual({ ok: true })
    expect(purge.mock.calls[0]![0]).toEqual({ agentId: 'pm', sessionId: null, createdAt: 5, mode: 'inspect' })
    record.drop('none')
    expect(record.pending()).toEqual([])
  })
})

describe('rewriting a file other agents of the account write too', () => {
  it('writes it again from what is there when it changed while it was being rewritten, so no write is lost', async () => {
    const file = join(dir(), 'history.jsonl')
    writeFileSync(file, 'ours\nother\n')
    let raced = false
    const transform = vi.fn((text: string) => {
      // Another agent writes while the first attempt is being made.
      if (!raced) { raced = true; appendFileSync(file, 'theirs\n') }
      return text.split('\n').filter(line => line !== 'ours').join('\n')
    })
    expect(await rewriteIfUnchanged(file, transform)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('other\ntheirs\n')
    expect(transform).toHaveBeenCalledTimes(2)
    // Unchanged by the rewrite: nothing is written. Missing: nothing to do.
    expect(await rewriteIfUnchanged(file, text => text)).toBe(true)
    expect(await rewriteIfUnchanged(join(dir(), 'none'), text => text)).toBe(true)
  })

  it('gives up, writing nothing, when it keeps changing', async () => {
    const file = join(dir(), 'busy.jsonl')
    writeFileSync(file, 'ours\n')
    expect(await rewriteIfUnchanged(file, text => { appendFileSync(file, 'x\n'); return '' })).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('ours\nx\nx\nx\nx\nx\n')
  })
})

describe('the purge of a confidential session the Swarm ended', () => {
  /** The reviewed purge as lib/purgeAgentService.ts is: a delete drops the session from its stopped catalog. */
  function service(home: string, codexHome: string | null = null) {
    let held = true
    const calls: Array<Record<string, unknown>> = []
    const purge = vi.fn(async (request: Record<string, unknown>) => {
      calls.push(request)
      if (request.mode === 'inspect') return { reviewId: 'review-1' }
      held = false
      return { ok: true }
    })
    const session = (id: string) => held ? { agentId: id, sessionId: 'pm-session', registeredAt: 5, engine: codexHome ? 'codex' : 'claude', cwd: CWD, codexHome } : null
    const record = purgeRecord(join(home, 'super-tabs', 'team-purges.json'))
    return { purge, session, record, calls }
  }

  it('deletes through the reviewed purge, scrubs, sweeps, and keeps the session in its record until the sweep passes', async () => {
    const { home, claude } = teamHome()
    const s = service(home)
    const ended = createConfidentialPurge({ confidential: id => id === 'pm', home, session: s.session, purge: s.purge, record: s.record })
    // Something the scrub does not know of still names the session: the purge fails and the session stays in its record.
    mkdirSync(join(claude, 'new-feature', 'pm-session'), { recursive: true })
    expect(await ended('pm')).toEqual({ error: 'SCRUB_INCOMPLETE', detail: `Something still names the session: ${join(claude, 'new-feature', 'pm-session')}` })
    expect(s.calls.map(c => c.mode)).toEqual(['inspect', 'delete'])
    expect(s.record.pending()).toEqual([{ agentId: 'pm', sessionId: 'pm-session', cwd: CWD, engine: 'claude', codexHome: null, pastes: ['abc123'] }])
    // The retry, its stopped entry gone: it scrubs and sweeps again from the record (a history line written since included).
    appendFileSync(join(claude, 'history.jsonl'), `${JSON.stringify({ display: 'late', sessionId: 'pm-session' })}\n`)
    expect(await ended('pm')).toMatchObject({ error: 'SCRUB_INCOMPLETE' })
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).not.toContain('pm-session')
    writeFileSync(join(claude, 'stray'), '')
    const { rmSync } = await import('node:fs')
    rmSync(join(claude, 'new-feature'), { recursive: true })
    expect(await ended('pm')).toEqual({ ok: true })
    expect(s.calls.map(c => c.mode)).toEqual(['inspect', 'delete'])
    expect(s.record.pending()).toEqual([])
    expect(purgeRecord(join(home, 'super-tabs', 'team-purges.json')).pending()).toEqual([])
  })

  // Security re-check 2 of 9e49723b8: the paste names reached the record only after the history lines naming them were gone,
  // so a scrub that died between the two lost them, and a paste left behind passed the sweep.
  it('saves the pastes its history names before rewriting it, so a scrub that dies after the rewrite still finds them', async () => {
    const { home, claude } = teamHome()
    const s = service(home)
    // A paste the scrub cannot remove (a folder in its place) fails it right after the history was rewritten.
    const { rmSync: remove } = await import('node:fs')
    remove(join(claude, 'paste-cache', 'abc123.txt'))
    mkdirSync(join(claude, 'paste-cache', 'abc123.txt'))
    const ended = createConfidentialPurge({ confidential: () => true, home, session: s.session, purge: s.purge, record: s.record })
    await expect(ended('pm')).rejects.toThrow()
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).not.toContain('pm-session')
    expect(s.record.get('pm')?.pastes).toEqual(['abc123'])
    // The retry, the history no longer naming it: the record's paste is still swept for, and fails it until it is gone.
    const { rmSync } = await import('node:fs')
    rmSync(join(claude, 'paste-cache', 'abc123.txt'), { recursive: true })
    writeFileSync(join(claude, 'paste-cache', 'abc123.txt'), 'left behind')
    const sweep = await sweepForSession(home, s.record.get('pm')!, s.record.get('pm')!.pastes!)
    expect(sweep).toBe(join(claude, 'paste-cache', 'abc123.txt'))
    expect(await ended('pm')).toEqual({ ok: true })
  })

  it('of a Codex session in its own engine home, deletes that home whole', async () => {
    const home = dir(), codexHome = join(home, '.harness-pm-homes', 'super-start-1', 'codex')
    mkdirSync(join(codexHome, 'sessions'), { recursive: true })
    writeFileSync(join(codexHome, 'history.jsonl'), 'the launch slips a week')
    const s = service(home, codexHome)
    const ended = createConfidentialPurge({ confidential: () => true, home, session: s.session, purge: s.purge, record: s.record })
    expect(await ended('pm')).toEqual({ ok: true })
    expect(existsSync(join(home, '.harness-pm-homes', 'super-start-1'))).toBe(false)
  })

  it('leaves any other session alone; a refused review or delete stops it, the session kept in its record', async () => {
    const home = dir()
    const record = purgeRecord(join(home, 'super-tabs', 'team-purges.json'))
    const refused = vi.fn(async () => ({ error: 'NOT_FOUND' }))
    const session = (id: string) => ({ agentId: id, sessionId: 'pm-session', registeredAt: 5, engine: 'claude', cwd: CWD, codexHome: null })
    const ended = createConfidentialPurge({ confidential: id => id === 'pm', home, session, purge: refused, record })
    expect(await ended('worker')).toEqual({ skipped: true })
    expect(await createConfidentialPurge({ confidential: () => true, home, session: () => null, purge: refused, record })('gone')).toEqual({ skipped: true })
    expect(await ended('pm')).toEqual({ error: 'NOT_FOUND' })
    expect(record.pending().map(t => t.agentId)).toEqual(['pm'])
    const refusedDelete = vi.fn(async (request: Record<string, unknown>) => request.mode === 'inspect' ? { reviewId: 'r' } : { error: 'DELETE_IN_PROGRESS' })
    expect(await createConfidentialPurge({ confidential: () => true, home, session, purge: refusedDelete, record })('pm')).toEqual({ error: 'DELETE_IN_PROGRESS' })
  })
})

// Security re-check 1 of 147777f54: with its record unreadable, a retry for a session already gone answered 'skipped', and its
// close released the account. While the record cannot be read, no purge is answered: the close fails, the hold stays.
describe('a purge while its record cannot be read', () => {
  it('is refused, the session gone or not, so the close fails and the account stays held until a person clears it', async () => {
    const home = dir(), file = join(home, 'super-tabs', 'team-purges.json')
    mkdirSync(join(home, 'super-tabs'), { recursive: true })
    writeFileSync(file, '{')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const record = purgeRecord(file)
    const purge = vi.fn(async () => ({ ok: true }))
    const refusal = { error: 'PURGE_RECORD_UNREADABLE',
      detail: `This machine's record of purges still to finish could not be read and was kept aside at ${file}.unreadable. Its owner checks what it names, then deletes it.` }
    for (const session of [() => null, (id: string) => ({ agentId: id, sessionId: 'pm-session', registeredAt: 5, engine: 'claude', cwd: CWD })]) {
      expect(await createConfidentialPurge({ confidential: () => true, home, session, purge, record })('pm')).toEqual(refusal)
    }
    expect(purge).not.toHaveBeenCalled()
    // Said once, where it was kept.
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([`[super-tabs] the record of purges still to finish could not be read; kept aside at ${file}.unreadable until its owner clears it`])
    warn.mockRestore()
  })
})

describe('the record of purges still to finish', () => {
  it('keeps them across restarts, and says when it cannot be read, so the account stays held (teamApps.ts)', async () => {
    const file = join(dir(), 'team-purges.json')
    const record = purgeRecord(file)
    record.put(target())
    record.put(target({ pastes: ['abc'] }))
    expect(purgeRecord(file).pending()).toEqual([target({ pastes: ['abc'] })])
    expect(purgeRecord(file).get('pm')).toEqual(target({ pastes: ['abc'] }))
    record.drop('pm')
    expect(purgeRecord(file).pending()).toEqual([])
    expect(purgeRecord(file).unknown()).toBe(false)
    // Unreadable, it is never written over (re-check 2 of 9e49723b8): kept aside, the purges it names unforgotten, and the
    // account held until a person clears it, whatever is recorded after.
    writeFileSync(file, '{')
    const later = purgeRecord(file)
    expect([later.pending(), later.unknown()]).toEqual([[], true])
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{')
    later.put(target())
    expect([purgeRecord(file).pending(), purgeRecord(file).unknown(), readFileSync(`${file}.unreadable`, 'utf8')]).toEqual([[target()], true, '{'])
    // Unreadable again with one already aside: kept aside too, under a name of its own.
    writeFileSync(file, '[')
    expect(purgeRecord(file).unknown()).toBe(true)
    expect(readFileSync(`${file}.unreadable.1`, 'utf8')).toBe('[')
    const { rmSync } = await import('node:fs')
    rmSync(`${file}.unreadable`)
    expect(purgeRecord(file).unknown()).toBe(true)
    rmSync(`${file}.unreadable.1`)
    expect(purgeRecord(file).unknown()).toBe(false)
    writeFileSync(file, '{"pm": 3}')
    expect([purgeRecord(file).get('pm'), purgeRecord(file).unknown()]).toEqual([undefined, false])
  })
})
