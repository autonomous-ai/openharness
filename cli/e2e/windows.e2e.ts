/**
 * Many windows on one daemon at once, for Claude Code and Codex: the desktop with several windows open,
 * `hn` in a terminal and the phone over the relay all watch the same agents and ask about them.
 *
 * Every window sees every turn, frame for frame and in the same order, and one that connects mid-turn
 * still sees it end. Windows that come and go by the dozen while agents work cost the window that
 * stayed no turn, and cost the core nothing it keeps: no restart, no memory, no open files, no tmux
 * client; eight that open one terminal at once leave one of them holding it. A window that stops an
 * agent while others are asking about it leaves none of them waiting, and its stop is a stop. A window
 * that leaves before its answers come has what it asked carried out, and its answers go nowhere: never
 * into another window.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const exec = promisify(execFile)
type Engine = 'claude' | 'codex'
type Row = Record<string, any>
const engines: Engine[] = ['claude', 'codex']
const other = (engine: Engine): Engine => (engine === 'claude' ? 'codex' : 'claude')
const CYCLES = Number(process.env.WINDOWS_CYCLES ?? 40)
const PROTOCOL = 3

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Row> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return active(client, created.agent.id)
}
const active = (client: LocalClient, agentId: string, sessionId?: string) =>
  until(`${agentId.slice(0, 8)} to be active with its conversation`, async () => {
    const agent = await row(client, agentId)
    return agent?.sessionId && agent.status === 'active' && (!sessionId || agent.sessionId === sessionId) ? agent : null
  }, 60_000, 500)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
const startedWith = (agentId: string, content: string) => (frame: Frame) =>
  isTurn('turn_started', agentId)(frame) && frame.payload?.userMessage === content
/** The end of the turn that `content` opened, in this window: the first turn_ended after its start. */
async function endOf(client: LocalClient, agentId: string, content: string, ms = 60_000): Promise<void> {
  const opened = await client.waitFor(startedWith(agentId, content), ms, `turn_started (${content})`)
  await client.waitFor(isTurn('turn_ended', agentId), ms, `turn_ended (${content})`, client.frames.indexOf(opened) + 1)
}
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const from = client.frames.length
  client.send('message', { agentId, content })
  await client.waitFor(startedWith(agentId, content), 60_000, `turn_started (${content})`, from)
  await endOf(client, agentId, content)
}
const connectMany = (d: IsolatedDaemon, n: number) => Promise.all(Array.from({ length: n }, () => LocalClient.connect(d)))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * What a window was told about these agents, as the wire carried it: every frame stamped with one of
 * their ids, from the first turn that opened with one of `firsts` to the last turn that ended. A
 * window's own replies carry no agent stamp, so what is left is what every window was sent alike.
 */
function story(client: LocalClient, agentIds: string[], firsts: string[]): string[] {
  const told = client.frames.filter((frame) => typeof frame.agentId === 'string' && agentIds.includes(frame.agentId))
  const from = told.findIndex((frame) => frame.type === 'turn_started' && firsts.includes(frame.payload?.userMessage))
  let to = -1
  for (let i = told.length - 1; i >= 0; i--) if (told[i].type === 'turn_ended') { to = i; break }
  if (from < 0 || to < from) return []
  return told.slice(from, to + 1).map((frame) => JSON.stringify(frame))
}
/** Replies this window never asked for: answers to another window's requests, which every request id
 *  here names by its prefix. */
const strays = (client: LocalClient, prefix: string) =>
  client.frames.filter((frame) => String(frame.payload?.requestId ?? '').startsWith(prefix)).map((frame) => frame.type)

/**
 * The lowest of a few samples, taken after the core has been left alone for a while: what the process
 * holds, not a moment's garbage before a collection. Measured over 1,200 windows coming and going, the
 * core's resident memory rose and fell by as much as 94 MiB as collections ran (251 → 267 → 245 → 262 →
 * 168): a sample taken mid-burst says more about when V8 last collected than about what the core keeps.
 */
