import { buddyTmpFolder, buddyTmpParent } from '../../lib/agentTmp.js'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { recordsOtherFolder, rewriteIfUnchanged, scrubClaudeSession, type PurgeTarget } from './teamPurge.js'

/** A folder whose next listing fails with [code], as the system says it, path and all. */
const fail = vi.hoisted(() => ({ path: '', code: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const readdir = (async (path: Parameters<typeof fs.readdir>[0], ...rest: unknown[]) => {
    if (fail.path && path === fail.path) {
      const code = fail.code
      fail.path = ''
      throw Object.assign(new Error(`${code}: could not list, scandir '${String(path)}'`), { code })
    }
    return (fs.readdir as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof fs.readdir
  return { ...fs, readdir }
})

// A Buddy's Claude Code session its host ended (host.ts endSession): what Claude Code keeps of it in the shared home goes,
// and nothing of another session's.

const dir = () => mkdtempSync(join(tmpdir(), 'team-purge-'))
const CWD = '/Users/team/swarm/app/.worktrees/pm'
const SLUG = CWD.replace(/[^A-Za-z0-9]/g, '-')
const target = (over: Partial<PurgeTarget> = {}): PurgeTarget => ({ agentId: 'pm', sessionId: 'pm-session', cwd: CWD, engine: 'claude', codexHome: null, ...over })

/** A shared Claude Code home as Claude Code 2.1 leaves it: the session's traces among another session's, which names it too. */
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

describe('a Buddy\'s private temporary folder when its session ends', () => {
  // A plain session of the one Buddy chat shares its folder with the main Buddy and closes itself when idle (review of #2563).
  const claudeFiles = (temp: string, folder: string, session: string) =>
    join(temp, `claude-${process.getuid?.() ?? 0}`, realpathSync(folder).replace(/[^A-Za-z0-9]/g, '-'), session)

  it('keeps it while its Buddy folder is there, another session may run in it, and removes only this session\'s output', async () => {
    const home = dir(), folder = join(dir(), 'buddy-one')
    mkdirSync(folder)
    const temp = buddyTmpFolder(folder), SESSION = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222'
    for (const session of [SESSION, OTHER]) { mkdirSync(claudeFiles(temp, folder, session), { recursive: true }); writeFileSync(join(claudeFiles(temp, folder, session), 'output'), 'private') }
    writeFileSync(join(temp, 'a-tool'), 'x')
    await scrubClaudeSession(home, target({ sessionId: SESSION, cwd: folder }))
    expect(existsSync(claudeFiles(temp, folder, SESSION))).toBe(false)
    expect(existsSync(claudeFiles(temp, folder, OTHER))).toBe(true)
    expect(existsSync(join(temp, 'a-tool'))).toBe(true)
    await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }))
    expect(existsSync(temp)).toBe(true)
    rmSync(buddyTmpParent(), { recursive: true, force: true })
  })

  // Windows has no user id: Claude Code's temp folder there is under uid 0's name (agentTmp's own fallback).
  it('finds a session\'s files where the platform has no user id', async () => {
    const home = dir(), folder = join(dir(), 'buddy-no-uid'), SESSION = '11111111-1111-4111-8111-111111111111'
    mkdirSync(folder)
    const files = join(buddyTmpFolder(folder), 'claude-0', realpathSync(folder).replace(/[^A-Za-z0-9]/g, '-'), SESSION)
    mkdirSync(files, { recursive: true })
    const getuid = process.getuid
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true })
    try { await scrubClaudeSession(home, target({ sessionId: SESSION, cwd: folder })) }
    finally { Object.defineProperty(process, 'getuid', { value: getuid, configurable: true, writable: true }) }
    expect(existsSync(files)).toBe(false)
    rmSync(buddyTmpParent(), { recursive: true, force: true })
  })

  it('goes whole once its Buddy folder is gone, and another Buddy\'s stays', async () => {
    const home = dir(), folder = join(dir(), 'buddy-one'), other = join(dir(), 'buddy-two')
    mkdirSync(folder); mkdirSync(other)
    const mine = buddyTmpFolder(folder), theirs = buddyTmpFolder(other)
    for (const at of [mine, theirs]) { mkdirSync(at, { recursive: true }); writeFileSync(join(at, 'output'), 'private') }
    rmSync(folder, { recursive: true })
    await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }))
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(theirs)).toBe(true)
    rmSync(buddyTmpParent(), { recursive: true, force: true })
  })
})

