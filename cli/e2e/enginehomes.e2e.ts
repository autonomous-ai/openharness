/**
 * The person's engines keeping their data somewhere of their own, for Claude Code and Codex.
 * `CLAUDE_CONFIG_DIR` moves Claude Code's settings (and with them its hooks), transcripts and process
 * records; `CODEX_HOME` moves Codex's hooks and rollouts. People set them in their shell profile to keep
 * a work and a personal account apart, and the daemon launches every engine through that shell, so the
 * engine takes them whatever the daemon's own environment says: the desktop app starts the daemon
 * without the profile. An agent must still bind, take turns and come back after a restart.
 */
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { assertHooksContained, CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { sharedCodex } from './harness/sharedCodex.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function type(d: IsolatedDaemon, pane: string, text: string): Promise<void> {
  await d.tmux.run('send-keys', '-t', pane, '-l', text)
  await d.tmux.run('send-keys', '-t', pane, 'Enter')
}
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}

/** The one conversation file an engine wrote in a moved home: Claude Code's transcript, Codex's rollout. */
function conversationIn(engine: Engine, home: string): string | null {
  const walk = (dir: string): string[] => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    return entries.flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.jsonl') ? [entry.name] : [])
  }
  const files = walk(join(home, engine === 'claude' ? 'projects' : 'sessions'))
  if (files.length !== 1) return null
  return engine === 'claude' ? files[0].replace(/\.jsonl$/, '') : /-([0-9a-f-]{36})\.jsonl$/.exec(files[0])?.[1] ?? null
}
/** The command lines of the fake Codex processes running a conversation, as the process table shows them. */
const codexCommands = (sessionId: string): string[] =>
  execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).split('\n')
    .filter((line) => /^codex\s/.test(line.trim()) && line.includes(sessionId))

