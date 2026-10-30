import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSwarmAgents } from './agents.js'
import { OWN_LEFT, SHARED_LEFT, SWEEP_LEFT, UNREADABLE_DETAIL, createConfidentialPurge, purgeRecord, recordsOtherFolder, rewriteIfUnchanged, scrubClaudeSession, sweepForSession, type PurgeTarget } from './teamPurge.js'

/** A folder that goes between the sweep's listing of its parent and its own read: removed just before that read. */
const vanish = vi.hoisted(() => ({ path: '' }))
/** A folder whose next listing fails with [code], as the system says it, path and all. */
const fail = vi.hoisted(() => ({ path: '', code: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const readdir = (async (path: Parameters<typeof fs.readdir>[0], ...rest: unknown[]) => {
    if (vanish.path && path === vanish.path) { vanish.path = ''; await fs.rm(path, { recursive: true, force: true }) }
    if (fail.path && path === fail.path) {
      const code = fail.code
      fail.path = ''
      throw Object.assign(new Error(`${code}: could not list, scandir '${String(path)}'`), { code })
    }
    return (fs.readdir as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof fs.readdir
  return { ...fs, readdir }
})

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

/** A removed worktree whose Claude Code transcript folder an unrelated folder ([OTHER]) shares: '/' and '.' both become '-'. */
const OTHER = '/Users/me/harnesses/worktrees-old/notes'
function sharedFolder() {
  const home = dir(), claude = join(home, '.claude'), folder = '/Users/me/harnesses/worktrees/old/notes'
  const shared = join(claude, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-')), memory = join(shared, 'memory')
  mkdirSync(memory, { recursive: true })
  return { home, claude, shared, memory, folder }
}
/** A transcript as Claude Code writes it: a working folder on most lines, and [lines] of its own. */
const transcript = (cwd: string | null, ...lines: string[]) => [JSON.stringify({ type: 'summary' }), ...cwd ? [JSON.stringify({ type: 'user', cwd })] : [],
  JSON.stringify(null), JSON.stringify({ cwd: 7 }), 'not json "cwd"', ...lines].join('\n')
/** A tool call as Claude Code records it in an assistant turn. */
const call = (cwd: string, name: string, input: Record<string, string>) => JSON.stringify({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', name, input }] } })
/** What a failed sweep of a shared transcript folder answers. */
const left = (kind: keyof typeof SHARED_LEFT) => SHARED_LEFT[kind]

describe('scrubbing a Claude Code session from the Team user\'s shared home', () => {
  // Security review 2 of #2375: Claude Code's transcript folder name makes every '/' and '.' a dash, so a removed worktree
  // `<worktrees>/old/notes` shares it with an unrelated `~/harnesses/worktrees-old/notes`. Only transcripts that record no
  // other working folder are the session's; the folder goes whole only when every one is.
  it('removes only its own transcripts from a transcript folder another folder\'s sessions share, and says so', async () => {
    const home = dir(), claude = join(home, '.claude'), folder = '/Users/me/harnesses/worktrees/old/notes'
    const shared = join(claude, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'))
    expect(shared).toBe(join(claude, 'projects', '/Users/me/harnesses/worktrees-old/notes'.replace(/[^A-Za-z0-9]/g, '-')))
    for (const sub of ['own/subagents', 'theirs/subagents', 'memory']) mkdirSync(join(shared, sub), { recursive: true })
    writeFileSync(join(shared, 'own.jsonl'), [JSON.stringify({ type: 'summary' }), JSON.stringify({ cwd: folder }), JSON.stringify({ cwd: `${folder}/src` }), 'not json "cwd"'].join('\n'))
    writeFileSync(join(shared, 'theirs.jsonl'), [JSON.stringify({ cwd: '/Users/me/harnesses/worktrees-old/notes' })].join('\n'))
    const shares = vi.fn()
    await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }), [], undefined, shares)
    expect(['own.jsonl', 'own', 'theirs.jsonl', 'theirs', 'memory'].map(name => existsSync(join(shared, name)))).toEqual([false, false, true, true, true])
    expect(shares).toHaveBeenCalledTimes(1)
    // Once only its own are left, the folder goes whole.
    rmSync(join(shared, 'theirs.jsonl'))
    writeFileSync(join(shared, 'again.jsonl'), JSON.stringify({ cwd: folder }))
    await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }), [], undefined, shares)
    expect(existsSync(shared)).toBe(false)
    expect(shares).toHaveBeenCalledTimes(1)
  })

  // Security review 1 of 58b035e: a transcript folder that could not be listed counted as empty and went whole. A permissions
  // error carried its path into the daemon's log, and a passing one (too many open files) deleted other folders' transcripts
  // unread. Only a folder that is not there is empty.
  it('keeps a transcript folder it cannot list, whatever the error, and the sweep holds the account by its kind', async () => {
    const { home, shared, folder } = sharedFolder()
    const theirs = join(shared, 'theirs.jsonl')
    writeFileSync(theirs, JSON.stringify({ cwd: '/Users/me/harnesses/worktrees-old/notes' }))
    const ours = target({ sessionId: null, cwd: folder })
    for (const code of ['EMFILE', 'EACCES', 'EIO']) {
      Object.assign(fail, { path: shared, code })
      await scrubClaudeSession(home, ours, [])
      expect(existsSync(theirs), code).toBe(true)
      Object.assign(fail, { path: shared, code })
      const held = await sweepForSession(home, ours, [])
      expect(held, code).toBe(left('unreadFolder'))
      expect(held).not.toContain(home)
    }
    // The system's own refusal, as a Team account meets it.
    chmodSync(shared, 0o000)
    try {
      await scrubClaudeSession(home, ours, [])
      expect(await sweepForSession(home, ours, [])).toBe(left('unreadFolder'))
    } finally { chmodSync(shared, 0o700) }
    expect(existsSync(theirs)).toBe(true)
    // One gone since its parent was listed is nothing of the session's.
    vanish.path = shared
    expect(await sweepForSession(home, ours, [])).toBeNull()
  })

  // Re-check of 68ec6f0 (Lark): the sweep's walk read a folder it could not list as empty, so whatever of the session was in
  // it went unseen and the purge finished. Only a folder that is not there is empty; any other holds the account by its kind.
  it('holds the account on any folder of the engines\' homes the sweep cannot list, by its kind, and passes one that went', async () => {
    const { home, claude } = teamHome()
    const ours = target()
    rmSync(join(claude, 'projects', SLUG), { recursive: true })
    // Everything else of the session gone, its file history left in a folder the sweep cannot list.
    for (const path of [join(claude, 'history.jsonl'), join(home, '.claude.json'), ...['backups', 'session-env', 'todos', 'debug', 'paste-cache'].map(name => join(claude, name))]) {
      rmSync(path, { recursive: true, force: true })
    }
    const history = join(claude, 'file-history')
    expect(existsSync(join(history, 'pm-session'))).toBe(true)
    chmodSync(history, 0o000)
    const held = await sweepForSession(home, ours, []).finally(() => chmodSync(history, 0o700))
    expect(held).toBe(SWEEP_LEFT.unlistedFolder)
    expect(held).not.toContain(home)
    // A passing error holds it too, on the projects folder or the home itself: what the folder holds is not known.
    rmSync(history, { recursive: true })
    for (const path of [join(claude, 'projects'), claude]) {
      Object.assign(fail, { path, code: 'EMFILE' })
      expect(await sweepForSession(home, ours, []), path).toBe(SWEEP_LEFT.unlistedFolder)
    }
    // A folder gone since its parent was listed holds nothing, and neither does an engine's home that is not there.
    mkdirSync(join(claude, 'gone'))
    vanish.path = join(claude, 'gone')
    rmSync(join(home, '.codex'), { recursive: true })
    expect(await sweepForSession(home, ours, [])).toBeNull()
  })

  // Security review 1 of 58b035e: an account held by what could not be read named no next step. Each says what to fix, with
  // no path, and that the purge then finishes on its own next try (host.ts endSession retries it).
  it('tells the owner what to fix for each unreadable kind, and that the purge then finishes', () => {
    for (const said of [...(['unreadFolder', 'unreadMemory', 'unreadTranscript'] as const).map(left), OWN_LEFT.unreadTranscript, SWEEP_LEFT.unlistedFolder, SWEEP_LEFT.unreadFile]) {
      expect(said).toMatch(/could not be read: its owner (finds it \([^)]+\) and )?makes it readable for the Team account, and the purge finishes on its next try$/)
    }
    // With no path to name, what holds the account says where to look (re-check of 8c0b019).
    expect(SWEEP_LEFT.unlistedFolder).toContain('search the Team account\'s Claude Code and Codex homes for folders it can\'t read')
    expect(SWEEP_LEFT.unreadFile).toContain('search the Team account\'s Claude Code and Codex homes for files it can\'t read')
  })

  // Security review 2 of #2385, P3: a transcript that records no working folder is no proof it is the session's; it stays,
  // and the sweep refuses it.
  it('keeps a transcript of a shared transcript folder that records no working folder, or both', async () => {
    const { home, shared, folder } = sharedFolder()
    writeFileSync(join(shared, 'own.jsonl'), transcript(folder))
    writeFileSync(join(shared, 'theirs.jsonl'), transcript(OTHER))
    writeFileSync(join(shared, 'none.jsonl'), transcript(null))
    writeFileSync(join(shared, 'mixed.jsonl'), `${transcript(OTHER)}\n${JSON.stringify({ cwd: folder })}`)
    const shares = vi.fn()
    await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }), [], undefined, shares)
    expect(['own.jsonl', 'theirs.jsonl', 'none.jsonl', 'mixed.jsonl'].map(name => existsSync(join(shared, name)))).toEqual([false, true, true, true])
    expect(shares).toHaveBeenCalledTimes(1)
  })

  // Security reviews 1 and 2 of #2385: no transcript proves which memory files of a shared folder are the session's, so none
  // goes. Each file here is one the reviews found deleted or wrongly taken for the session's alone.
  it('keeps every memory file of a shared transcript folder, however either session touched it', async () => {
    const { home, shared, memory, folder } = sharedFolder()
    mkdirSync(join(shared, 'theirs', 'subagents'), { recursive: true })
    const cases = {
      // Review 1, P2: the session wrote it, the other folder's session appended to it with Bash.
      'bash-appended.md': [call(folder, 'Write', { file_path: join(memory, 'bash-appended.md') }), call(OTHER, 'Bash', { command: `echo more >> ${join(memory, 'bash-appended.md')}` })],
      // Review 2, P1: the other folder's subagent wrote it, in a transcript the scrub never reads.
      'by-subagent.md': [call(folder, 'Write', { file_path: join(memory, 'by-subagent.md') }), ''],
      // Review 2, P1: the other wrote it under another spelling, the same file on a Mac.
      'Spelled.md': [call(folder, 'Write', { file_path: join(memory, 'Spelled.md') }), call(OTHER, 'Write', { file_path: join(memory, 'spelled.md') })],
      // Review 2, P1: the session only edited it, so someone else made it; that transcript was pruned.
      'pruned.md': [call(folder, 'Edit', { file_path: join(memory, 'pruned.md') }), ''],
      // Review 1, P1: the session appended to the other's file with Bash, or by another spelling of its path.
      'their-bash.md': [call(folder, 'Bash', { command: `echo plan >> ${join(memory, 'their-bash.md')}` }), call(OTHER, 'Write', { file_path: join(memory, 'their-bash.md') })],
      'their-slashes.md': [call(folder, 'Edit', { file_path: `${memory}//their-slashes.md` }), call(OTHER, 'Write', { file_path: join(memory, 'their-slashes.md') })],
    }
    for (const name of Object.keys(cases)) writeFileSync(join(memory, name), name)
    writeFileSync(join(shared, 'own.jsonl'), transcript(folder, ...Object.values(cases).map(([ours]) => ours)))
    writeFileSync(join(shared, 'theirs.jsonl'), transcript(OTHER, ...Object.values(cases).map(([, theirs]) => theirs).filter(Boolean)))
    writeFileSync(join(shared, 'theirs', 'subagents', 'agent-1.jsonl'), call(OTHER, 'Write', { file_path: join(memory, 'by-subagent.md') }))
    await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }))
    expect(Object.fromEntries(Object.keys(cases).map(name => [name, existsSync(join(memory, name))])))
      .toEqual(Object.fromEntries(Object.keys(cases).map(name => [name, true])))
    expect([existsSync(join(shared, 'own.jsonl')), existsSync(join(shared, 'theirs.jsonl'))]).toEqual([false, true])
  })

  it('tells a Buddy\'s session id from another folder\'s by the working folders its transcript records (host.ts)', async () => {
    const { shared, folder } = sharedFolder()
    writeFileSync(join(shared, 'own.jsonl'), transcript(folder))
    writeFileSync(join(shared, 'theirs.jsonl'), `${transcript(folder)}\n${JSON.stringify({ cwd: OTHER })}`)
    expect([await recordsOtherFolder(join(shared, 'own.jsonl'), folder), await recordsOtherFolder(join(shared, 'theirs.jsonl'), folder)]).toEqual([false, true])
  })

  // Security review 2 of #2375: todos were matched by prefix, so a one-character session id removed every todo starting with it.
  it('removes only its own session\'s todos, never one whose name only starts with its id', async () => {
    const { home, claude } = teamHome()
    writeFileSync(join(claude, 'todos', 'pm-session2-agent-pm-session2.json'), '[]')
    await scrubClaudeSession(home, target())
    expect(existsSync(join(claude, 'todos', 'pm-session-agent-pm-session.json'))).toBe(false)
    expect(existsSync(join(claude, 'todos', 'pm-session2-agent-pm-session2.json'))).toBe(true)
  })

  // Re-check of 8c0b019: a todos or config backups folder that could not be listed was read as empty, and a Buddy's cleanup,
  // which no sweep follows, finished with its todo file and its folder in the backups left. Only one that is not there is
  // empty; any other is told by its kind alone, whatever the error, and what it holds stays.
  it('tells its caller when its todos or config backups folder cannot be listed, by kind, and keeps what is in it', async () => {
    for (const [sub, kind] of [['todos', 'unreadTodos'], ['backups', 'unreadBackups']] as const) {
      for (const code of ['EMFILE', 'EACCES']) {
        const { home, claude } = teamHome(), told = vi.fn()
        Object.assign(fail, { path: join(claude, sub), code })
        await scrubClaudeSession(home, target(), [], undefined, told)
        expect(told.mock.calls, `${sub} ${code}`).toEqual([[kind]])
        expect(existsSync(join(claude, 'todos', 'pm-session-agent-pm-session.json'))).toBe(sub === 'todos')
        expect(readFileSync(join(claude, 'backups', '.claude.json.backup.1793236000000'), 'utf8').includes(`"${CWD}"`)).toBe(sub === 'backups')
        // Listed again, it finishes, and says nothing.
        told.mockClear()
        await scrubClaudeSession(home, target(), [], undefined, told)
        expect(told).not.toHaveBeenCalled()
        expect(await sweepForSession(home, target(), [])).toBeNull()
        rmSync(home, { recursive: true, force: true })
      }
    }
    // One that is not there is empty.
    const { home, claude } = teamHome(), told = vi.fn()
    for (const sub of ['todos', 'backups']) rmSync(join(claude, sub), { recursive: true })
    await scrubClaudeSession(home, target(), [], undefined, told)
    expect(told).not.toHaveBeenCalled()
  })

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
  // Re-check 2 of 68ec6f0: what the sweep found was named by its path, the Team home's and all. It names its kind.
  it('finds the session or folder where Claude Code and Codex write its own data, and nowhere else, by its kind', async () => {
    const { home, claude } = teamHome()
    await scrubClaudeSession(home, target())
    appendFileSync(join(claude, 'history.jsonl'), `${JSON.stringify({ display: 'late', project: CWD, sessionId: 'pm-session' })}\n`)
    expect(await sweepForSession(home, target(), [])).toBe(SWEEP_LEFT.claudeHistory)
    await scrubClaudeSession(home, target())
    writeFileSync(join(claude, 'paste-cache', 'abc123.txt'), 'written again')
    expect(await sweepForSession(home, target(), ['abc123'])).toBe(SWEEP_LEFT.paste)
    writeFileSync(join(claude, 'paste-cache', 'abc123.txt'), '')
    await scrubClaudeSession(home, target(), ['abc123'])
    mkdirSync(join(claude, 'new-feature', 'pm-session'), { recursive: true })
    expect(await sweepForSession(home, target(), ['abc123'])).toBe(SWEEP_LEFT.claudeNamed)
    mkdirSync(join(claude, 'later', SLUG), { recursive: true })
    expect(await sweepForSession(home, target(), [])).toBe(SWEEP_LEFT.claudeNamed)
    writeFileSync(join(home, '.codex', 'history.jsonl'), '{"session_id":"pm-session"}')
    expect(await sweepForSession(home, target({ cwd: null }), [])).toBe(SWEEP_LEFT.codexHistory)
    rmSync(join(home, '.codex', 'history.jsonl'))
    for (const left of ['new-feature', 'later']) rmSync(join(claude, left), { recursive: true })
    mkdirSync(join(home, '.codex', 'sessions', 'pm-session'), { recursive: true })
    expect(await sweepForSession(home, target({ cwd: null }), [])).toBe(SWEEP_LEFT.codexNamed)
    rmSync(join(home, '.codex', 'sessions'), { recursive: true })
    // A history or config that cannot be read holds it, as a folder that cannot be listed does.
    for (const file of [join(claude, 'history.jsonl'), join(home, '.codex', 'history.jsonl'), join(home, '.claude.json')]) {
      writeFileSync(file, '')
      chmodSync(file, 0o000)
      const held = await sweepForSession(home, target(), []).finally(() => chmodSync(file, 0o600))
      expect(held, file).toBe(SWEEP_LEFT.unreadFile)
    }
    Object.assign(fail, { path: join(claude, 'backups'), code: 'EMFILE' })
    expect(await sweepForSession(home, target(), [])).toBe(SWEEP_LEFT.unlistedFolder)
    expect(await sweepForSession(dir(), target(), [])).toBeNull()
  })

  // Follow-up to security review 2 of #2375: a transcript folder another folder's transcripts share outlives the scrub, and
  // the sweep took its name alone for the session's, so the purge never finished and the account stayed held. Security
  // review 1 of #2385: a failure names only the kind of what is left, never another folder's file.
  it('passes a shared transcript folder that holds only other folders\' transcripts, and fails, by kind, on anything else', async () => {
    const { home, shared, memory, folder } = sharedFolder()
    const ours = target({ cwd: folder })
    mkdirSync(join(shared, 'theirs', 'subagents'), { recursive: true })
    writeFileSync(join(shared, 'theirs', 'subagents', 'agent-1.jsonl'), '')
    writeFileSync(join(shared, 'theirs.jsonl'), transcript(OTHER, call(OTHER, 'Write', { file_path: join(memory, 'theirs.md') })))
    expect(await sweepForSession(home, ours, [])).toBeNull()
    // Any memory file, even one only the other folder's transcript names: no transcript proves the session never wrote it.
    writeFileSync(join(memory, 'theirs.md'), 'theirs')
    expect(await sweepForSession(home, ours, [])).toBe(left('memory'))
    mkdirSync(join(memory, 'deep'))
    rmSync(join(memory, 'theirs.md'))
    expect(await sweepForSession(home, ours, [])).toBe(left('memory'))
    rmSync(join(memory, 'deep'), { recursive: true })
    expect(await sweepForSession(home, ours, [])).toBeNull()
    // A transcript folder with no other folder's transcript in it is not said to be shared (re-check 2 of 68ec6f0).
    rmSync(join(shared, 'theirs.jsonl'))
    writeFileSync(join(shared, 'mine.jsonl'), transcript(folder))
    expect(await sweepForSession(home, ours, [])).toBe(OWN_LEFT.transcript)
    chmodSync(join(shared, 'mine.jsonl'), 0o000)
    expect(await sweepForSession(home, ours, []).finally(() => chmodSync(join(shared, 'mine.jsonl'), 0o600))).toBe(OWN_LEFT.unreadTranscript)
    expect(OWN_LEFT.transcript + OWN_LEFT.unreadTranscript + left('unreadFolder') + left('folder')).not.toContain('shares')
    rmSync(join(shared, 'mine.jsonl'))
    writeFileSync(join(shared, 'theirs.jsonl'), transcript(OTHER, call(OTHER, 'Write', { file_path: join(memory, 'theirs.md') })))
    // A transcript of its folder, one of both folders, or one that records none; anything else in the folder.
    for (const [name, text] of [['a.jsonl', transcript(folder)], ['b.jsonl', `${transcript(OTHER)}\n${JSON.stringify({ cwd: `${folder}/src` })}`], ['c.jsonl', transcript(null)]]) {
      writeFileSync(join(shared, name), text)
      expect(await sweepForSession(home, ours, []), name).toBe(left('transcript'))
      rmSync(join(shared, name))
    }
    for (const name of ['notes.txt', 'stray']) {
      if (name === 'stray') mkdirSync(join(shared, name)); else writeFileSync(join(shared, name), '')
      expect(await sweepForSession(home, ours, []), name).toBe(left('other'))
      rmSync(join(shared, name), { recursive: true })
    }
    // A memory folder gone between the listing and its read is no memory folder.
    vanish.path = memory
    expect(await sweepForSession(home, ours, [])).toBeNull()
    expect(existsSync(memory)).toBe(false)
    mkdirSync(memory)
    // A transcript that cannot be read fails it by its kind: the read's own error named its path (review of #2389).
    chmodSync(join(shared, 'theirs.jsonl'), 0o000)
    const unread = await sweepForSession(home, ours, []).finally(() => chmodSync(join(shared, 'theirs.jsonl'), 0o600))
    // Its only other transcript unread, nothing says another folder shares it.
    expect(unread).toBe(OWN_LEFT.unreadTranscript)
    expect(unread).not.toContain(home)
    // A memory folder linked elsewhere is never followed, and fails it.
    rmSync(memory, { recursive: true })
    mkdirSync(join(home, 'elsewhere'))
    symlinkSync(join(home, 'elsewhere'), memory)
    expect(await sweepForSession(home, ours, [])).toBe(left('other'))
    const { unlinkSync } = await import('node:fs')
    unlinkSync(memory)
    // Its session's name inside the folder still fails it, by its kind; so does the folder once no other is left, a file of
    // its name, and one that cannot be read.
    writeFileSync(join(shared, 'theirs', 'pm-session.txt'), '')
    expect(await sweepForSession(home, ours, [])).toBe(SWEEP_LEFT.claudeNamed)
    rmSync(join(shared, 'theirs'), { recursive: true })
    expect(await sweepForSession(home, ours, [])).toBeNull()
    rmSync(join(shared, 'theirs.jsonl'))
    expect(await sweepForSession(home, ours, [])).toBe(left('folder'))
    rmSync(shared, { recursive: true })
    writeFileSync(shared, '')
    expect(await sweepForSession(home, ours, [])).toBe(SWEEP_LEFT.claudeNamed)
    rmSync(shared)
    expect(await sweepForSession(home, ours, [])).toBeNull()
    mkdirSync(shared, { mode: 0o000 })
    expect(await sweepForSession(home, ours, []).finally(() => chmodSync(shared, 0o700))).toBe(left('unreadFolder'))
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
    expect(await sweepForSession(home, target(), [])).toBe(SWEEP_LEFT.config)
    expect(await sweepForSession(home, target({ sessionId: '../x' }), [])).toBe(SWEEP_LEFT.config)
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
    expect(await ended('pm')).toEqual({ error: 'SCRUB_INCOMPLETE', detail: `Something still names the session: ${SWEEP_LEFT.claudeNamed}` })
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

  // Follow-up to security review 2 of #2375: with another folder's transcripts in its transcript folder, the purge never
  // finished. It does once only theirs is left; a memory file there holds the account until its owner removes it (security
  // reviews 1 and 2 of #2385), after a restart too, and a record from before this change is read the same.
  it('finishes when another folder\'s transcripts share its transcript folder, held while a memory file is there', async () => {
    const { home, claude } = teamHome()
    const shared = join(claude, 'projects', SLUG), memory = join(shared, 'memory'), other = '/Users/team/swarm/app./worktrees/pm'
    expect(other.replace(/[^A-Za-z0-9]/g, '-')).toBe(SLUG)
    writeFileSync(join(shared, 'pm-session.jsonl'), transcript(CWD, call(CWD, 'Bash', { command: `echo plan >> ${memory}/theirs.md` })))
    writeFileSync(join(shared, 'theirs.jsonl'), transcript(other, call(other, 'Write', { file_path: join(memory, 'theirs.md') })))
    writeFileSync(join(memory, 'theirs.md'), 'theirs, and a line of the PM\'s')
    const s = service(home)
    const ended = createConfidentialPurge({ confidential: () => true, home, session: s.session, purge: s.purge, record: s.record })
    expect(await ended('pm')).toEqual({ error: 'SCRUB_INCOMPLETE', detail: `Something still names the session: ${left('memory')}` })
    expect(['pm-session.jsonl', 'theirs.jsonl', 'memory/MEMORY.md', 'memory/theirs.md'].map(name => existsSync(join(shared, name)))).toEqual([false, true, true, true])
    const restarted = createConfidentialPurge({ confidential: () => true, home, session: s.session, purge: s.purge, record: purgeRecord(join(home, 'super-tabs', 'team-purges.json')) })
    expect(await restarted('pm')).toMatchObject({ error: 'SCRUB_INCOMPLETE' })
    // A memory folder that cannot be read holds it too, named by its kind: the read's own error carried the folder's path into
    // the daemon's log (security review of #2385).
    chmodSync(memory, 0o000)
    const unread = await restarted('pm').finally(() => chmodSync(memory, 0o700))
    expect(unread).toEqual({ error: 'SCRUB_INCOMPLETE', detail: `Something still names the session: ${left('unreadMemory')}` })
    expect(JSON.stringify(unread)).not.toContain(home)
    expect(purgeRecord(join(home, 'super-tabs', 'team-purges.json')).pending()).toHaveLength(1)
    rmSync(memory, { recursive: true })
    // So does another folder's transcript that cannot be read: kept, never deleted unread, and named by its kind alone.
    chmodSync(join(shared, 'theirs.jsonl'), 0o000)
    const unreadTranscript = await restarted('pm').finally(() => chmodSync(join(shared, 'theirs.jsonl'), 0o600))
    expect(unreadTranscript).toEqual({ error: 'SCRUB_INCOMPLETE', detail: `Something still names the session: ${OWN_LEFT.unreadTranscript}` })
    expect(JSON.stringify(unreadTranscript)).not.toContain(home)
    expect(existsSync(join(shared, 'theirs.jsonl'))).toBe(true)
    expect(purgeRecord(join(home, 'super-tabs', 'team-purges.json')).pending()).toHaveLength(1)
    expect(await restarted('pm')).toEqual({ ok: true })
    expect(existsSync(join(shared, 'theirs.jsonl'))).toBe(true)
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
    expect(sweep).toBe(SWEEP_LEFT.paste)
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
    const refusal = { error: 'PURGE_RECORD_UNREADABLE', detail: UNREADABLE_DETAIL }
    for (const session of [() => null, (id: string) => ({ agentId: id, sessionId: 'pm-session', registeredAt: 5, engine: 'claude', cwd: CWD })]) {
      expect(await createConfidentialPurge({ confidential: () => true, home, session, purge, record })('pm')).toEqual(refusal)
    }
    expect(purge).not.toHaveBeenCalled()
    // Said once, where it was kept.
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([`[super-tabs] the record of purges still to finish could not be read; kept aside at ${file}.unreadable until its owner clears it`])
    warn.mockRestore()
  })

  it('is said once, with the path only, however often its close is refused and retried (review of #2142)', async () => {
    const home = dir(), file = join(home, 'super-tabs', 'team-purges.json')
    mkdirSync(join(home, 'super-tabs'), { recursive: true })
    writeFileSync(file, '{')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const purgeEnded = createConfidentialPurge({ confidential: () => true, home, session: () => null, purge: async () => ({ ok: true }), record: purgeRecord(file) })
    const agents = createSwarmAgents({ byAgent: () => null, stoppedIds: () => [], closeAgent: async () => ({ closed: true }), purgeEnded,
      members: { leads: () => new Set(), harnesses: () => new Set() } } as never)
    // Each refused close fails, so its host retries and the account stays held; the host logs what it was told.
    for (let n = 0; n < 2; n++) expect(await agents.closeMember('pm')).toEqual({ error: 'PURGE_FAILED', detail: UNREADABLE_DETAIL })
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([`[super-tabs] the record of purges still to finish could not be read; kept aside at ${file}.unreadable until its owner clears it`])
    warn.mockRestore()
  })
})