async function settledRss(d: IsolatedDaemon, idleMs = 8_000): Promise<number> {
  await pause(idleMs)
  const samples: number[] = []
  for (let i = 0; i < 5; i++) { samples.push(await d.rssMiB()); await pause(1_000) }
  return Math.min(...samples)
}
async function openFiles(pid: number | null): Promise<number> {
  if (!pid) return 0
  const { stdout } = await exec('lsof', ['-n', '-P', '-p', String(pid)]).catch(() => ({ stdout: '' }))
  return stdout.trim().split('\n').length
}
/** How many tmux clients are attached to the agent's pane: one per open terminal stream. */
async function attached(d: IsolatedDaemon, pane: string): Promise<number> {
  const session = await d.tmux.run('display-message', '-p', '-t', pane, '#{session_name}')
  const clients = await d.tmux.run('list-clients', '-t', session).catch(() => '')
  return clients ? clients.split('\n').length : 0
}
/** Opens an agent's terminal as a window does, and resolves with `terminal_ready` or `terminal_error`. */
async function openTerminal(client: LocalClient, agentId: string, extra: Record<string, unknown> = {}): Promise<Frame> {
  const requestId = `open-${randomUUID()}`
  const answered = client.next((frame) => (frame.type === 'terminal_ready' || frame.type === 'terminal_error')
    && frame.payload?.requestId === requestId, 30_000, 'terminal_ready')
  client.send('terminal_open', { requestId, protocolVersion: PROTOCOL, agentId, cols: 100, rows: 30, ...extra })
  return answered
}
/** Keeps a window's terminal stream alive as the app does: a heartbeat, and everything drawn acknowledged. */
function keepAlive(client: LocalClient, streamId: string): () => void {
  const beat = setInterval(() => {
    client.send('terminal_alive', { streamId })
    const drawn = client.binaries.filter((frame) => frame.streamId === streamId)
    if (drawn.length) client.send('terminal_ack', { streamId, lastSeq: drawn[drawn.length - 1].seq })
  }, 2_000)
  return () => clearInterval(beat)
}
const typeInto = (client: LocalClient, streamId: string, keys: string, seq = 0) =>
  client.sendBinary({ kind: TerminalBinaryKind.input, streamId, seq, compressed: false, bytes: Buffer.from(keys, 'utf8') })