it.each(['legacy', 'journal', 'unconfirmed'] as const)('refuses an uncontained %s home before starting any daemon', source => {
  const root = mkdtempSync(join(tmpdir(), 'home-containment-'))
  try {
    const env = { HOME: root, CODEX_HOME: join(root, 'codex'), ZDOTDIR: root, ADAPTER_DATA_DIR: root, HOOK_INSTALL_ENGINES: 'codex' }
    const file = join(root, 'engine-homes.json'), homes = { claude: [], codex: ['/fixture-unowned-home'] }
    if (source === 'legacy') writeFileSync(file, JSON.stringify(homes), { mode: 0o600 })
    else {
      mkdirSync(file + '.adoptions', { mode: 0o700 }); mkdirSync(file + '.confirmations', { mode: 0o700 })
      const record = JSON.stringify({ version: 1, previous: null, legacyRequired: false, homes }) + '\n'
      writeFileSync(join(file + '.adoptions', '000.json'), record, { mode: 0o600 })
      if (source === 'journal') writeFileSync(file + '.adopted', createHash('sha256').update(record).digest('hex') + '\n', { mode: 0o600 })
    }
    expect(() => assertHooksContained(root, env)).toThrow(source === 'unconfirmed' ? 'unconfirmed adoption' : 'installs hooks only inside')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

describe('the person\'s engines keeping their data elsewhere', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('keeps readiness and a terminal available while a moved-home write is held, then retries and restores it', async () => {
    const d = await IsolatedDaemon.create(); daemon = d
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`))
    const home = join(d.root, 'codex-durable'), fault = join(d.root, 'adoption-unavailable')
    mkdirSync(home, { mode: 0o700 })
    writeFileSync(fault, 'hold', { mode: 0o600 })
    d.env.HARNESS_HOME_ADOPTION_FAULT_FILE = fault
    d.env.NODE_OPTIONS = `--import=${pathToFileURL(join(CLI_ROOT, 'e2e/harness/homeAdoptionFault.mjs')).href}`
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export CODEX_HOME=${JSON.stringify(home)}\n`)
    await d.start()
    let client = await LocalClient.connect(d)
    await until('the explicit durable adoption hold', () => d.log().includes('[hooks] home adoption held'))
    expect(existsSync(join(home, 'hooks.json'))).toBe(false)
    const terminal = await client.request('agent_create', { engine: 'terminal', cwd: d.projectsDir }, 60_000)
    expect(terminal.error, JSON.stringify(terminal)).toBeUndefined()
    expect((await row(client, terminal.agent.id))?.status).toBe('active')
    renameSync(fault, fault + '.recovered')
    await until('the pending home to receive hooks after durability recovers', () => existsSync(join(home, 'hooks.json')), 30_000)
    await until('the adoption recovery acknowledgement', () => d.log().includes('[hooks] home adoption recovered'), 30_000)
    const created = await client.request('agent_create', { engine: 'codex', cwd: d.projectsDir, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const bound = await until('the recovered home to bind', async () => {
      const value = await row(client, created.agent.id); return value?.sessionId ? value : null
    }, 45_000)
    await turn(client, bound.id, 'durable adoption recovered')
    client.close(); await d.stop()
    // The new boot must discover the saved home even after the login shell stops naming it.
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), '')
    await d.start(); client = await LocalClient.connect(d)
    const restored = await until('the durable home after restart without its shell variable', async () => {
      const value = await row(client, bound.id); return value?.sessionId === bound.sessionId ? value : null
    }, 45_000)
    expect(restored.transcriptPath).toBe(bound.transcriptPath)
    await turn(client, bound.id, 'the saved home survived restart')
    client.close()
  }, 240_000)

  it.each(['claude', 'codex'] as const)('%s model picker follows the login shell home', async engine => {
    const d = await IsolatedDaemon.create(); daemon = d
    d.env.NODE_OPTIONS = `--import=${pathToFileURL(join(CLI_ROOT, 'e2e/harness/hiddenProcessEnv.mjs')).href}`
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`))
    const home = join(d.root, `${engine}-models`)
    mkdirSync(home)
    const variable = engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export ${variable}=${JSON.stringify(home)}\n`)
    if (engine === 'claude') {
      writeFileSync(join(d.engineConfig.claudeProjectsDir, '..', 'settings.json'), JSON.stringify({ availableModels: ['haiku'] }))
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ availableModels: ['sonnet'] }))
    } else {
      const cache = (slug: string) => JSON.stringify({ models: [{ slug, display_name: slug, visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] }] })
      writeFileSync(join(d.env.CODEX_HOME!, 'models_cache.json'), cache('wrong-login-model'))
      writeFileSync(join(home, 'models_cache.json'), cache('gpt-6-luna'))
    }
    await d.start()
    await until('the core to read the login shell', () => /\[env\] read \d+ variables/.test(d.log()))
    const client = await LocalClient.connect(d)
    const created = await client.request('agent_create', { engine, cwd: d.projectsDir, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('the model-picker agent to bind', async () => {
      const now = await row(client, created.agent.id); return now?.sessionId ? now : null
    }, 30_000)
    if (engine === 'codex') expect(agent.codexHome).toBeNull()
    const answer = await client.request('models_list', { agentId: agent.id }, 30_000)
    expect(answer.error, JSON.stringify(answer)).toBeUndefined()
    const ids = answer.models.map((model: Row) => model.id)
    expect(ids).toContain(`runtime-v1:${agent.id}:${engine}:${engine === 'claude' ? 'sonnet' : 'gpt-6-luna'}@auto`)
    expect(ids.some((id: string) => id.includes(engine === 'claude' ? ':haiku@' : ':wrong-login-model@'))).toBe(false)
    client.close()
  })

  it.each(['activity', 'resources', 'close'] as const)('a moved shared Codex server supplies %s when process environment discovery is unavailable', async operation => {
    const d = await IsolatedDaemon.create(); daemon = d
    d.env.NODE_OPTIONS = `--import=${pathToFileURL(join(CLI_ROOT, 'e2e/harness/hiddenProcessEnv.mjs')).href}`
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`))
    const home = join(d.root, 'codex-shared')
    mkdirSync(home)
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export CODEX_HOME=${JSON.stringify(home)}\n`)
    // Older Codex releases have a shared server and no --no-daemon flag. Keep the actual CLI probe.
    writeFileSync(join(d.root, 'bin', 'codex'), `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(join(CLI_ROOT, 'e2e/harness/fakeEngine.mjs')).href)}).then(m => m.run('codex', ${JSON.stringify({ ...d.engineConfig, without: ['--no-daemon'] })}))\n`, { mode: 0o755 })
    const server = await sharedCodex(home)
    try {
      await d.start()
      await until('the core to read the login shell', () => /\[env\] read \d+ variables/.test(d.log()))
      const client = await LocalClient.connect(d)
      const created = await client.request('agent_create', { engine: 'codex', cwd: d.projectsDir, bypassPermission: true }, 90_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      const agent = await until('the shared conversation to bind', async () => {
        const now = await row(client, created.agent.id); return now?.sessionId ? now : null
      }, 30_000)
      expect(agent.codexHome).toBeNull()
      server.state.threadId = agent.sessionId
      const started = client.next(isTurn('turn_started', agent.id), 30_000)
      client.send('message', { agentId: agent.id, content: '!hold' })
      await started
      if (operation === 'activity') {
        await until('the activity read at the moved server', () => server.state.requests.some(frame => frame.method === 'thread/read'), 45_000)
        await until('the app to show verified working activity', async () => (await row(client, agent.id))?.activity?.state === 'working')
      } else if (operation === 'resources') {
        await until('the moved server in Harness Monitor', async () => {
          const answer = await client.request('machine_resources', { harnesses: true })
          expect(answer.harnesses?.shared, JSON.stringify(answer)).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'codex', agentIds: expect.arrayContaining([agent.id]), memoryBytes: expect.any(Number) }),
          ]))
          return answer.harnesses.shared.some((value: Row) => value.kind === 'codex' && value.agentIds.includes(agent.id) && value.memoryBytes > 0)
        }, 20_000)
      } else {
        const result = await client.request('agent_close', { agentId: agent.id, sessionId: agent.sessionId, createdAt: agent.createdAt, mode: 'now' }, 90_000)
        expect(result.error, JSON.stringify(result)).toBeUndefined()
        expect(server.state.requests.map(frame => frame.method)).toEqual(expect.arrayContaining(['thread/goal/set', 'turn/interrupt', 'thread/archive', 'thread/unarchive']))
        expect(server.state.loaded).toBe(false)
      }
      client.close()
    } finally { await server.close() }
  })

  it('a moved Codex home supplies the thread name shown on its agent', async () => {
    const d = await IsolatedDaemon.create(); daemon = d
    d.env.NODE_OPTIONS = `--import=${pathToFileURL(join(CLI_ROOT, 'e2e/harness/hiddenProcessEnv.mjs')).href}`
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`))
    const home = join(d.root, 'codex-names')
    mkdirSync(home)
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export CODEX_HOME=${JSON.stringify(home)}\n`)
    await d.start()
    await until('the daemon to read the login shell', () => /\[env\] read \d+ variables/.test(d.log()))
    const client = await LocalClient.connect(d)
    const created = await client.request('agent_create', { engine: 'codex', cwd: d.projectsDir, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('the named agent to bind', async () => {
      const now = await row(client, created.agent.id); return now?.sessionId ? now : null
    }, 30_000)
    // Codex can rename a thread from another client; the index changes without this pane's title changing.
    for (const [folder, thread_name] of [[d.env.CODEX_HOME!, 'Wrong login name'], [home, 'Moved home conversation']]) {
      writeFileSync(join(folder, 'session_index.jsonl'), JSON.stringify({ id: agent.sessionId, thread_name }) + '\n')
    }
    expect(agent.codexHome).toBeNull()
    await until('the moved-home name on the agent', async () => (await row(client, agent.id))?.name === 'Moved home conversation', 20_000)
    client.close()
  })

  it('a moved Codex home repairs a parent overwritten by its child when the daemon restarts', async () => {
    const d = await IsolatedDaemon.create(); daemon = d
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`))
    const home = join(d.root, 'codex-parent')
    mkdirSync(home)
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export CODEX_HOME=${JSON.stringify(home)}\n`)
    await d.start()
    const client = await LocalClient.connect(d)
    const created = await client.request('agent_create', { engine: 'codex', cwd: d.projectsDir, bypassPermission: true }, 90_000)
    const agent = await until('the parent to bind', async () => {
      const now = await row(client, created.agent.id); return now?.sessionId ? now : null
    }, 30_000)
    await turn(client, agent.id, '!spawn scout')
    client.close()
    await d.stop()
    const registryFile = join(d.dataDir, 'registry.json')
    const saved = JSON.parse(readFileSync(registryFile, 'utf8')) as Row[]
    const parent = saved.find(record => record.sessionId === agent.sessionId)!
    const parentPath = parent.transcriptPath
    const folder = join(home, 'sessions', '2026', '10', '03')
    const child = readdirSync(folder).find(file => file.endsWith('.jsonl') && !file.includes(agent.sessionId))!
    // Reproduce the on-disk damage an older hook left; current hooks already reject child bindings.
    parent.transcriptPath = join(folder, child)
    parent.codexHome = null // A legacy row from before successful process-environment discovery.
    writeFileSync(registryFile, JSON.stringify(saved), { mode: 0o600 })
    await d.start()
    expect(d.log()).toContain(`[registry] repaired Codex parent ${agent.sessionId.slice(0, 8)}`)
    const repaired = (JSON.parse(readFileSync(registryFile, 'utf8')) as Row[]).find(record => record.sessionId === agent.sessionId)
    expect(repaired?.transcriptPath).toBe(parentPath)
    const again = await LocalClient.connect(d)
    await turn(again, agent.id, 'the parent keeps its own conversation')
    again.close()
  })

  it.each([false, true])('retains a saved binding with an incomplete header while readiness and a sibling work, then recovers in place: inline=%s', async inline => {
    const d = await IsolatedDaemon.create(inline ? { env: { HARNESSD_SERVICES: 'none' } } : {}); daemon = d
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`))
    await d.start()
    let client = await LocalClient.connect(d)
    const agents: Row[] = []
    for (const engine of ['codex', 'claude']) {
      const created = await client.request('agent_create', { engine, cwd: d.projectsDir, bypassPermission: true }, 90_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      agents.push(await until('the private conversation to bind', async () => {
        const value = await row(client, created.agent.id); return value?.sessionId ? value : null
      }, 45_000))
    }
    const [bound, sibling] = agents
    await turn(client, bound!.id, 'before the incomplete header')
    client.close(); await d.stop()
    const original = (JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Row[])
      .find(value => value.agentId === bound!.id)!
    const file = original.transcriptPath as string
    expect(file.startsWith(d.root + '/')).toBe(true)
    const complete = readFileSync(file)
    writeFileSync(file, complete.subarray(0, 12))
    await d.start(); client = await LocalClient.connect(d)
    const held = await until('the saved conversation to expose its hold', async () => {
      const value = await row(client, bound!.id); return value?.identityHold ? value : null
    }, 45_000)
    expect(held).toMatchObject({ sessionId: bound!.sessionId, status: 'active' })
    // A mistakenly installed tail would parse this valid turn record despite its invalid header.
    // Only this fixture's file is written; no synthetic input goes to the held pane.
    appendFileSync(file, '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'unconfirmed held record' } }) + '\n')
    await turn(client, sibling!.id, 'a sibling works during the hold')
    expect(client.frames.filter(frame => frame.agentId === bound!.id && ['turn_started', 'turn_ended'].includes(frame.type))).toEqual([])
    const cancelled = client.next(isTurn('agent_activity', bound!.id), 15_000, 'held cancellation acknowledged by core')
    client.send('cancel', { agentId: bound!.id })
    await cancelled
    const saved = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Row[]
    expect(saved.find(value => value.agentId === bound!.id)).toMatchObject({ sessionId: bound!.sessionId, transcriptPath: file })
    writeFileSync(file, complete)
    await expect.poll(async () => (await row(client, bound!.id))?.identityHold, { timeout: 45_000, interval: 200 })
      .toEqual(expect.stringMatching(/^Waiting for transcript interpretation:/))
    const recovery = await row(client, bound!.id)
    expect(recovery?.identityHold).toEqual(expect.stringMatching(/control boundary|replaced or truncated|boundary is an incomplete record/))
    const confirmed = client.next(isTurn('agent_activity', bound!.id), 15_000, 'current cancellation acknowledged by core')
    client.send('cancel', { agentId: bound!.id })
    await confirmed
    await until('the same live binding to recover without another restart', async () => {
      const value = await row(client, bound!.id)
      return value?.sessionId === bound!.sessionId && !value.identityHold ? value : null
    }, 45_000)
    await turn(client, bound!.id, 'after the header recovered')
    expect(d.coresStarted()).toBe(2)
    client.close()
  }, 240_000)

  it.each(['claude', 'codex'] as const)('search finds external %s conversations in the moved home after startup', async engine => {
    const d = await IsolatedDaemon.create(); daemon = d
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`))
    const home = join(d.root, `${engine}-search`)
    mkdirSync(home)
    const variable = engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export ${variable}=${JSON.stringify(home)}\n`)
    await d.start()
    await until('the core to adopt the moved home', () => /\[env\] read \d+ variables/.test(d.log()))
    const sessionId = '11111111-1111-4111-8111-111111111111', at = new Date().toISOString()
    const folder = join(home, engine === 'claude' ? 'projects/project' : 'sessions/2026/10/06')
    mkdirSync(folder, { recursive: true })
    // Native records from a separate terminal, never registered as a Harness agent.
    const records = engine === 'claude' ? [{ type: 'user', entrypoint: 'cli', sessionId, cwd: d.projectsDir,
      timestamp: at, uuid: 'question', message: { role: 'user', content: 'movedhomepangolin' } }] : [
      { type: 'session_meta', timestamp: at, payload: { id: sessionId, cwd: d.projectsDir, source: 'cli' } },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: 'external-turn' } },
      { type: 'event_msg', timestamp: at, payload: { type: 'item_completed', turn_id: 'external-turn', item: { type: 'UserMessage', content: [{ type: 'text', text: 'movedhomepangolin' }] } } },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_complete', turn_id: 'external-turn' } },
    ]
    writeFileSync(join(folder, engine === 'claude' ? `${sessionId}.jsonl` : `rollout-${sessionId}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n')
    const client = await LocalClient.connect(d)
    await until('the search process to connect', () => d.log().includes('[service search] connected to the core'))
    expect(await client.request('session_search', { query: 'movedhomepangolin' })).not.toHaveProperty('error')
    await until('search to return the external moved-home conversation', async () => {
      const answer = await client.request('session_search', { query: 'movedhomepangolin' }, 30_000)
      expect(answer.error, JSON.stringify(answer)).toBeUndefined()
      return JSON.stringify(answer).includes(sessionId)
    }, 45_000, 1000)
    expect(await rows(client)).toEqual([])
    client.close()
  })

  it.each([
    ['claude', 'CLAUDE_CONFIG_DIR', 'claude-work'],
    ['codex', 'CODEX_HOME', 'codex-work'],
  ] as const)('%s with %s set in the person\'s shell profile: an agent binds, works and comes back after a restart', async (engine: Engine, variable, folder) => {
    // The daemon installs its hooks, as it does on a person's machine: Claude Code's and Codex's alone,
    // into this test's throwaway home, the moved one included.
    const d = await IsolatedDaemon.create({ env: { DISABLE_HOOK_INSTALL: 'false', HOOK_INSTALL_ENGINES: 'claude,codex' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const home = join(d.root, folder)
    mkdirSync(home, { recursive: true })
    // The profile every shell the daemon starts reads; the daemon itself never sees this variable.
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export ${variable}=${JSON.stringify(home)}\n`)
    await d.start()
    let client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, `homes-${engine}`)
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until(`the ${engine} agent to bind with its data in ${folder}`, async () => {
      const now = await row(client, created.agent.id)
      return now?.sessionId && now.status === 'active' ? now : null
    }, 60_000, 500)
    await turn(client, agent.id, `with ${variable} set`)
    client.close()

    await d.restart()
    client = await LocalClient.connect(d)
    await until(`the ${engine} agent back after the restart`, async () => {
      const now = await row(client, agent.id)
      return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
    }, 60_000, 500)
    await turn(client, agent.id, `after the restart, with ${variable} set`)
    client.close()
  }, 300_000)

  // A conversation in a moved home, resumed by hand in a terminal tile (`claude --resume <id>`, `codex
  // resume <id>`). Discovery reads the id off the engine's command line and binds it once it finds the
  // conversation's file; with no hook to say so (only the other engine's hooks are installed here), that
  // is all there is. The file was looked for in the default folders alone, and the tile never bound.
  it.each([
    ['claude', 'CLAUDE_CONFIG_DIR', 'codex'],
    ['codex', 'CODEX_HOME', 'claude'],
  ] as const)('%s with %s: a resume typed into a terminal binds the conversation kept in the moved home', async (engine: Engine, variable, hooked) => {
    const d = await IsolatedDaemon.create({ env: { HOOK_INSTALL_ENGINES: hooked } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const home = join(d.root, `${engine}-work`)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export ${variable}=${JSON.stringify(home)}\n`)
    const cwd = join(d.projectsDir, `typed-resume-${engine}`)
    mkdirSync(cwd, { recursive: true })
    // The conversation as the engine left it in the moved home, where the engine resumes it from.
    const sessionId = engine === 'claude' ? 'c1a0de00-0000-4000-8000-000000000001' : '019a0c0d-0000-7000-8000-000000000001'
    const at = new Date().toISOString()
    if (engine === 'claude') {
      const dir = join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId,
        version: '2.1.270', timestamp: at, uuid: 'b0b0b0b0-0000-4000-8000-000000000001', type: 'user', message: { role: 'user', content: 'from before' } })}\n`)
    } else {
      const dir = join(home, 'sessions', '2026', '10', '03')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `rollout-2026-10-03T00-00-00-${sessionId}.jsonl`),
        `${JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: sessionId, cli_version: '0.159.0', cwd, source: 'cli' } })}\n`)
    }
    await d.start()
    // The daemon learns a moved home from the login shell, which it reads once it is up.
    await until('the daemon to read the login shell', () => /\[env\] read \d+ variables from the login shell/.test(d.log()), 30_000)
    const client = await LocalClient.connect(d)
    const opened = await client.request('agent_create', { engine: 'terminal', cwd }, 60_000)
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    const tile = await until('the terminal tile to be up', async () => {
      const now = await row(client, opened.agent.id)
      return now?.status === 'active' && now.tmuxPane ? now : null
    }, 60_000, 250)
    await type(d, tile.tmuxPane, engine === 'claude' ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`)
    const back = await until(`the tile to bind the ${engine} conversation kept in ${variable}`, async () => {
      const now = await row(client, tile.id)
      return now?.engine === engine && now.sessionId === sessionId ? now : null
    }, 45_000, 500)
    expect(back.status).toBe('active')
    client.close()
  }, 300_000)

  // A conversation started by hand in a terminal tile (`claude`, `codex`), with no hook to name it: only the
  // other engine's hooks are installed here, as for a person whose moved home has none of the daemon's yet.
  // The process repair binds it from what the engine leaves for that in the home it writes in: Claude Code's
  // process record (`<home>/sessions/<pid>.json`), the rollout Codex holds open. It looked in the default
  // folders alone (sessionRepair.ts `processSessionOf`, `findLiveSession`), and the tile never bound.
  it.each([
    ['claude', 'CLAUDE_CONFIG_DIR', 'codex'],
    ['codex', 'CODEX_HOME', 'claude'],
  ] as const)('%s with %s: a conversation started by hand in a terminal binds, with no hook to name it', async (engine: Engine, variable, hooked) => {
    const d = await IsolatedDaemon.create({ env: { HOOK_INSTALL_ENGINES: hooked } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const home = join(d.root, `${engine}-work`)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export ${variable}=${JSON.stringify(home)}\n`)
    const cwd = join(d.projectsDir, `typed-new-${engine}`)
    mkdirSync(cwd, { recursive: true })
    await d.start()
    await until('the daemon to read the login shell', () => /\[env\] read \d+ variables from the login shell/.test(d.log()), 30_000)
    const client = await LocalClient.connect(d)
    const opened = await client.request('agent_create', { engine: 'terminal', cwd }, 60_000)
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    const tile = await until('the terminal tile to be up', async () => {
      const now = await row(client, opened.agent.id)
      return now?.status === 'active' && now.tmuxPane ? now : null
    }, 60_000, 250)
    await type(d, tile.tmuxPane, engine)
    const sessionId = await until(`the ${engine} conversation to be written in ${variable}`, async () => conversationIn(engine, home), 30_000, 250)
    const back = await until(`the tile to bind the ${engine} conversation it started in ${variable}`, async () => {
      const now = await row(client, tile.id)
      return now?.engine === engine && now.sessionId ? now : null
    }, 45_000, 500)
    expect(back.sessionId).toBe(sessionId)
    expect(back.status).toBe('active')
    client.close()
  }, 300_000)

  it.each(['process record', 'home catalog'] as const)('an incomplete %s holds binding, Stop and Close while readiness and a sibling continue', async fault => {
    const d = await IsolatedDaemon.create({ env: { HOOK_INSTALL_ENGINES: 'codex' } }); daemon = d
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`))
    await d.start()
    let client = await LocalClient.connect(d)
    const opened = await client.request('agent_create', { engine: 'terminal', cwd: d.projectsDir }, 60_000)
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    const tile = await until('the private terminal tile', async () => {
      const now = await row(client, opened.agent.id); return now?.tmuxPane ? now : null
    })
    client.close()
    await d.stop()
    // Start only in this fixture's private pane while discovery is stopped. No hook can
    // bind before the engine's own record is made incomplete, as during a crashed write.
    await type(d, tile.tmuxPane, 'claude')
    const records = join(d.engineConfig.claudeProjectsDir, '..', 'sessions')
    const path = await until('the private engine process record', () => {
      try { const files = readdirSync(records); return files.length === 1 ? join(records, files[0]) : null }
      catch { return null }
    })
    const nativeBytes = readFileSync(path, 'utf8')
    const native = JSON.parse(nativeBytes)
    const faultFile = fault === 'process record' ? path : join(d.dataDir, 'engine-homes.json')
    const complete = fault === 'process record' ? nativeBytes : JSON.stringify({ claude: [], codex: [] })
    const reason = fault === 'process record' ? 'the process record is incomplete' : 'the saved engine-home catalog is incomplete'
    writeFileSync(faultFile, '{', { mode: 0o600 })
    await d.start()
    client = await LocalClient.connect(d)
    await until('the binding hold with its reason', () => d.log().includes(`binding held · Conversation identity is held: ${reason}`))
    const held = await row(client, tile.id)
    expect(held?.engine).toBe('claude')
    expect(held?.sessionId).toBeFalsy()
    expect(held?.status).toBe('active')
    // This sibling's explicit profile is independent of the deliberately unreadable home catalog.
    const sibling = await client.request('agent_create', { engine: 'codex', cwd: d.projectsDir, codexHome: d.env.CODEX_HOME, bypassPermission: true }, 90_000)
    expect(sibling.error, JSON.stringify(sibling)).toBeUndefined()
    await until('the independent sibling to bind', async () => (await row(client, sibling.agent.id))?.sessionId, 45_000)
    const stopped = await client.request('agent_delete', { agentId: tile.id }, 60_000)
    expect(stopped.error, JSON.stringify(stopped)).toBeTruthy()
    const closed = await client.request('agent_close', { agentId: tile.id, sessionId: held!.sessionId,
      createdAt: held!.createdAt, mode: 'now' }, 60_000)
    expect(closed).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', detail: expect.stringContaining(reason) })
    expect(IsolatedDaemon.alive(native.pid)).toBe(true)
    expect((await row(client, tile.id))?.status).toBe('active')
    writeFileSync(faultFile + '.complete', complete, { mode: 0o600 })
    renameSync(faultFile + '.complete', faultFile)
    await until('the same live process to bind after its record becomes complete', async () => {
      const now = await row(client, tile.id)
      return now?.status === 'active' && now.sessionId === native.sessionId
    }, 60_000, 250)
    client.close()
  }, 240_000)

  it.runIf(process.platform === 'darwin')('Codex binding does not wait for the optional native discovery cooldown', async () => {
    const d = await IsolatedDaemon.create({ env: { HOOK_INSTALL_ENGINES: 'claude' } }); daemon = d
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`))
    const fault = join(d.root, 'optional-native-discovery-unavailable')
    writeFileSync(fault, 'hold', { mode: 0o600 })
    d.env.HARNESS_NATIVE_DISCOVERY_FAULT_FILE = fault
    d.env.NODE_OPTIONS = `--import=${pathToFileURL(join(CLI_ROOT, 'e2e/harness/nativeDescriptorFault.mjs')).href}`
    await d.start()
    const client = await LocalClient.connect(d)
    const opened = await client.request('agent_create', { engine: 'terminal', cwd: d.projectsDir }, 60_000)
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    const tile = await until('the private terminal tile', async () => {
      const now = await row(client, opened.agent.id); return now?.tmuxPane ? now : null
    })
    await until('the optional native discovery failure', () => existsSync(fault + '.observed'), 20_000)
    await type(d, tile.tmuxPane, 'codex')
    const sessionId = await until('the private Codex rollout', () => conversationIn('codex', d.env.CODEX_HOME!), 10_000)
    await until('binding under the optional discovery cooldown', async () => {
      const now = await row(client, tile.id)
      return now?.status === 'active' && now.sessionId === sessionId
    }, 20_000, 250)
    expect(Date.now() - Number(readFileSync(fault + '.observed', 'utf8'))).toBeLessThan(60_000)
    client.close()
  }, 120_000)

  it('unavailable Codex descriptor evidence holds binding, Stop and Close, then recovers the same conversation', async () => {
    const d = await IsolatedDaemon.create({ env: { HOOK_INSTALL_ENGINES: 'claude' } }); daemon = d
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`))
    const fault = join(d.root, 'native-descriptors-unavailable')
    d.env.HARNESS_DESCRIPTOR_FAULT_FILE = fault
    d.env.NODE_OPTIONS = `--import=${pathToFileURL(join(CLI_ROOT, 'e2e/harness/nativeDescriptorFault.mjs')).href}`
    await d.start()
    let client = await LocalClient.connect(d)
    const opened = await client.request('agent_create', { engine: 'terminal', cwd: d.projectsDir }, 60_000)
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    const tile = await until('the private terminal tile', async () => {
      const now = await row(client, opened.agent.id); return now?.tmuxPane ? now : null
    })
    client.close(); await d.stop()
    await type(d, tile.tmuxPane, 'codex')
    const sessionId = await until('the private Codex rollout', () => conversationIn('codex', d.env.CODEX_HOME!), 30_000)
    writeFileSync(fault, 'hold', { mode: 0o600 })
    await d.start()
    client = await LocalClient.connect(d)
    await until('the descriptor binding hold after readiness', () => /binding held · Conversation identity is held: the native (?:lsof|descriptor)/.test(d.log()), 45_000)
    const held = await row(client, tile.id)
    expect(held).toMatchObject({ engine: 'codex', status: 'active' })
    expect(held?.sessionId).toBeFalsy()
    const sibling = await client.request('agent_create', { engine: 'claude', cwd: d.projectsDir, bypassPermission: true }, 90_000)
    expect(sibling.error, JSON.stringify(sibling)).toBeUndefined()
    await until('the independent sibling to bind', async () => (await row(client, sibling.agent.id))?.sessionId, 45_000)
    const stopped = await client.request('agent_delete', { agentId: tile.id }, 60_000)
    expect(stopped.error, JSON.stringify(stopped)).toBeTruthy()
    const closed = await client.request('agent_close', { agentId: tile.id, sessionId: held!.sessionId, createdAt: held!.createdAt, mode: 'now' }, 60_000)
    expect(closed).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', detail: expect.stringMatching(/native (?:lsof|descriptor)/) })
    expect((await row(client, tile.id))?.status).toBe('active')
    expect(conversationIn('codex', d.env.CODEX_HOME!)).toBe(sessionId)
    renameSync(fault, fault + '.recovered')
    await until('the same live Codex conversation to bind after native evidence recovers', async () => {
      const now = await row(client, tile.id)
      return now?.status === 'active' && now.sessionId === sessionId
    }, 60_000, 250)
    client.close()
  }, 240_000)

  // A Codex agent in a moved CODEX_HOME, restarted, then stopped and opened again. Its rollout was held to the
  // daemon's own CODEX_HOME before the relaunch (portableHistory.ts) and refused as outside the profile: the
  // restart failed after Codex had already been stopped, and the reopen said RESUME_PREPARATION_FAILED. And
  // the relaunch names the person's own provider, the `model_provider` in the moved config.toml: it read the
  // daemon's ~/.codex/config.toml (Codex's `ownProvider`) and named Codex's default, which outranks the config.
  it('codex with CODEX_HOME: a restart and a reopen come back on the conversation, on the provider its config names', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const home = join(d.root, 'codex-work')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.toml'), 'model_provider = "azure"\n')
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export CODEX_HOME=${JSON.stringify(home)}\n`)
    const cwd = join(d.projectsDir, 'moved-codex-relaunch')
    mkdirSync(cwd, { recursive: true })
    await d.start()
    await until('the daemon to read the login shell', () => /\[env\] read \d+ variables from the login shell/.test(d.log()), 30_000)
    const client = await LocalClient.connect(d)
    const created = await client.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const bound = (what: string, sessionId?: string) => until(what, async () => {
      const now = await row(client, created.agent.id)
      return now?.sessionId && now.status === 'active' && (!sessionId || now.sessionId === sessionId) ? now : null
    }, 60_000, 500)
    const agent = await bound('the codex agent to bind with its data in codex-work')
    expect(conversationIn('codex', home)).toBe(agent.sessionId)
    await turn(client, agent.id, 'before the restart')

    const restarted = await client.request('agent_restart', { agentId: agent.id }, 90_000)
    expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
    await bound('the codex agent back on its conversation after the restart', agent.sessionId)
    await turn(client, agent.id, 'after the restart')
    const commands = await until('the restarted Codex in the process table', async () => {
      const found = codexCommands(agent.sessionId)
      return found.length ? found : null
    }, 15_000, 250)
    expect(commands.join('\n')).toContain('model_provider="azure"')

    const stopped = await client.request('agent_delete', { agentId: agent.id }, 60_000)
    expect(stopped.error, JSON.stringify(stopped)).toBeUndefined()
    await until('the codex agent to stop', async () => (await row(client, agent.id))?.status === 'stopped' || null, 45_000, 500)
    const resumed = await client.request('agent_resume', { agentId: agent.id }, 90_000)
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
    await bound('the codex agent back on its conversation after the reopen', agent.sessionId)
    await turn(client, agent.id, 'after the reopen')
    client.close()
  }, 300_000)

  // An engine reads whether it trusts a folder from ITS config: Codex from config.toml in its CODEX_HOME
  // (the one the person moved, or the agent's own profile), Claude Code from .claude.json in
  // CLAUDE_CONFIG_DIR. The daemon answered for a folder it had just made in ~/.codex/config.toml and
  // ~/.claude.json alone, so the engine asked anyway and the new agent waited on its question for good.
  it.each([
    ['claude', 'CLAUDE_CONFIG_DIR'],
    ['codex', 'CODEX_HOME'],
    ['codex', 'its own Codex profile'],
  ] as const)('%s with %s: a project folder Harness made is trusted where the engine reads it, and the agent starts without asking', async (engine: Engine, where) => {
    const d = await IsolatedDaemon.create({ trustPrompt: true })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const home = join(d.root, `${engine}-work`)
    mkdirSync(home, { recursive: true })
    // The engine has run there before: its config exists, which is when the daemon adds to it.
    const config = join(home, engine === 'claude' ? '.claude.json' : 'config.toml')
    writeFileSync(config, engine === 'claude' ? '{}' : 'model = "gpt-6"\n')
    const profile = where === 'its own Codex profile'
    if (!profile) writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export ${where}=${JSON.stringify(home)}\n`)
    await d.start()
    // The daemon learns a moved home from the login shell, which it reads once it is up.
    await until('the daemon to read the login shell', () => /\[env\] read \d+ variables from the login shell/.test(d.log()), 30_000)
    const client = await LocalClient.connect(d)
    const created = await client.request('agent_create', {
      engine, projectSource: 'new', creationId: `trust-${engine}-${profile ? 'profile' : 'moved'}-0001`,
      ...(profile ? { codexHome: home } : {}),
    }, 90_000)
    expect(created.state, JSON.stringify(created)).toBe('created')
    const agent = await until(`the ${engine} agent to start without asking about its folder`, async () => {
      const now = await row(client, created.agent.id)
      return now?.sessionId && now.status === 'active' ? now : null
    }, 60_000, 500)
    await turn(client, agent.id, 'in a folder Harness made')
    const folder: string = agent.project?.cwd ?? agent.cwd
    expect(readFileSync(config, 'utf8')).toContain(engine === 'claude' ? JSON.stringify(folder) : `[projects.${JSON.stringify(folder)}]`)
    client.close()
  }, 300_000)
})