describe('scrubbing a Claude Code session from its shared home', () => {
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
    await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }), shares)
    expect(['own.jsonl', 'own', 'theirs.jsonl', 'theirs', 'memory'].map(name => existsSync(join(shared, name)))).toEqual([false, false, true, true, true])
    expect(shares).toHaveBeenCalledTimes(1)
    // Once only its own are left, the folder goes whole.
    rmSync(join(shared, 'theirs.jsonl'))
    writeFileSync(join(shared, 'again.jsonl'), JSON.stringify({ cwd: folder }))
    await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }), shares)
    expect(existsSync(shared)).toBe(false)
    expect(shares).toHaveBeenCalledTimes(1)
  })

  // Security review 1 of 58b035e: a transcript folder that could not be listed counted as empty and went whole. A permissions
  // error carried its path into the daemon's log, and a passing one (too many open files) deleted other folders' transcripts
  // unread. Only a folder that is not there is empty.
  it('keeps a transcript folder it cannot list, whatever the error, and says it could not read it', async () => {
    const { home, shared, folder } = sharedFolder()
    const theirs = join(shared, 'theirs.jsonl')
    writeFileSync(theirs, JSON.stringify({ cwd: '/Users/me/harnesses/worktrees-old/notes' }))
    const ours = target({ sessionId: null, cwd: folder })
    for (const code of ['EMFILE', 'EACCES', 'EIO']) {
      const told = vi.fn()
      Object.assign(fail, { path: shared, code })
      await scrubClaudeSession(home, ours, told)
      expect(existsSync(theirs), code).toBe(true)
      expect(told.mock.calls, code).toEqual([['unread']])
    }
    // The system's own refusal.
    chmodSync(shared, 0o000)
    try {
      const told = vi.fn()
      await scrubClaudeSession(home, ours, told)
      expect(told.mock.calls).toEqual([['unread']])
    } finally { chmodSync(shared, 0o700) }
    expect(existsSync(theirs)).toBe(true)
  })

  // Review of #2389: a transcript it cannot read may be another folder's: it and its folder stay, and its caller is told, by
  // that word alone (the error's text names its path).
  it('keeps a transcript it cannot read, and its folder, and says it could not read it', async () => {
    const { home, shared, folder } = sharedFolder()
    const own = join(shared, 'own.jsonl'), locked = join(shared, 'locked.jsonl')
    writeFileSync(own, transcript(folder))
    writeFileSync(locked, transcript(folder))
    chmodSync(locked, 0o000)
    const told = vi.fn()
    try { await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }), told) } finally { chmodSync(locked, 0o600) }
    expect(told.mock.calls).toEqual([['unread']])
    expect([existsSync(own), existsSync(locked)]).toEqual([false, true])
  })

  // Security review 2 of #2385, P3: a transcript that records no working folder is no proof it is the session's; it stays.
  it('keeps a transcript of a shared transcript folder that records no working folder, or both', async () => {
    const { home, shared, folder } = sharedFolder()
    writeFileSync(join(shared, 'own.jsonl'), transcript(folder))
    writeFileSync(join(shared, 'theirs.jsonl'), transcript(OTHER))
    writeFileSync(join(shared, 'none.jsonl'), transcript(null))
    writeFileSync(join(shared, 'mixed.jsonl'), `${transcript(OTHER)}\n${JSON.stringify({ cwd: folder })}`)
    const shares = vi.fn()
    await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }), shares)
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

  // Re-check of 8c0b019: a todos or config backups folder that could not be listed was read as empty, and a Buddy's cleanup
  // finished with its todo file and its folder in the backups left. Only one that is not there is
  // empty; any other is told by its kind alone, whatever the error, and what it holds stays.
  it('tells its caller when its todos or config backups folder cannot be listed, by kind, and keeps what is in it', async () => {
    for (const [sub, kind] of [['todos', 'unreadTodos'], ['backups', 'unreadBackups']] as const) {
      for (const code of ['EMFILE', 'EACCES']) {
        const { home, claude } = teamHome(), told = vi.fn()
        Object.assign(fail, { path: join(claude, sub), code })
        await scrubClaudeSession(home, target(), told)
        expect(told.mock.calls, `${sub} ${code}`).toEqual([[kind]])
        expect(existsSync(join(claude, 'todos', 'pm-session-agent-pm-session.json'))).toBe(sub === 'todos')
        expect(readFileSync(join(claude, 'backups', '.claude.json.backup.1793236000000'), 'utf8').includes(`"${CWD}"`)).toBe(sub === 'backups')
        // Listed again, it finishes, and says nothing.
        told.mockClear()
        await scrubClaudeSession(home, target(), told)
        expect(told).not.toHaveBeenCalled()
        expect(existsSync(join(claude, 'todos', 'pm-session-agent-pm-session.json'))).toBe(false)
        expect(readFileSync(join(claude, 'backups', '.claude.json.backup.1793236000000'), 'utf8')).not.toContain(`"${CWD}"`)
        rmSync(home, { recursive: true, force: true })
      }
    }
    // One that is not there is empty.
    const { home, claude } = teamHome(), told = vi.fn()
    for (const sub of ['todos', 'backups']) rmSync(join(claude, sub), { recursive: true })
    await scrubClaudeSession(home, target(), told)
    expect(told).not.toHaveBeenCalled()
  })

  it('removes every file and entry its session or folder names, and keeps every other session\'s', async () => {
    const { home, claude } = teamHome()
    await scrubClaudeSession(home, target())
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
  })

  it('keeps what does not name it, whatever shape, and never takes another session\'s project folder for a missing one', async () => {
    const home = dir(), claude = join(home, '.claude')
    mkdirSync(join(claude, 'projects', '-other'), { recursive: true })
    writeFileSync(join(claude, 'projects', '-other', 'other.jsonl'), 'other')
    writeFileSync(join(claude, 'history.jsonl'), ['not json, other work', 'not json, pm-session', `not json, ${CWD}`,
      JSON.stringify({ sessionId: 'pm-session', pastedContents: { 1: { contentHash: '../keep' }, 2: null } }), ''].join('\n'))
    writeFileSync(join(home, '.claude.json'), '{ not json')
    // A paste name its history line gives that is no file name is never followed out of the paste cache.
    writeFileSync(join(claude, 'keep.txt'), 'kept')
    await scrubClaudeSession(home, target())
    expect(existsSync(join(claude, 'keep.txt'))).toBe(true)
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe('not json, other work\n')
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{ not json')
    await scrubClaudeSession(home, target({ cwd: null }))
    await scrubClaudeSession(home, target({ sessionId: '../x', cwd: '/' }))
    expect(existsSync(join(claude, 'projects', '-other', 'other.jsonl'))).toBe(true)
    // Every line its own: the history is left empty; a home where Claude Code never ran has nothing to scrub.
    writeFileSync(join(claude, 'history.jsonl'), `${JSON.stringify({ sessionId: 'pm-session' })}\n`)
    await scrubClaudeSession(home, target())
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe('')
    const empty = dir()
    await scrubClaudeSession(empty, target())
    expect(existsSync(join(empty, '.claude'))).toBe(false)
  })
})