describe('many windows at once', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      // The runner swallows console output: WINDOWS_LOG=<file> keeps the daemon's whole log for reading.
      if (process.env.WINDOWS_LOG) writeFileSync(process.env.WINDOWS_LOG, d.log())
    })
    await d.start()
    return d
  }

  it.each(engines)('%s: eight windows see every frame of the turns, in the same order, and one that connects mid-turn sees it end', async (engine) => {
    const d = await fresh()
    const windows = await connectMany(d, 8)
    const agent = await create(d, windows[0], engine, `eight-${engine}`)
    const beside = await create(d, windows[1], other(engine), `beside-${engine}`)

    // A turn with a tool call in it, sent from one window, beside another agent's turn sent from another,
    // so that frames from both agents interleave on the way out.
    const first = '!tool printf eight-windows'
    const besideFirst = 'beside the first turn'
    windows[3].send('message', { agentId: agent.id, content: first })
    windows[6].send('message', { agentId: beside.id, content: besideFirst })
    await Promise.all(windows.flatMap((window) => [endOf(window, agent.id, first), endOf(window, beside.id, besideFirst)]))

    // A slow turn, and a window that connects while it is running.
    const slow = '!slow 5000'
    windows[5].send('message', { agentId: agent.id, content: slow })
    await windows[0].waitFor(startedWith(agent.id, slow), 30_000, 'the slow turn_started')
    const late = await LocalClient.connect(d)
    expect((await row(late, agent.id))?.activity?.state).toBe('working')
    const lateEnded = late.waitFor(isTurn('turn_ended', agent.id), 45_000, 'the slow turn_ended in the late window')
    await Promise.all([...windows.map((window) => endOf(window, agent.id, slow)), lateEnded])

    // Every window was told the same thing, frame for frame, in the same order.
    const told = windows.map((window) => story(window, [agent.id, beside.id], [first, besideFirst]))
    const types = told[0].map((frame) => JSON.parse(frame).type)
    for (const kind of ['turn_started', 'thinking_delta', 'tool_start', 'tool_end', 'text_delta', 'turn_ended']) expect(types).toContain(kind)
    for (const [i, each] of told.entries()) expect(each, `window ${i}`).toEqual(told[0])
    // The late one was told the rest of the slow turn, as the others were: the same frames, in the same
    // order, from the moment it connected to the turn's end, its answer among them.
    const stamped = (client: LocalClient) => client.frames
      .filter((frame) => typeof frame.agentId === 'string' && [agent.id, beside.id].includes(frame.agentId)).map((frame) => JSON.stringify(frame))
    const lateTold = stamped(late)
    const lateEnd = lateTold.indexOf(JSON.stringify(await lateEnded))
    const rest = lateTold.slice(0, lateEnd + 1)
    expect(rest.some((frame) => JSON.parse(frame).type === 'text_delta' && JSON.parse(frame).payload?.content === `answer 2: ${slow}`)).toBe(true)
    const everyone = stamped(windows[0])
    const at = everyone.indexOf(rest[0])
    expect(at, 'the late window was told something no other window was').toBeGreaterThanOrEqual(0)
    expect(everyone.slice(at, at + rest.length)).toEqual(rest)
    for (const window of [...windows, late]) window.close()
  })

  it(`windows coming and going, ${CYCLES} rounds of eight, while agents take turns: the window that stayed misses none, and the core keeps nothing of them`, async () => {
    const d = await fresh()
    const stay = await LocalClient.connect(d)
    const agents = [await create(d, stay, 'claude', 'churn-claude'), await create(d, stay, 'codex', 'churn-codex')]
    const contents: Array<[string, string]> = []
    const round = async (i: number) => {
      const agent = agents[i % 2]
      const content = `churn ${i}`
      contents.push([agent.id, content])
      const batch = await connectMany(d, 8)
      // The first sends the turn and goes at once, before it has even started.
      batch[0].send('message', { agentId: agent.id, content })
      batch[0].close()
      // The rest ask what a window asks when it opens; half of them leave before the answers come.
      await Promise.all(batch.slice(1).map(async (window, k) => {
        const tag = `gone-${i}-${k}`
        if (k % 2) {
          window.send('agents_list', { requestId: `${tag}-list`, includeStopped: true })
          window.send('session_get', { requestId: `${tag}-get`, sessionId: agent.sessionId, limit: 50 })
          window.send('sessions_list', { requestId: `${tag}-sessions`, agentId: agent.id })
          window.close()
          return
        }
        const page = await window.request('session_get', { sessionId: agent.sessionId, limit: 50 }, 30_000)
        expect(page.error, JSON.stringify(page)).toBeUndefined()
        expect((await window.request<{ agents: Row[] }>('agents_list', {}, 30_000)).agents.map((one) => one.id).sort()).toEqual(agents.map((one) => one.id).sort())
        window.close()
      }))
      await endOf(stay, agent.id, content)
    }

    // Warm: pools, caches and the transcripts reach their working size before anything is measured.
    for (let i = 0; i < 5; i++) await round(i)
    const rssBefore = await settledRss(d)
    const filesBefore = await openFiles(d.corePid())
    for (let i = 5; i < 5 + CYCLES / 2; i++) await round(i)
    const rssMiddle = await settledRss(d)
    for (let i = 5 + CYCLES / 2; i < 5 + CYCLES; i++) await round(i)
    const rssAfter = await settledRss(d)
    const filesAfter = await openFiles(d.corePid())
    const report = `${CYCLES} rounds of 8 windows · rss ${rssBefore.toFixed(1)} → ${rssMiddle.toFixed(1)} → ${rssAfter.toFixed(1)} MiB · open files ${filesBefore} → ${filesAfter}`
    if (process.env.WINDOWS_REPORT) writeFileSync(process.env.WINDOWS_REPORT, `${report}\n`)

    // The window that stayed saw every turn, once each, whoever sent it and however soon they left.
    for (const [agentId, content] of contents) {
      expect(stay.frames.filter(startedWith(agentId, content)).length, content).toBe(1)
    }
    // It never heard the answers meant for the windows that left.
    expect(strays(stay, 'gone-')).toEqual([])
    expect(d.coresStarted()).toBe(1)
    // Memory follows the work, not the windows. Across the rounds it grows no more than the soak test
    // allows four agents' turns, and it settles: after the second half the core holds no more than it did
    // at its highest before, give or take a collection. (Two runs: 279 → 320 → 341 MiB, and
    // 281 → 168 → 209 MiB, the middle one sampled just after V8 gave memory back.) Each half is 160
    // windows: one that cost the core 300 KiB it never gave back would pass 48 MiB.
    expect(rssAfter - rssBefore, report).toBeLessThan(96)
    expect(rssAfter - Math.max(rssBefore, rssMiddle), report).toBeLessThan(48)
    // Every socket the windows opened is closed again.
    expect(filesAfter - filesBefore, report).toBeLessThan(16)
    // And both agents still work for the window that stayed.
    for (const agent of agents) await turn(stay, agent.id, `after the windows came and went (${agent.engine})`)
    stay.close()
  }, 180_000 + CYCLES * 4_000)

  it.each([
    ['claude', 'agent_close'], ['claude', 'agent_delete'], ['codex', 'agent_close'], ['codex', 'agent_delete'],
  ] as Array<[Engine, 'agent_close' | 'agent_delete']>)('%s: one window stops an agent with %s while three others ask about it: every request is answered, and the stop is a stop', async (engine, how) => {
    const d = await fresh()
    const closer = await LocalClient.connect(d)
    const askers = await connectMany(d, 3)
    const watcher = await LocalClient.connect(d)
    const agent = await create(d, closer, engine, `stopped-${engine}-${how}`)
    const neighbour = await create(d, watcher, other(engine), `neighbour-${engine}-${how}`)
    await turn(closer, agent.id, 'before the windows ask')

    // What a window asks about an agent it shows: its history, its row, a rename, whether it is busy and
    // what its pane runs. All of it at once on each window, round after round, until the stop has been
    // answered and a little after.
    const ask = (asker: LocalClient, n: number) => Promise.all([
      asker.request('session_get', { sessionId: agent.sessionId, limit: 50 }, 30_000).then((answer) => ({ type: 'session_get', answer })),
      asker.request('sessions_list', { agentId: agent.id }, 30_000).then((answer) => ({ type: 'sessions_list', answer })),
      asker.request('agents_list', { includeStopped: true }, 30_000).then((answer) => ({ type: 'agents_list', answer })),
      asker.request('agent_update', { agentId: agent.id, name: `asked about ${n}` }, 30_000).then((answer) => ({ type: 'agent_update', answer })),
      asker.request('agent_close', { agentId: agent.id, sessionId: agent.sessionId, createdAt: agent.createdAt, mode: 'inspect' }, 30_000)
        .then((answer) => ({ type: 'agent_close inspect', answer })),
      asker.request('terminal_info', { agentId: agent.id }, 30_000).then((answer) => ({ type: 'terminal_info', answer })),
    ])
    let stoppedAt = 0
    const deadline = Date.now() + 120_000
    const asking = askers.map(async (asker, k) => {
      const answers: Array<{ type: string; answer: Row }> = []
      for (let n = 0; Date.now() < deadline; n++) {
        answers.push(...await ask(asker, k * 1_000 + n))
        if (stoppedAt && Date.now() - stoppedAt > 1_500) break
      }
      return answers
    })
    // Held so a rejection is the test's to report, not an unhandled one, whichever way the stop goes.
    const asked = Promise.all(asking)
    asked.catch(() => {})
    await pause(500)
    const stopped = how === 'agent_close'
      ? await closer.request('agent_close', { agentId: agent.id, sessionId: agent.sessionId, createdAt: agent.createdAt, mode: 'now' }, 90_000)
      : await closer.request('agent_delete', { agentId: agent.id }, 90_000)
    stoppedAt = Date.now()
    // Every request got an answer, a result or a refusal; none waited past its timeout (that rejects).
    const answers = (await asked).flat()
    expect(answers.length).toBeGreaterThan(0)

    // The stop was a stop, and every answer is the one its question asks for. A close asked for while
    // another window's inspect of the same agent was still running was answered with that inspect's
    // `{ activity }` and the agent left running (measured: still active 10 s later), and an inspect that
    // ran beside a close came back as the close's `{ closed: true }`: the close service answered any
    // request for an agent with whatever job was running for it.
    expect(stopped, `${how} answered ${JSON.stringify(stopped)} while other windows asked about the agent`)
      .toMatchObject(how === 'agent_close' ? { closed: true } : { deleted: true })
    const shaped: Record<string, (answer: Row) => boolean> = {
      session_get: (answer) => Array.isArray(answer.events),
      sessions_list: (answer) => Array.isArray(answer.sessions),
      agents_list: (answer) => Array.isArray(answer.agents),
      agent_update: (answer) => answer.agent?.id === agent.id,
      'agent_close inspect': (answer) => typeof answer.activity === 'string',
      terminal_info: (answer) => typeof answer.path === 'string',
    }
    const misshapen = answers.filter(({ type, answer }) => typeof answer.error !== 'string' && !shaped[type](answer))
      .map(({ type, answer }) => `${type}: ${JSON.stringify(answer).slice(0, 200)}`)
    expect(misshapen, 'answers that are not what their question asks for').toEqual([])

    // It reads as stopped, once, and the questions that came after did not bring it back.
    await until('the agent to read as stopped', async () => (await row(watcher, agent.id))?.status === 'stopped' || null, 45_000, 500)
    await Promise.all(askers.map((asker, k) => ask(asker, 9_000 + k)))
    await pause(2_000)
    const after = (await rows(watcher)).filter((one) => one.id === agent.id)
    expect(after.map((one) => one.status)).toEqual(['stopped'])
    // The daemon carries on: the neighbour works, and the stopped agent opens again with its conversation.
    await turn(watcher, neighbour.id, 'the neighbour after the stop')
    const resumed = await watcher.request('agent_resume', { agentId: agent.id }, 90_000)
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
    await active(watcher, agent.id, agent.sessionId)
    await turn(watcher, agent.id, 'opened again after the stop')
    expect(d.coresStarted()).toBe(1)
    for (const window of [closer, ...askers, watcher]) window.close()
  })

  it('windows that leave before their answers come: what they asked is carried out, nothing of them is kept, and no other window hears their answers', async () => {
    const d = await fresh()
    const [desk, phone, tui] = await connectMany(d, 3)
    const claude = await create(d, desk, 'claude', 'leavers-claude')
    const codex = await create(d, desk, 'codex', 'leavers-codex')
    // The desk drives the claude agent's terminal throughout, as the window in front of the person does.
    const driving = await openTerminal(desk, claude.id, { client: { kind: 'desktop', name: 'Desk Mac' } })
    expect(driving.type, JSON.stringify(driving)).toBe('terminal_ready')
    const streamId = String(driving.payload?.streamId)
    const stopBeating = keepAlive(desk, streamId)
    try {
      await turn(phone, codex.id, 'before the windows that leave')
      const filesBefore = await openFiles(d.corePid())
      const rounds = 6
      for (let n = 0; n < rounds; n++) {
        const leaver = await LocalClient.connect(d)
        const id = (what: string) => `leaver-${n}-${what}`
        // Something slow goes first, so that everything after it is still waiting behind it when the
        // window goes: a restart takes seconds, opening a terminal takes a tmux attach.
        if (n % 2 === 0) leaver.send('agent_restart', { requestId: id('restart'), agentId: codex.id })
        else leaver.send('terminal_open', { requestId: id('open'), protocolVersion: PROTOCOL, agentId: codex.id, cols: 100, rows: 30 })
        // Then what a window asks as it opens, a rename, a look at the terminal the desk is driving, and a
        // message: all of it sent, none of it waited for.
        leaver.send('agents_list', { requestId: id('list'), includeStopped: true })
        leaver.send('session_get', { requestId: id('get'), sessionId: claude.sessionId, limit: 50 })
        leaver.send('sessions_list', { requestId: id('sessions'), agentId: claude.id })
        leaver.send('agent_recent', { requestId: id('recent'), agentId: claude.id })
        leaver.send('terminal_info', { requestId: id('info'), agentId: claude.id })
        leaver.send('agent_close', { requestId: id('inspect'), agentId: codex.id, sessionId: codex.sessionId, createdAt: codex.createdAt, mode: 'inspect' })
        leaver.send('agent_update', { requestId: id('rename'), agentId: codex.id, name: `renamed by a window that left ${n}` })
        leaver.send('terminal_open', { requestId: id('watch'), protocolVersion: PROTOCOL, agentId: claude.id, cols: 80, rows: 24, takeover: false })
        leaver.send('message', { agentId: codex.id, content: `left behind ${n}` })
        leaver.close()
        // What it asked is carried out after it has gone: its message is a turn the others see.
        await Promise.all([phone, tui].map((window) => endOf(window, codex.id, `left behind ${n}`, 90_000)))
      }
      await active(tui, codex.id, codex.sessionId)
      expect((await row(tui, codex.id))?.name).toBe(`renamed by a window that left ${rounds - 1}`)

      // None of the windows that stayed heard an answer meant for one that left. A reply to a window that
      // had gone fell through to the broadcast: `terminal_info_result`, which is not sealed, reached every
      // other window and, unsealed, the relay's queue.
      for (const [name, window] of Object.entries({ desk, phone, tui })) expect(strays(window, 'leaver-'), name).toEqual([])
      // The desk still holds its terminal: nobody took it, and what it types is a turn.
      expect(desk.frames.filter((frame) => frame.type === 'terminal_closed').map((frame) => frame.payload)).toEqual([])
      const from = desk.frames.length
      typeInto(desk, streamId, 'still the desk\'s terminal\r')
      await desk.waitFor(startedWith(claude.id, 'still the desk\'s terminal'), 45_000, 'the desk\'s typed turn', from)
      await endOf(desk, claude.id, 'still the desk\'s terminal')
      // No tmux client of theirs is left on either pane: only the desk's, on the agent it drives.
      await until('the leavers\' tmux clients to go', async () =>
        (await attached(d, claude.tmuxPane)) === 1 && (await attached(d, codex.tmuxPane)) === 0 || null, 15_000, 250)
      // And their sockets are closed.
      await until('the leavers\' sockets to close', async () => (await openFiles(d.corePid())) - filesBefore < 16 || null, 15_000, 500)
      expect(d.coresStarted()).toBe(1)
    } finally {
      stopBeating()
    }
    for (const window of [desk, phone, tui]) window.close()
  }, 300_000)

  it('windows that open a terminal and go, round after round: no tmux client is left behind, and the window driving it keeps it', async () => {
    const d = await fresh()
    const desk = await LocalClient.connect(d)
    const claude = await create(d, desk, 'claude', 'watched-claude')
    const codex = await create(d, desk, 'codex', 'unheld-codex')

    // Eight windows open one terminal at the same moment: one of them ends up holding it, each of the
    // others is told it was taken, and one tmux client is left.
    const eight = await connectMany(d, 8)
    const opened = await Promise.all(eight.map((window, i) => openTerminal(window, codex.id, { client: { kind: 'desktop', name: `Window ${i}` } })))
    for (const answer of opened) expect(answer.type, JSON.stringify(answer)).toBe('terminal_ready')
    await until('all but one to be told the terminal was taken', () => eight.filter((window) =>
      window.frames.some((frame) => frame.type === 'terminal_closed' && frame.payload?.code === 'TERMINAL_TAKEN_OVER')).length === 7 || null, 15_000, 100)
    const holder = eight.findIndex((window) => !window.frames.some((frame) => frame.type === 'terminal_closed'))
    expect(holder).toBeGreaterThanOrEqual(0)
    await until('one tmux client on the pane', async () => (await attached(d, codex.tmuxPane)) === 1 || null, 10_000, 250)
    const held = String(opened[holder].payload?.streamId)
    const from = eight[holder].frames.length
    typeInto(eight[holder], held, 'from the window that holds it\r')
    await eight[holder].waitFor(startedWith(codex.id, 'from the window that holds it'), 45_000, 'the holder\'s typed turn', from)
    for (const window of eight) window.close()
    await until('the holder\'s tmux client to go with it', async () => (await attached(d, codex.tmuxPane)) === 0 || null, 15_000, 250)

    // The desk drives the claude agent's terminal while windows come and go around it: each watches it,
    // or opens the codex terminal nobody holds, and some go before the terminal has even opened.
    const driving = await openTerminal(desk, claude.id, { client: { kind: 'desktop', name: 'Desk Mac' } })
    expect(driving.type, JSON.stringify(driving)).toBe('terminal_ready')
    const streamId = String(driving.payload?.streamId)
    const stopBeating = keepAlive(desk, streamId)
    try {
      for (let n = 0; n < 20; n++) {
        const batch = await connectMany(d, 4)
        await Promise.all(batch.map(async (window, k) => {
          const agentId = k % 2 ? codex.id : claude.id
          if (k >= 2) {
            // Gone before the answer: the stream it asked for opens after the window has.
            window.send('terminal_open', { requestId: `gone-${n}-${k}`, protocolVersion: PROTOCOL, agentId, cols: 90, rows: 25, takeover: false })
            window.close()
            return
          }
          const answer = await openTerminal(window, agentId, { takeover: false })
          expect(answer.type, JSON.stringify(answer)).toBe('terminal_ready')
          // Watching the desk's terminal never takes it. (The codex one may open either way: another
          // window of the batch can still be holding it for the moment it takes that window to go.)
          if (agentId === claude.id) expect(answer.payload?.readOnly).toBe(true)
          window.close()
        }))
        if (n % 5 === 4) await turn(desk, claude.id, `while windows come and go ${n}`)
      }
      await until('every tmux client but the desk\'s to go', async () =>
        (await attached(d, claude.tmuxPane)) === 1 && (await attached(d, codex.tmuxPane)) === 0 || null, 15_000, 250)
      // The desk was never told its terminal was taken or closed, and it still types.
      expect(desk.frames.filter((frame) => frame.type === 'terminal_closed').map((frame) => frame.payload)).toEqual([])
      expect(strays(desk, 'gone-')).toEqual([])
      const typed = desk.frames.length
      typeInto(desk, streamId, 'the desk types on\r')
      await desk.waitFor(startedWith(claude.id, 'the desk types on'), 45_000, 'the desk\'s typed turn', typed)
      await endOf(desk, claude.id, 'the desk types on')
      expect(d.coresStarted()).toBe(1)
    } finally {
      stopBeating()
    }
    desk.close()
  }, 240_000)
})
