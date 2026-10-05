/**
 * What the apps see, compared with the released build. A daemon of the released build (`COMPAT_FROM`,
 * its bundled `cli.js`) and one of this checkout's bundle run the same scenario: a Claude Code agent
 * and a Codex agent created, a turn each, a question and a permission answered, search, every request
 * the apps send (well formed and malformed), then the lifecycle: rename, cancel, fork, restart, stop,
 * resume, close. Their replies, and the shape of the frames a turn, a question and a permission push,
 * are compared once ids, times, paths and counters are made comparable.
 *
 * A field this build adds is reported and allowed: the apps ignore what they do not read. Any other
 * difference (a field gone, a value changed, an error instead of an answer) is either listed in CHANGED
 * with why it changed on purpose, or a regression. This is the check behind "a release breaks no app":
 * the desktop app, `hn` and the phone were written against the released daemon's answers.
 *
 * Skipped unless COMPAT_FROM names a released bundle, so CI does not build old releases. Before a
 * release: build the last released tag's bundle (`node build-bundle.mjs` in a checkout of it) and run
 * `COMPAT_FROM=<that>/dist/cli.js npm run test:e2e -- compat`. `COMPAT_REPORT=<file>` writes both
 * sides' answers and every difference, for reading one by one.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

const FROM = process.env.COMPAT_FROM

/**
 * Differences on purpose, by the path that differs (a prefix covers everything under it), each with
 * why. Keep this honest: a difference nobody can explain is a regression until shown otherwise.
 */
const CHANGED: Record<string, string> = {
  // The terminal streams passed `terminal_info` over and nothing answered it, so hn waited out its
  // three seconds each time. It is answered now: what the pane runs and where, or why not.
  'terminal_info claude': 'answered now; the released build left it unanswered',
  'terminal_info codex': 'answered now; the released build left it unanswered',
  'terminal_info with nothing': 'answered now; the released build left it unanswered',
  'terminal_info for no such agent': 'answered now; the released build left it unanswered',
}

type Engine = 'claude' | 'codex'
type Answers = Record<string, unknown>
const ENGINES: Engine[] = ['claude', 'codex']

/** Makes one daemon's answers comparable with another's: its own ids, times, paths and counters. */
function comparable(d: IsolatedDaemon, known: Map<string, string>) {
  const roots = [...new Set([realpathSync(d.root), d.root])].sort((a, b) => b.length - a.length)
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  const VOLATILE = new Set(['pid', 'port', 'tookMs', 'durationMs', 'elapsedMs', 'uptimeMs', 'mtimeMs', 'requestId', 'version', 'cliVersion', 'daemonVersion', 'nonce', 'revision', 'seq', 'offset', 'bytes', 'size'])
  let unknown = 0
  const name = (id: string): string => {
    const lower = id.toLowerCase()
    if (!known.has(lower)) known.set(lower, `<id:${++unknown}>`)
    return known.get(lower)!
  }
  const walk = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if (VOLATILE.has(key)) return '<v>'
      let text = value
      for (const root of roots) text = text.split(root).join('<root>')
      return text.replace(UUID, name).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<iso>')
        // A new agent's default name carries the minute it was made: "Claude harness 10-4 23:09".
        .replace(/\b\d{1,2}-\d{1,2} \d{1,2}:\d{2}\b/g, '<when>')
        // A question's id is a hash of its session and its dialog, so it differs with the session id.
        .replace(/\bq_[0-9a-f]{8}\b/g, '<question>')
        // This machine's network name, which can change between the two runs.
        .replace(/^[\w-]+\.(lan|local|home)$/, '<host>')
    }
    if (typeof value === 'number') {
      if (VOLATILE.has(key)) return '<n>'
      if (value > 1e12 && value < 3e12) return '<ms>'
      if (value > 1.5e9 && value < 3e9) return '<s>'
      return value
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]))
    return value
  }
  return walk
}

/** The frames a turn pushed, as their shape: each type in order (repeats folded), with its payload's keys. */
function shape(frames: Frame[]): string[] {
  const out: string[] = []
  for (const frame of frames) {
    const keys = Object.keys(frame.payload ?? {}).sort().join(',')
    const line = `${frame.type} {${keys}}`
    if (out.at(-1) !== line) out.push(line)
  }
  return out
}