describe('the record of purges still to finish', () => {
  it('keeps them across restarts, and says when it cannot be read, so the account stays held (teamApps.ts)', async () => {
    const file = join(dir(), 'team-purges.json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    warn.mockRestore()
  })

  it('sets a record of the wrong shape aside too, never dropping the purges it may name (security review 2 of #2142)', async () => {
    const { rmSync } = await import('node:fs')
    const file = join(dir(), 'team-purges.json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entry = JSON.stringify(target())
    for (const saved of ['3', 'null', '[]', '{"pm": 3}', `{"other": ${entry}}`, `{"pm": ${entry.replace('"engine":"claude"', '"engine":4')}}`,
      `{"pm": ${entry.replace('"cwd":', '"cwd":7,"was":')}}`, `{"pm": ${entry.replace('}', ',"pastes":[1]}')}}`]) {
      writeFileSync(file, saved)
      expect([purgeRecord(file).unknown(), readFileSync(`${file}.unreadable`, 'utf8')]).toEqual([true, saved])
      rmSync(`${file}.unreadable`)
    }
    // A record as this daemon writes it, older ones without codexHome included, is read as before.
    writeFileSync(file, `{"pm": ${entry.replace(',"codexHome":null', '')}}`)
    expect([purgeRecord(file).get('pm'), purgeRecord(file).unknown()]).toEqual([{ ...target(), codexHome: undefined }, false])
    warn.mockRestore()
  })

  it('names where it was kept on every start while it is there, since the refusal points to the log (security review 2 of #2142)', async () => {
    const { rmSync } = await import('node:fs')
    const file = join(dir(), 'super-tabs', 'team-purges.json')
    mkdirSync(join(file, '..'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const said = (paths: string) => `[super-tabs] the record of purges still to finish could not be read; kept aside at ${paths} until its owner clears it`
    writeFileSync(file, '{')
    purgeRecord(file)
    purgeRecord(file)
    writeFileSync(file, '[')
    purgeRecord(file)
    for (let n = 2; n <= 10; n++) writeFileSync(`${file}.unreadable.${n}`, '{')
    purgeRecord(file)
    // Cleared, it says nothing.
    for (const n of ['', '.1', ...Array.from({ length: 9 }, (_, i) => `.${i + 2}`)]) rmSync(`${file}.unreadable${n}`)
    purgeRecord(file)
    const aside = `${file}.unreadable`
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([said(aside), said(aside), said(`${aside}, ${aside}.1`),
      said([aside, ...Array.from({ length: 10 }, (_, i) => `${aside}.${i + 1}`)].join(', '))])
    warn.mockRestore()
  })
})
