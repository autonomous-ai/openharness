/**
 * The hook client's own two roads, for Claude Code and Codex. Every hook an engine runs in this suite is
 * the real `hook/notify.mjs`, run by the fake engine the way the CLI runs it (harness/fakeEngine.mjs). It
 * gives the daemon 500 ms to answer. When it cannot reach the daemon at all, it writes the agent's row
 * into the registry itself (`fallbackRegister`), so the conversation an engine moves to while the daemon
 * is down is the one the daemon finds when it comes back.
 *
 * - A slow answer is not an outage. A daemon that took the event and answers late (held here, as a swap
 *   storm or a debugger holds it, then made to wait for an agent's new process by a restart) handles the
 *   event itself once it can, and the hook must leave the registry alone. A code review found the hook
 *   writing its own row meanwhile, which the daemon's next save merged over its own: the agent lost the
 *   name, permission mode and close plan the daemon kept. The suite could not see it, because its fake
 *   engines used to post their events straight to the daemon, with no deadline and no fallback.
 * - A daemon that is down. The person goes on in the terminal, starting a new conversation and taking a
 *   turn in it; the hook writes the agent's row, and the daemon, back, takes it in: the same agent, on the
 *   conversation the hook named, with everything the daemon kept for it, and working.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>

const engines: Engine[] = ['claude', 'codex']
/** A mode other than the default for each engine, so a row rebuilt without it shows. */
const MODE: Record<Engine, { mode: string; flags: string[] }> = {
  claude: { mode: 'plan', flags: ['--permission-mode', 'plan'] },
  codex: { mode: 'readOnly', flags: ['--sandbox', 'read-only'] },
}

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const bound = (client: LocalClient, agentId: string, sessionId?: string) =>
  until(`${agentId.slice(0, 8)} to be bound and active`, async () => {
    const now = await row(client, agentId)
    return now?.status === 'active' && now.sessionId && (!sessionId || now.sessionId === sessionId) ? now : null
  }, 60_000, 250)
async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine, name: string): Promise<Row> {
  const cwd = join(d.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, name, permissionMode: MODE[engine].mode }, 90_000)
  expect(created.error, `${name}: ${JSON.stringify(created)}`).toBeUndefined()
  return bound(client, created.agent.id)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}
/** What the person said in a conversation, oldest first, as the apps read it back. */
async function said(client: LocalClient, sessionId: string): Promise<string[]> {
  const page = await client.request('session_get', { sessionId, limit: 50 }, 60_000)
  if (page.error) return []
  return (page.events as Row[]).filter((event) => event.type === 'user_message').map((event) => String(event.payload.content))
}

/** Typed into the agent's terminal by the person, as at a keyboard: the engine takes it without the daemon. */
async function type(d: IsolatedDaemon, pane: string, text: string): Promise<void> {
  await d.tmux.run('send-keys', '-t', pane, '-l', text)
  await d.tmux.run('send-keys', '-t', pane, 'Enter')
}

/**
 * The registry as it is on disk, and its boot mark. The daemon writes the boot mark only as it loads the
 * registry; the hook writes it on every fallback, just before the row (notify.mjs `fallbackRegister`). So
 * a boot mark replaced while the daemon runs is a hook that wrote the registry behind its back.
 */
function onDisk(d: IsolatedDaemon): { registry: string | null; boot: { bytes: string; inode: number } | null } {
  const read = (file: string) => { try { return readFileSync(file, 'utf8') } catch { return null } }
  const boot = join(d.dataDir, 'registry-boot')
  const bytes = read(boot)
  return {
    registry: read(join(d.dataDir, 'registry.json')),
    boot: bytes === null ? null : { bytes, inode: statSync(boot).ino },
  }
}
const rowOnDisk = (d: IsolatedDaemon, agentId: string): Row | undefined =>
  (JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Row[]).find((entry) => entry.agentId === agentId)

/** The hooks the engines noted since `from` (a length of the hook log), as `<event>(<cause>) session=<id> ran in <ms> ms`. */
const hooksSince = (d: IsolatedDaemon, from: number): string[] => d.hookLog().slice(from).split('\n').filter(Boolean)
const ran = (lines: string[], pattern: RegExp): string | undefined => lines.find((line) => pattern.test(line) && / ran in \d+ ms · exit=0/.test(line))
const tookMs = (line: string): number => Number(/ ran in (\d+) ms/.exec(line)?.[1])