/** Every path where two answers differ, with both values. */
function differences(a: unknown, b: unknown, path = ''): Array<{ path: string; from: unknown; to: unknown }> {
  if (JSON.stringify(a) === JSON.stringify(b)) return []
  const objects = a && b && typeof a === 'object' && typeof b === 'object'
  if (objects && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort()
    return keys.flatMap((key) => differences((a as Answers)[key], (b as Answers)[key], `${path}.${key}`))
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.flatMap((item, i) => differences(item, b[i], `${path}[${i}]`))
  return [{ path, from: a, to: b }]
}

/** The scenario, on one daemon: what it answered, made comparable. */
async function scenario(d: IsolatedDaemon): Promise<Answers> {
  const known = new Map<string, string>()
  const walk = comparable(d, known)
  const answers: Answers = {}
  const client = await LocalClient.connect(d)
  // A request some daemons never answer (`cancel` is fire-and-forget) is recorded as such: that is
  // part of what the apps see too.
  const ask = async (step: string, type: string, payload: Record<string, unknown> = {}, ms = 60_000): Promise<Record<string, any>> => {
    const answer = await client.request(type, payload, ms).catch(() => ({ '<no reply>': true }))
    answers[step] = walk(answer)
    return answer
  }
  const rows = async () => (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
  const agent: Record<Engine, string> = { claude: '', codex: '' }
  const session: Record<Engine, string> = { claude: '', codex: '' }
  const cwd = (engine: Engine) => join(d.projectsDir, `compat-${engine}`)

  for (const engine of ENGINES) {
    mkdirSync(cwd(engine), { recursive: true })
    writeFileSync(join(cwd(engine), 'README.md'), `# compat ${engine}\n`)
    // Asked until the daemon has wired its handlers: a released build answers before it has.
    const created = await until(`a ${engine} agent`, async () => {
      const answer = await client.request('agent_create', { engine, cwd: cwd(engine), bypassPermission: true }, 90_000)
      return answer.error ? null : answer
    }, 60_000, 1_000)
    agent[engine] = created.agent.id
    known.set(agent[engine].toLowerCase(), `<agent:${engine}>`)
    const bound = await until(`${engine} to bind`, async () => {
      const row = (await rows()).find((one) => one.id === agent[engine])
      return row?.sessionId && row.status === 'active' ? row : null
    }, 60_000, 500)
    session[engine] = bound.sessionId
    known.set(session[engine].toLowerCase(), `<session:${engine}>`)
    // How far the launch had got when the reply was built is a race with the engine starting, on either
    // build; what a launch still starting carries (`bypassPermission`) goes with it.
    const { launch: _launch, bypassPermission: _bypass, ...agentRow } = created.agent
    answers[`agent_create ${engine}`] = walk({ ...created, agent: agentRow })
  }

  for (const engine of ENGINES) {
    const from = client.frames.length
    const ended = client.next((frame) => frame.type === 'turn_ended' && frame.agentId === agent[engine], 60_000, `turn_ended (${engine})`)
    client.send('message', { agentId: agent[engine], content: `compat turn on ${engine}` })
    await ended
    await new Promise((done) => setTimeout(done, 1_000))
    answers[`frames of a turn on ${engine}`] = shape(client.frames.slice(from).filter((frame) => frame.agentId === agent[engine] || (frame.payload as Answers | undefined)?.agentId === agent[engine]))
  }

  // A question and a permission, answered as the window answers them: the frames they push, and what
  // the answer gets back (under the question's own request id).
  for (const engine of ENGINES) {
    for (const [step, content, pick] of [['a question', '!ask', 'Coffee'], ['a permission', '!permit printf hi', 0]] as const) {
      const from = client.frames.length
      const asked = client.next((frame) => frame.type === 'commander_question' && frame.agentId === agent[engine], 30_000, `${step} (${engine})`)
      client.send('message', { agentId: agent[engine], content })
      const question = (await asked).payload ?? {}
      const shaped = question.questions?.[0]
      answers[`${step} on ${engine}`] = walk(question)
      const ended = client.next((frame) => frame.type === 'turn_ended' && frame.agentId === agent[engine], 60_000, `turn_ended after ${step}`)
      const replied = client.next((frame) => frame.type === 'question_response_result' && frame.payload?.requestId === question.requestId, 45_000, `${step} answered`)
      client.send('question_response', { requestId: question.requestId, agentId: agent[engine], answers: { [shaped.q]: typeof pick === 'number' ? shaped.options[pick] : pick } })
      answers[`${step} answered on ${engine}`] = walk((await replied).payload)
      await ended
      await new Promise((done) => setTimeout(done, 1_000))
      answers[`frames of ${step} on ${engine}`] = shape(client.frames.slice(from).filter((frame) => frame.agentId === agent[engine] || (frame.payload as Answers | undefined)?.agentId === agent[engine]))
    }
  }

  // What search finds, once it has indexed both conversations.
  for (const engine of ENGINES) {
    await until(`search to find the ${engine} conversation`, async () => {
      const found = await client.request('session_search', { query: `compat turn on ${engine}` }, 30_000)
      return JSON.stringify(found).includes(session[engine]) ? found : null
    }, 60_000, 1_000)
    await ask(`session_search ${engine}`, 'session_search', { query: `compat turn on ${engine}`, limit: 5 })
    await ask(`session_tail ${engine}`, 'session_tail', { sessionId: session[engine], maxChars: 4_000 })
  }
  await ask('session_search for nothing', 'session_search', { query: 'nothing anyone said here' })

  // Every read the apps make, once the rows have settled. Where an agent worked is read from its
  // transcript at most every 15 s (lib/agentTokenUsage.ts REFRESH_MS), on either build: one refresh is
  // let pass after the last turn, and the rows are read until two reads agree.
  await new Promise((done) => setTimeout(done, 16_000))
  await rows()
  await new Promise((done) => setTimeout(done, 2_000))
  let previous = ''
  await until('the agents\' rows to settle', async () => {
    const now = JSON.stringify(walk(await rows()))
    const settled = now === previous
    previous = now
    return settled
  }, 30_000, 1_500)
  await ask('agents_list', 'agents_list')
  await ask('agents_list with stopped', 'agents_list', { includeStopped: true })
  for (const engine of ENGINES) {
    await ask(`sessions_list ${engine}`, 'sessions_list', { agentId: agent[engine] })
    await ask(`session_get ${engine}`, 'session_get', { sessionId: session[engine] })
    await ask(`session_get ${engine}, one turn`, 'session_get', { sessionId: session[engine], limit: 1 })
    await ask(`agent_recent ${engine}`, 'agent_recent', { agentId: agent[engine] })
    await ask(`terminal_info ${engine}`, 'terminal_info', { agentId: agent[engine] })
    await ask(`agent_read_file ${engine}`, 'agent_read_file', { agentId: agent[engine], path: 'README.md' })
  }
  await ask('models_list', 'models_list')
  await ask('git_project_info', 'git_project_info', { path: cwd('claude') })
  await ask('fs_list_dir', 'fs_list_dir', { path: d.projectsDir })
  await ask('project_preview', 'project_preview', { path: cwd('claude') })
  await ask('codex_profiles_list', 'codex_profiles_list')
  await ask('claude_login_status', 'claude_login_status')
  await ask('agents_cleanup_preview', 'agents_cleanup_preview')
  await ask('harness_devices_list', 'harness_devices_list')
  await ask('theme_set', 'theme_set', { background: '#000000', foreground: '#ffffff' })
  await ask('a request nobody answers', 'compat_unknown_request')

  // The same requests, malformed: what each refuses with.
  const malformed = ['session_get', 'sessions_list', 'agent_recent', 'terminal_info', 'agent_read_file', 'agent_update', 'agent_fork',
    'agent_restart', 'agent_delete', 'agent_resume', 'agent_purge', 'agent_retarget', 'agent_close', 'cancel', 'question_response',
    'git_project_info', 'fs_list_dir', 'project_preview', 'session_tail', 'dsh_remove', 'dsh_install', 'dsh_update', 'theme_set']
  for (const type of malformed) {
    const ms = type === 'cancel' ? 5_000 : 60_000
    await ask(`${type} with nothing`, type, {}, ms)
    await ask(`${type} for no such agent`, type, { agentId: 'compat-no-such-agent', sessionId: 'compat-no-such-session', path: '/compat/no/such/path' }, ms)
  }

  // The lifecycle, as the apps drive it.
  await ask('agent_update rename', 'agent_update', { agentId: agent.claude, name: 'Renamed in compat' })
  await ask('cancel while idle', 'cancel', { agentId: agent.claude }, 5_000)
  const forked = await ask('agent_fork', 'agent_fork', { agentId: agent.claude })
  if (typeof forked.agent?.id === 'string') known.set(forked.agent.id.toLowerCase(), '<agent:fork>')
  await ask('agent_restart', 'agent_restart', { agentId: agent.codex })
  await until('codex to be back after its restart', async () => {
    const row = (await rows()).find((one) => one.id === agent.codex)
    return row?.sessionId && row.status === 'active' ? row : null
  }, 60_000, 500)
  await ask('agent_delete (stop)', 'agent_delete', { agentId: agent.codex })
  await ask('agents_list after a stop', 'agents_list', { includeStopped: true })
  await ask('agent_resume', 'agent_resume', { agentId: agent.codex })
  await until('codex to be back after its resume', async () => {
    const row = (await rows()).find((one) => one.id === agent.codex)
    return row?.sessionId && row.status === 'active' ? row : null
  }, 60_000, 500)
  const closing = (await rows()).find((one) => one.id === agent.claude)
  await ask('agent_close', 'agent_close', { agentId: agent.claude, sessionId: closing?.sessionId, createdAt: closing?.createdAt, mode: 'now' })
  await ask('agents_list at the end', 'agents_list', { includeStopped: true })
  client.close()
  return answers
}

describe.skipIf(!FROM)('what the apps see, compared with the released build', () => {
  let scratch = ''
  const sides: Partial<Record<'released' | 'this', { version: string; answers: Answers }>> = {}

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'harnessd-compat-'))
    // This checkout as it ships: its bundle, under harnessd's master.
    const build = join(scratch, 'this')
    execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: build }, stdio: 'pipe' })
    // The released build as it runs: its bundle, its core on its own (it has no master).
    const released = join(scratch, 'released')
    mkdirSync(released)
    copyFileSync(FROM!, join(released, 'cli.js'))
    copyFileSync(join(dirname(FROM!), 'notify.mjs'), join(released, 'notify.mjs'))
    for (const dir of [build, released]) writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')

    for (const [side, options] of [
      ['released', { scriptPath: join(released, 'cli.js'), noMaster: true, env: { ADAPTER_CLI_DIR: released } }],
      ['this', { scriptPath: join(build, 'cli.js'), env: { ADAPTER_CLI_DIR: build } }],
    ] as const) {
      const d = await IsolatedDaemon.create(options)
      try {
        await d.start({ ready: 'port' })
        const version = execFileSync(process.execPath, [options.scriptPath, 'version'], { encoding: 'utf8' }).trim()
        sides[side] = { version, answers: await scenario(d) }
      } catch (error) {
        console.error(`---- ${side} daemon log\n${d.log().split('\n').slice(-120).join('\n')}`)
        throw error
      } finally {
        await d.close()
      }
    }
  }, 900_000)

  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

  it('answers every request the way the released build did, but for the changes made on purpose', () => {
    const released = sides.released!
    const current = sides.this!
    const found = differences(released.answers, current.answers)
    // Paths read `.<step>.<field>…`; a CHANGED entry names a step, or a path under one.
    const explained = (path: string) => Object.keys(CHANGED).find((prefix) => {
      const step = `.${prefix}`
      return path === step || path.startsWith(`${step}.`) || path.startsWith(`${step}[`)
    })
    const added = found.filter((difference) => difference.from === undefined)
    const unexplained = found.filter((difference) => difference.from !== undefined && !explained(difference.path))
    if (process.env.COMPAT_REPORT) {
      writeFileSync(process.env.COMPAT_REPORT, JSON.stringify({
        released: released.version, this: current.version, unexplained, added,
        explained: found.filter((difference) => difference.from !== undefined && explained(difference.path)),
        answers: { released: released.answers, this: current.answers },
      }, null, 2))
    }
    expect(unexplained, `${unexplained.length} differences from ${released.version}; see COMPAT_REPORT`).toEqual([])
    // An explanation nothing needs any more is removed.
    for (const prefix of Object.keys(CHANGED)) expect(found.some((difference) => explained(difference.path) === prefix), `${prefix} no longer differs`).toBe(true)
  })
})