describe('a Claude Code config with part of it missing', () => {
  it('takes the folder from its repository paths when it has no projects at all', async () => {
    const home = dir(), folder = join(home, 'project-folder')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ githubRepoPaths: { 'acme/app': [folder, '/kept'] } }))
    await scrubClaudeSession(home, target({ sessionId: null, cwd: folder }))
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({ githubRepoPaths: { 'acme/app': ['/kept'] } })
  })
})

describe('Windows, with the projects folder unreadable', () => {
  // A listing that fails names only what the slug says, and the removal reports it unread, never as gone.
  it('tries the one name the folder gives, and says what it could not read', async () => {
    const home = dir(), told: string[] = []
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'projects'), 'not a folder')
    await scrubClaudeSession(home, target({ sessionId: null, cwd: 'C:\\Users\\team\\work' }), what => told.push(what), win32)
    expect(existsSync(join(home, '.claude', 'projects'))).toBe(true)
    expect(told).toEqual(['unread'])
  })
})

describe('a scrub with part of a session unknown', () => {
  it('scrubs by folder alone, by session alone, and leaves a config that is no object', async () => {
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

describe('on Windows', () => {
  const WIN = 'C:\\Users\\team\\swarm\\app\\.worktrees\\pm', KEY = WIN.replaceAll('\\', '/')
  const WSLUG = WIN.replace(/[^A-Za-z0-9]/g, '-')
  /** A folder sharing its name in `projects` ('.' and '\\' both become '-'), and folders that only start like it. */
  const SHARES = 'C:\\Users\\team\\swarm\\app\\-worktrees\\pm', EVIL = `${WIN}-evil`, TWO = `${WIN}2`
  const pm = (over: Partial<PurgeTarget> = {}): PurgeTarget => ({ agentId: 'pm', sessionId: 'pm-session', cwd: WIN, engine: 'claude', codexHome: null, ...over })
  const row = (cwd: string) => `${JSON.stringify({ type: 'user', cwd })}\n`
  function windowsHome() {
    const parent = dir(), home = join(parent, 'home'), claude = join(home, '.claude')
    for (const sub of [`projects/${WSLUG}/memory`, 'projects/C--other', 'backups', 'paste-cache']) mkdirSync(join(claude, sub), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(claude, 'history.jsonl'), [
      JSON.stringify({ display: 'secret', pastedContents: { 1: { contentHash: 'abc123' } }, project: WIN, sessionId: 'pm-session' }),
      JSON.stringify({ display: 'evil work', pastedContents: {}, project: EVIL, sessionId: 'evil' }),
      JSON.stringify({ display: 'two work', pastedContents: {}, project: TWO, sessionId: 'two' }), ''].join('\n'))
    writeFileSync(join(claude, 'paste-cache', 'abc123.txt'), 'pasted')
    writeFileSync(join(claude, 'projects', WSLUG, 'pm-session.jsonl'), row(WIN) + row(`${WIN}\\sub`))
    writeFileSync(join(claude, 'projects', WSLUG, 'memory', 'MEMORY.md'), 'remembered')
    writeFileSync(join(claude, 'projects', 'C--other', 'other.jsonl'), row(EVIL))
    const config = { projects: { [KEY]: { history: ['secret'] }, [WIN]: { history: ['old'] }, [EVIL.replaceAll('\\', '/')]: { keep: 1 }, [TWO]: { keep: 2 } },
      githubRepoPaths: { 'example/app': [WIN, EVIL], 'example/pm': [KEY] } }
    writeFileSync(join(home, '.claude.json'), JSON.stringify(config, null, 2))
    writeFileSync(join(claude, 'backups', '.claude.json.backup.1'), JSON.stringify(config))
    return { parent, home, claude }
  }
  const scrub = (home: string, target: PurgeTarget, told?: (what: string) => void) => scrubClaudeSession(home, target, told, win32)

  it('scrubs the session and only the session, its memory too', async () => {
    const { home, claude } = windowsHome()
    await scrub(home, pm())
    expect(existsSync(join(claude, 'projects', WSLUG))).toBe(false)
    expect(existsSync(join(claude, 'paste-cache', 'abc123.txt'))).toBe(false)
    const history = readFileSync(join(claude, 'history.jsonl'), 'utf8')
    expect(history).not.toContain('pm-session')
    expect(history).toContain('evil work')
    expect(history).toContain('two work')
    for (const file of [join(home, '.claude.json'), join(claude, 'backups', '.claude.json.backup.1')]) {
      const config = JSON.parse(readFileSync(file, 'utf8')) as { projects: Record<string, unknown>; githubRepoPaths: Record<string, string[]> }
      expect(Object.keys(config.projects)).toEqual([EVIL.replaceAll('\\', '/'), TWO])
      expect(config.githubRepoPaths).toEqual({ 'example/app': [EVIL] })
    }
    expect(existsSync(join(claude, 'projects', 'C--other', 'other.jsonl'))).toBe(true)
  })

  // A history line that is no JSON still goes when it names the folder, by either separator and in any case.
  it('drops a history line that is no JSON but names its folder, and keeps one naming another', async () => {
    const { home, claude } = windowsHome()
    const other = `not json ${JSON.stringify('C:\\Users\\team\\other')}`
    writeFileSync(join(claude, 'history.jsonl'), [`not json ${JSON.stringify(KEY.toUpperCase())}`, other, ''].join('\n'))
    await scrub(home, pm({ sessionId: null }))
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe(`${other}\n`)
  })

  it.each([['forward slashes', KEY], ['both separators', 'C:\\Users\\team/swarm\\app/.worktrees\\pm'], ['a lower-case drive', `c${WIN.slice(1)}`],
    ['a trailing separator', `${WIN}\\`]])('finds the same folder written with %s', async (_, cwd) => {
    const { home, claude } = windowsHome()
    await scrub(home, pm({ cwd }))
    expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).not.toContain('pm-session')
    expect(Object.keys((JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as { projects: object }).projects)).toEqual([EVIL.replaceAll('\\', '/'), TWO])
    expect(existsSync(join(claude, 'projects', WSLUG))).toBe(false)
  })

  it.each(['C:\\', 'C:/', 'C:', '\\', '/', 'C:foo', 'foo\\bar', '\\\\server', '\\\\server\\', '\\\\server\\share', '\\\\server\\share\\', 'C:\\a\\..', '/Users/team/pm', '\\Users\\team', ''])(
    'takes no folder from %j: with no session either, nothing is touched', async (cwd) => {
      const { home, claude } = windowsHome()
      // A line that does name it, to show it stays: a form with no drive could be any drive's folder.
      appendFileSync(join(claude, 'history.jsonl'), `${JSON.stringify({ display: 'named', pastedContents: {}, project: cwd, sessionId: 'named' })}\n`)
      const before = readFileSync(join(claude, 'history.jsonl'), 'utf8'), config = readFileSync(join(home, '.claude.json'), 'utf8')
      await scrub(home, pm({ cwd, sessionId: null }))
      expect(readFileSync(join(claude, 'history.jsonl'), 'utf8')).toBe(before)
      expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(config)
      expect(existsSync(join(claude, 'projects', WSLUG))).toBe(true)
    })

  it('reads a transcript in a folder only as inside it past a separator, in any case', async () => {
    const { home } = windowsHome()
    const file = join(home, 't.jsonl')
    for (const [cwd, other] of [[WIN, false], [`${WIN}\\sub`, false], [`${KEY}/sub`, false], [WIN.toUpperCase(), false], [EVIL, true], [TWO, true], [SHARES, true]] as const) {
      writeFileSync(file, row(cwd))
      expect(await recordsOtherFolder(file, WIN, win32)).toBe(other)
    }
  })

  it('keeps another folder\'s transcript that shares the name, its memory too, and says so', async () => {
    const { home, claude } = windowsHome()
    writeFileSync(join(claude, 'projects', WSLUG, 'shared.jsonl'), row(SHARES))
    const told: string[] = []
    await scrub(home, pm(), what => told.push(what))
    expect(told).toEqual(['shared'])
    expect(existsSync(join(claude, 'projects', WSLUG, 'shared.jsonl'))).toBe(true)
    expect(existsSync(join(claude, 'projects', WSLUG, 'pm-session.jsonl'))).toBe(false)
    expect(existsSync(join(claude, 'projects', WSLUG, 'memory', 'MEMORY.md'))).toBe(true)
  })

  it('touches nothing outside the home', async () => {
    const { parent, home, claude } = windowsHome()
    const outside = join(parent, '.claude', 'projects', WSLUG, 'pm-session.jsonl')
    mkdirSync(join(parent, '.claude', 'projects', WSLUG), { recursive: true })
    writeFileSync(outside, 'someone else\'s')
    writeFileSync(join(parent, '.claude.json'), JSON.stringify({ projects: { [KEY]: {} } }))
    await scrub(home, pm())
    expect(existsSync(join(claude, 'projects', WSLUG))).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('someone else\'s')
    expect(readFileSync(join(parent, '.claude.json'), 'utf8')).toContain(KEY)
  })
})