/** The engine process's arguments, read off the process in the agent's pane. */
async function engineArgs(d: IsolatedDaemon, pane: string): Promise<string> {
  const root = Number((await d.tmux.run('display-message', '-p', '-t', pane, '#{pane_pid}')).trim())
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), command: m![3] }))
  const under = new Set([root])
  for (let grew = true; grew;) {
    grew = false
    for (const p of table) if (under.has(p.ppid) && !under.has(p.pid)) { under.add(p.pid); grew = true }
  }
  return table.filter((p) => under.has(p.pid) && /\/bin\/(claude|codex)\b/.test(p.command)).map((p) => p.command).join('\n')
}

const processState = (pid: number): string => {
  try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '' }
}

describe('the hook client', () => {
  let daemon: IsolatedDaemon | undefined
  const stopped: number[] = []
  afterEach(async () => {
    for (const pid of stopped.splice(0)) { try { process.kill(pid, 'SIGCONT') } catch { /* gone */ } }
    await daemon?.close(); daemon = undefined
  })
  const fresh = async (): Promise<IsolatedDaemon> => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog()}`)
    })
    await d.start()
    return d
  }

  it('keeps a real native prompt visibly held through an unavailable registry and admits it after recovery', async () => {
    const d = await fresh(), client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'held-native-admission')
    await turn(client, agent.id, 'before registry hold')
    const file = join(d.dataDir, 'registry.json'), backup = file + '.fixture-backup'
    const accepted = () => [...d.log().matchAll(new RegExp(`\\[hooks\\] ${agent.sessionId.slice(0, 8)} UserPromptSubmit · engine=codex`, 'g'))].length
    await until('the first native prompt acknowledgement', () => accepted() === 1)
    // The fixture owns this entire data directory. A directory at the file's path
    // makes reads/writes fail even under a privileged CI account; no host chmod assumptions.
    renameSync(file, backup); mkdirSync(file)
    try {
      await type(d, agent.tmuxPane, 'typed during registry hold')
      await expect(until('admission hold to reach the actual session frame', async () => {
        const current = await row(client, agent.id)
        return current?.identityHold?.includes('durable hook admission') ? current : null
      }, 30_000)).resolves.toMatchObject({ sessionId: agent.sessionId, status: 'active', name: agent.name, permissionMode: MODE.codex.mode })
      expect(accepted()).toBe(1)
      expect(statSync(file).isDirectory()).toBe(true)
    } finally { rmdirSync(file); renameSync(backup, file) }
    await until('the exact pending native prompt acknowledgement', () => accepted() === 2, 30_000)
    await until('admission hold to clear after the durable commit', async () => !(await row(client, agent.id))?.identityHold, 30_000)
    expect(rowOnDisk(d, agent.id)).toMatchObject({ sessionId: agent.sessionId, permissionMode: MODE.codex.mode })
    expect((await row(client, agent.id))?.name).toBe(agent.name)
    client.close()
  })

  it('keeps a later Cursor turn open when Cancel superseded its linked Stop registration', async () => {
    const d = daemon = await IsolatedDaemon.create()
    onTestFailed(() => console.log(d.log()))
    const home = join(d.root, 'cursor'), binary = join(d.root, 'bin', 'cursor-agent')
    Object.assign(d.env, { CURSOR_HOME: home, CURSOR_CONFIG_DIR: home, CURSOR_DATA_DIR: home, CURSOR_PATH: binary })
    mkdirSync(home, { recursive: true })
    const pidFile = join(d.root, 'cursor.pid')
    writeFileSync(binary, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2026.10.10'); process.exit(0) }
if (process.argv.includes('--help')) { console.log('--force --resume'); process.exit(0) }
process.title = 'cursor-agent'.padEnd(120)
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.on('SIGINT', () => {})
console.log('fixture-cursor-ready')
setInterval(() => {}, 1000)
`, { mode: 0o755 })
    const cwd = join(d.projectsDir, 'cursor'); mkdirSync(cwd)
    const sessionId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
    const transcriptDir = join(home, 'projects', 'fixture', 'agent-transcripts', sessionId)
    mkdirSync(transcriptDir, { recursive: true })
    const transcriptPath = join(transcriptDir, sessionId + '.jsonl')
    const prompt = (text: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } }) + '\n'
    writeFileSync(transcriptPath, prompt('first Cursor turn'))
    await d.start()
    const client = await LocalClient.connect(d)
    try {
      const created = await client.request('agent_create', { engine: 'cursor', cwd, bypassPermission: true }, 60_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      const agentId = created.agent.id, pane = created.agent.terminal?.runtimes?.[0]?.paneId ?? created.agent.tmuxPane
      await until('the private Cursor process', async () => (await d.capture(pane)).includes('fixture-cursor-ready'), 20_000)
      const callerPid = Number(readFileSync(pidFile, 'utf8'))
      const hook = async (event: string, delivery?: string, firedAt?: number, endpoint = 'session-start') => {
        const response = await fetch(`http://127.0.0.1:${d.port}/api/hook/${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-hook-token': d.hookCredential(),
            ...(delivery ? { 'x-harness-hook-delivery-id': delivery } : {}),
            ...(firedAt ? { 'x-harness-hook-fired-at': String(firedAt) } : {}) },
          body: JSON.stringify({ engine: 'cursor', sessionId, tmuxPane: pane, cwd, callerPid, transcriptPath, hookEvent: event }),
        })
        return { status: response.status, body: await response.json() }
      }
      const initial = await hook('sessionStart')
      expect(initial.status, JSON.stringify(initial)).toBeLessThan(300)
      expect(initial.body.ignored, JSON.stringify(initial)).toBeUndefined()
      await bound(client, agentId, sessionId)
      await until('the existing Cursor parser', () => new RegExp(`\\[agent\\] ${agentId.slice(0, 8)} attached · engine=cursor`).test(d.log()), 20_000)
      const delivery = 'fixture-cursor-stop-0001', firedAt = Date.now()
      expect(await hook('stop', delivery, firedAt)).toEqual({ status: 200, body: { ok: true } })
      const cancelled = client.next(frame => frame.agentId === agentId && frame.type === 'agent_activity'
        && frame.payload?.activity?.state === 'idle', 20_000)
      client.send('cancel', { agentId }); await cancelled
      const later = client.next(isTurn('turn_started', agentId), 20_000)
      appendFileSync(transcriptPath, prompt('later Cursor turn'))
      expect((await later).payload?.userMessage).toBe('later Cursor turn')
      expect(await hook('stop', delivery, firedAt, 'turn-stop')).toEqual({ status: 200, body: { ok: true, duplicate: true } })
      expect((await row(client, agentId))?.identityHold).toBeFalsy()
      expect(d.coresStarted()).toBe(1)
    } finally { client.close() }
  })

  it.each(engines)('%s: an answer later than 500 ms is not an outage, and the hook leaves the registry to the daemon', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `slow-${engine}`)
    await turn(client, agent.id, 'before the hold')
    // The prompts the daemon took through the hook, by its log: this one, so far.
    const prompts = () => [...d.log().matchAll(new RegExp(`\\[hooks\\] ${agent.sessionId.slice(0, 8)} UserPromptSubmit `, 'g'))].length
    await until('the daemon to have taken the first prompt\'s hook', () => prompts() === 1 || null, 15_000, 50)

    // The core held still, its socket still taking connections: an engine's hook connects, sends its
    // event and hears nothing back.
    const core = d.corePid()!
    process.kill(core, 'SIGSTOP')
    stopped.push(core)
    await until('the core to be held', () => processState(core).includes('T') || null, 10_000, 50)
    const before = onDisk(d)
    const from = d.hookLog().length
    await type(d, agent.tmuxPane, 'typed while the daemon was held')
    const lines = await until('the engine to run its hooks for the typed prompt', () => {
      const now = hooksSince(d, from)
      return ran(now, /^.* UserPromptSubmit /) && (engine === 'codex' || ran(now, /^.* Stop /)) ? now : null
    }, 30_000, 100)
    // Each waited out the hook's own deadline: the daemon had taken the event and not answered.
    expect(tookMs(ran(lines, / UserPromptSubmit /)!), lines.join('\n')).toBeGreaterThanOrEqual(500)
    expect(processState(core), 'the core is still held').toContain('T')
    // Nobody wrote the registry: the daemon could not, and the hook must not.
    expect(onDisk(d)).toEqual(before)

    // Let go, the daemon takes the event itself, the one the hook gave up waiting on: the typed turn
    // reaches the app, and the agent is as the daemon kept it.
    const typedStarted = client.next(isTurn('turn_started', agent.id), 60_000, 'turn_started (typed while held)')
    const typedEnded = client.next(isTurn('turn_ended', agent.id), 60_000, 'turn_ended (typed while held)')
    process.kill(core, 'SIGCONT')
    stopped.splice(stopped.indexOf(core), 1)
    expect((await typedStarted).payload?.userMessage).toBe('typed while the daemon was held')
    await typedEnded
    await until('the daemon to take the hook it did not answer in time', () => prompts() === 2 || null, 30_000, 100)
    expect(await said(client, agent.sessionId)).toEqual(['before the hold', 'typed while the daemon was held'])
    let now = await bound(client, agent.id, agent.sessionId)
    expect([now.name, now.permissionMode]).toEqual([`slow-${engine}`, MODE[engine].mode])
    await turn(client, agent.id, 'after the hold')

    // A restart: the new engine announces itself before the daemon has recorded its process, and the daemon
    // waits for the record before it answers (core/engines/hooks.ts), often past the hook's deadline.
    const restarted = await client.request('agent_restart', { agentId: agent.id }, 90_000)
    expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
    now = await bound(client, agent.id, agent.sessionId)
    await turn(client, agent.id, 'after the restart')
    expect([now.name, now.permissionMode]).toEqual([`slow-${engine}`, MODE[engine].mode])
    expect(await engineArgs(d, now.tmuxPane)).toContain(MODE[engine].flags.join(' '))
    // Through all of it, no hook wrote the registry: the boot mark is the one the daemon wrote as it started.
    expect(onDisk(d).boot).toEqual(before.boot)
    client.close()
  })

  it.each(engines)('%s: the daemon down, the hook writes the agent\'s row, and the daemon back takes it in', async (engine) => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `down-${engine}`)
    await turn(client, agent.id, 'before the daemon went down')
    client.close()
    await d.stop()
    // The row as the daemon left it.
    const kept = rowOnDisk(d, agent.id)!
    expect(kept).toMatchObject({ sessionId: agent.sessionId, defaultName: `down-${engine}`, permissionMode: MODE[engine].mode })
    const before = onDisk(d)

    // The person goes on in the terminal: a new conversation (Claude Code's `/clear`, Codex's `/new`).
    const from = d.hookLog().length
    await type(d, agent.tmuxPane, '!clear')
    const announced = await until('the engine to announce its new conversation', () =>
      ran(hooksSince(d, from), / SessionStart\(clear\) /), 30_000, 100)
    const sessionId = /session=(\S+)/.exec(announced)![1]
    expect(sessionId).not.toBe(agent.sessionId)
    // The hook could not reach the daemon, so it wrote the agent's row itself: the same agent, pane and
    // process, on the new conversation.
    const written = rowOnDisk(d, agent.id)
    expect(written, 'the agent\'s row after the hook').toMatchObject({
      sessionId, engine, tmuxPane: agent.tmuxPane, processIdentity: kept.processIdentity,
    })
    expect(onDisk(d).boot).not.toEqual(before.boot)
    // …and a turn in it, the daemon still down.
    await type(d, agent.tmuxPane, 'typed while the daemon was down')
    await until('the engine to take the typed prompt', () => ran(hooksSince(d, from), / UserPromptSubmit /) || null, 30_000, 100)

    // Back, the daemon takes the row in: one agent, on the conversation the hook named, still the agent
    // the daemon made, with the turn typed meanwhile, and working.
    await d.start()
    client = await LocalClient.connect(d)
    const back = await bound(client, agent.id, sessionId)
    expect((await rows(client)).filter((one) => one.status === 'active').map((one) => one.id)).toEqual([agent.id])
    expect([back.name, back.permissionMode, back.tmuxPane]).toEqual([`down-${engine}`, MODE[engine].mode, agent.tmuxPane])
    await until('the turn typed while the daemon was down', async () =>
      (await said(client, sessionId)).includes('typed while the daemon was down') || null, 60_000, 500)
    await turn(client, agent.id, 'after the daemon came back')
    expect(await said(client, sessionId)).toEqual(['typed while the daemon was down', 'after the daemon came back'])

    // And it relaunches as it was made: a restart keeps its permission mode.
    const restarted = await client.request('agent_restart', { agentId: agent.id }, 90_000)
    expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
    const after = await bound(client, agent.id, sessionId)
    expect([after.name, after.permissionMode]).toEqual([`down-${engine}`, MODE[engine].mode])
    expect(await engineArgs(d, after.tmuxPane)).toContain(MODE[engine].flags.join(' '))
    await turn(client, agent.id, 'after the restart')
    client.close()
  })

  it.each(engines)('%s typed into a terminal tile while the daemon is down: the hook makes the tile its agent, and the daemon takes it in', async (engine) => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    // A terminal open in the app. Its row names the engine `terminal`, which the hook once read as a damaged
    // registry, so a hook with the daemon down registered nothing.
    const cwd = join(d.projectsDir, `in-terminal-${engine}`)
    mkdirSync(cwd, { recursive: true })
    const opened = await client.request('agent_create', { engine: 'terminal', cwd }, 60_000)
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    const tile = await until('the terminal tile to be up', async () => {
      const now = await row(client, opened.agent.id)
      return now?.status === 'active' && rowOnDisk(d, now.id)?.engine === 'terminal' ? now : null
    }, 60_000, 250)
    client.close()
    await d.stop()

    // The person starts the engine in that terminal.
    const from = d.hookLog().length
    await type(d, tile.tmuxPane, engine)
    const announced = await until('the engine to announce its conversation', () =>
      ran(hooksSince(d, from), / SessionStart\(startup\) /), 30_000, 100)
    const sessionId = /session=(\S+)/.exec(announced)![1]
    // Nothing listening, the hook wrote the row itself: the tile's own, now the engine's, as the daemon
    // would have made it.
    const rowsOnDisk = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Row[]
    expect(rowsOnDisk.filter((one) => one.tmuxPane === tile.tmuxPane), JSON.stringify(rowsOnDisk)).toEqual([
      expect.objectContaining({ agentId: tile.id, engine, sessionId, terminalHost: true, active: true }),
    ])

    // Back, the daemon takes it in: the tile is the agent, on the conversation the hook named, and works.
    await d.start()
    client = await LocalClient.connect(d)
    const back = await bound(client, tile.id, sessionId)
    expect([back.engine, back.name, back.tmuxPane]).toEqual([engine, tile.name, tile.tmuxPane])
    await turn(client, tile.id, 'to the engine typed into the terminal')
    // And when the engine exits, its conversation is kept under the agent's id and the pane is a terminal
    // again, under one of its own (retainExitedSession.ts), as for any engine typed into a terminal.
    client.send('message', { agentId: tile.id, content: '!exit' })
    await until('the pane to be a terminal again', async () => {
      const all = await rows(client)
      const shell = all.find((one) => one.tmuxPane === tile.tmuxPane && one.engine === 'terminal' && one.status === 'active')
      const kept = all.find((one) => one.id === tile.id)
      return shell && kept?.status === 'stopped' && kept.sessionId === sessionId ? shell : null
    }, 60_000, 500)
    client.close()
  })

  it.each(engines)('%s in a tmux session the person opened by hand is no agent, whether the daemon is down or up', async (engine) => {
    const d = await fresh()
    await d.stop()
    const before = onDisk(d)
    const cwd = join(d.projectsDir, `own-session-${engine}`)
    mkdirSync(cwd, { recursive: true })
    // Not a session Harness made: the daemon never takes one for an agent (harnessSessionLabel.ts).
    const from = d.hookLog().length
    const pane = await d.tmux.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', `own-${engine}`, '-c', cwd,
      ...['HOME', 'ZDOTDIR', 'PATH', 'CODEX_HOME', 'CLAUDE_PATH', 'CODEX_PATH'].flatMap((name) => ['-e', `${name}=${d.env[name]}`]),
      engine === 'claude' ? d.env.CLAUDE_PATH! : d.env.CODEX_PATH!)
    await until('the engine to run its start-up hook', () => ran(hooksSince(d, from), / SessionStart\(startup\) /), 30_000, 100)
    // With nothing listening, the hook wrote nothing for it either.
    expect(onDisk(d)).toEqual(before)

    // Back, the daemon lists no agent for it, and a prompt typed there, its hook now answered, makes none.
    await d.start()
    const client = await LocalClient.connect(d)
    await type(d, pane, 'typed in a session of my own')
    await until('the engine to take the prompt', () => ran(hooksSince(d, from), / UserPromptSubmit /), 30_000, 100)
    await new Promise((done) => setTimeout(done, 6_000))
    expect((await rows(client)).filter((one) => one.tmuxPane === pane)).toEqual([])
    client.close()
  })

})
