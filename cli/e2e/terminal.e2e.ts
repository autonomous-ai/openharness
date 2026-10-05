/**
 * The terminal, end to end, for Claude Code and Codex: the binary stream the desktop draws a pane from.
 * Opening one shows the engine's screen; keystrokes typed into it are a turn like any other; resizing
 * reflows it; one window takes a terminal from another, or watches it without taking it; a window that
 * goes, closes, freezes or floods its terminal costs only that stream, never the agent or the daemon.
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { TerminalBinaryKind, type TerminalBinaryClear } from '../src/lib/terminalBinary.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
const engines: Engine[] = ['claude', 'codex']
const PROTOCOL = 3
const WELCOME: Record<Engine, string> = { claude: 'Welcome to Claude Code (fake)', codex: 'OpenAI Codex (fake)' }

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Record<string, any>> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')

/** One terminal as a window holds it: its stream, what it has drawn, and the keystrokes it sent. */
class Terminal {
  private inputSeq = 0
  private constructor(readonly client: LocalClient, readonly agentId: string, readonly ready: Record<string, any>, private readonly since: number) {}

  get streamId(): string { return this.ready.streamId as string }
  get readOnly(): boolean { return this.ready.readOnly === true }

  /** Opens it, or rejects with the `terminal_error` code the daemon answered. */
  static async open(client: LocalClient, agentId: string, options: Record<string, unknown> = {}): Promise<Terminal> {
    const answer = await Terminal.answer(client, { agentId, cols: 100, rows: 30, ...options })
    if (answer.type !== 'terminal_ready') throw new Error(String(answer.payload?.code))
    return new Terminal(client, agentId, answer.payload!, client.binaries.length)
  }

  /** The frame `terminal_open` is answered with: `terminal_ready`, or `terminal_error` naming why. */
  static async answer(client: LocalClient, payload: Record<string, unknown>): Promise<Frame> {
    const requestId = `open-${Math.random().toString(36).slice(2)}`
    const answered = client.next((frame) => (frame.type === 'terminal_ready' || frame.type === 'terminal_error')
      && frame.payload?.requestId === requestId, 30_000, 'terminal_ready')
    client.send('terminal_open', { requestId, protocolVersion: PROTOCOL, ...payload })
    return answered
  }

  frames(): TerminalBinaryClear[] {
    return this.client.binaries.slice(this.since).filter((frame) => frame.streamId === this.streamId)
  }

  /** What the window would draw: the latest keyframe and the output after it. */
  screen(): string {
    const frames = this.frames()
    let start = -1
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i].kind === TerminalBinaryKind.keyframe) { start = i; break }
    return frames.slice(Math.max(start, 0)).filter((frame) => frame.kind !== TerminalBinaryKind.sync).map((frame) => text(frame.bytes)).join('')
  }

  /** Every output byte since the stream opened, keyframes left out: the engine's writes, in order. */
  output(): string {
    return this.frames().filter((frame) => frame.kind === TerminalBinaryKind.output).map((frame) => text(frame.bytes)).join('')
  }

  keyframe(index = 0): Promise<TerminalBinaryClear> {
    return until(`keyframe ${index}`, () => this.frames().filter((frame) => frame.kind === TerminalBinaryKind.keyframe)[index] ?? null, 20_000, 50)
  }

  shows(what: string, ms = 20_000): Promise<string> {
    return until(`the terminal to show ${JSON.stringify(what)}`, () => { const now = this.screen(); return now.includes(what) ? now : null }, ms, 50)
  }

  /** Keystrokes, in frames of at most `chunk` bytes, numbered as the desktop numbers them. */
  type(keys: string, chunk = 8): void {
    const bytes = Buffer.from(keys, 'utf8')
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      this.client.sendBinary({ kind: TerminalBinaryKind.input, streamId: this.streamId, seq: this.inputSeq++, compressed: false, bytes: bytes.subarray(offset, offset + chunk) })
    }
  }

  /** A keystroke frame with any seq at all: what a client whose counter drifted sends. */
  typeAt(seq: number, keys: string): void {
    this.client.sendBinary({ kind: TerminalBinaryKind.input, streamId: this.streamId, seq, compressed: false, bytes: Buffer.from(keys, 'utf8') })
  }

  paste(words: string): void {
    this.client.sendBinary({ kind: TerminalBinaryKind.paste, streamId: this.streamId, seq: 0, compressed: false, bytes: Buffer.from(words, 'utf8') })
  }

  /** Acknowledges everything drawn so far, as the renderer does once it has painted it. */
  ack(): void {
    const frames = this.frames()
    if (frames.length) this.client.send('terminal_ack', { streamId: this.streamId, lastSeq: frames[frames.length - 1].seq })
  }

  closed(ms = 20_000): Promise<Frame> {
    return this.client.waitFor((frame) => frame.type === 'terminal_closed' && frame.payload?.streamId === this.streamId, ms, 'terminal_closed')
  }

  error(code: string, ms = 20_000): Promise<Frame> {
    return this.client.waitFor((frame) => frame.type === 'terminal_error' && frame.payload?.code === code
      && (frame.payload?.streamId === undefined || frame.payload.streamId === this.streamId), ms, `terminal_error ${code}`)
  }
}

describe('the terminal', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    return d
  }
  /** How many tmux clients are attached to the agent's pane: one per open stream, and none left over. */
  const attached = async (d: IsolatedDaemon, pane: string) => {
    const session = await d.tmux.run('display-message', '-p', '-t', pane, '#{session_name}')
    const clients = await d.tmux.run('list-clients', '-t', session).catch(() => '')
    return clients ? clients.split('\n').length : 0
  }

  it.each(engines)('%s: opening it shows the engine\'s screen, and what is typed into it is a turn', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `type-${engine}`)
    const terminal = await Terminal.open(client, agent.id)
    expect(terminal.readOnly).toBe(false)
    expect(terminal.ready.engineId).toBe(engine)
    const keyframe = await terminal.keyframe()
    expect(text(keyframe.bytes)).toContain(WELCOME[engine])
    expect([keyframe.cols, keyframe.rows]).toEqual([100, 30])

    const started = client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    terminal.type('typed into the terminal\r')
    expect((await started).payload?.userMessage).toBe('typed into the terminal')
    await ended
    await terminal.shows('answer 1: typed into the terminal')
    terminal.ack()
    // And the composer still works beside it: the same agent, the same conversation.
    await turn(client, agent.id, 'sent from the composer')
    await terminal.shows('answer 2: sent from the composer')
    client.close()
  })

  it.each(engines)('%s: asked what its pane runs and where (terminal_info, as hn asks), it says, from tmux', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `info-${engine}`)
    const info = await client.request('terminal_info', { agentId: agent.id }, 10_000)
    expect(info.error, JSON.stringify(info)).toBeUndefined()
    expect(realpathSync(info.path)).toBe(realpathSync(join(d.projectsDir, `info-${engine}`)))
    expect(Number.isSafeInteger(info.pid)).toBe(true)
    expect(info.tty).toMatch(/^\/dev\//)
    expect(typeof info.command).toBe('string')
    expect(await client.request('terminal_info', { agentId: 'no-such-agent' }, 10_000)).toMatchObject({ error: 'AGENT_NOT_FOUND' })
    client.close()
  })

  it.each(engines)('%s: keystrokes out of order type nothing and say which one was expected; JSON keystrokes are refused', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `order-${engine}`)
    const terminal = await Terminal.open(client, agent.id)
    await terminal.keyframe()
    terminal.typeAt(5, 'skipped ahead')
    const refused = await terminal.error('TERMINAL_INPUT_INVALID')
    expect(refused.payload).toMatchObject({ reason: 'seq', expectedSeq: 0 })
    client.send('terminal_input', { streamId: terminal.streamId, data: 'as json' })
    await terminal.error('TERMINAL_BINARY_REQUIRED')
    expect(await d.capture(agent.tmuxPane)).not.toMatch(/skipped ahead|as json/)
    // The counter realigns on what the daemon expects, and typing carries on.
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    terminal.type('back in order\r')
    await ended
    await terminal.shows('answer 1: back in order')
    client.close()
  })

  it.each(engines)('%s: a paste lands whole, and Enter after it sends it', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `paste-${engine}`)
    const terminal = await Terminal.open(client, agent.id)
    await terminal.keyframe()
    const words = 'pasted ' + 'words '.repeat(400).trim()
    const started = client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    terminal.paste(words)
    await until('the paste to reach the composer', async () => (await d.capture(agent.tmuxPane)).includes('words words') || null, 15_000, 100)
    terminal.type('\r')
    expect((await started).payload?.userMessage).toBe(words)
    client.close()
  })

  it.each(engines)('%s: a resize reflows the pane and sends a fresh screen at the new size', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `resize-${engine}`)
    const terminal = await Terminal.open(client, agent.id)
    await terminal.keyframe()
    client.send('terminal_resize', { streamId: terminal.streamId, resizeSeq: 1, cols: 72, rows: 20 })
    const resized = await terminal.keyframe(1)
    expect([resized.cols, resized.rows]).toEqual([72, 20])
    expect(await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_width}x#{pane_height}')).toBe('72x20')
    // A stale resize (an older seq) is ignored; a size out of bounds is ignored; neither moves the pane.
    client.send('terminal_resize', { streamId: terminal.streamId, resizeSeq: 1, cols: 120, rows: 40 })
    client.send('terminal_resize', { streamId: terminal.streamId, resizeSeq: 2, cols: 0, rows: 9_999 })
    await turn(client, agent.id, 'after the resizes')
    expect(await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_width}x#{pane_height}')).toBe('72x20')
    client.close()
  })

  it('a second window takes the terminal over: the first is told who took it, and only the second types', async () => {
    const d = await fresh()
    const first = await LocalClient.connect(d)
    const second = await LocalClient.connect(d)
    const agent = await create(d, first, 'claude', 'takeover')
    const mine = await Terminal.open(first, agent.id, { client: { kind: 'desktop', name: 'First Mac' } })
    await mine.keyframe()
    const theirs = await Terminal.open(second, agent.id, { client: { kind: 'desktop', name: 'Second Mac' } })
    const lost = await mine.closed()
    expect(lost.payload).toMatchObject({ code: 'TERMINAL_TAKEN_OVER', takenBy: { name: 'Second Mac' } })
    expect(theirs.readOnly).toBe(false)
    await theirs.keyframe()
    // The first window's keystrokes name a stream that is gone: nothing reaches the pane.
    mine.type('from the first window\r')
    const ended = second.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    theirs.type('from the second window\r')
    await ended
    await theirs.shows('answer 1: from the second window')
    expect(await d.capture(agent.tmuxPane)).not.toContain('from the first window')
    expect(await attached(d, agent.tmuxPane)).toBe(1)
    first.close()
    second.close()
  })

  it('a window that asks not to take over watches instead: it sees the turn, and cannot type or resize', async () => {
    const d = await fresh()
    const desk = await LocalClient.connect(d)
    const phone = await LocalClient.connect(d)
    const agent = await create(d, desk, 'codex', 'watching')
    const driving = await Terminal.open(desk, agent.id, { client: { kind: 'desktop', name: 'Desk Mac' } })
    await driving.keyframe()
    const watching = await Terminal.open(phone, agent.id, { takeover: false })
    expect(watching.readOnly).toBe(true)
    expect(watching.ready.heldBy).toMatchObject({ name: 'Desk Mac' })
    await watching.keyframe()
    const ended = desk.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    driving.type('typed at the desk\r')
    await ended
    await watching.shows('answer 1: typed at the desk')
    // Both still hold their streams: watching took nothing from the desk.
    expect(desk.frames.some((frame) => frame.type === 'terminal_closed')).toBe(false)
    watching.type('typed by the watcher\r')
    phone.send('terminal_resize', { streamId: watching.streamId, resizeSeq: 1, cols: 50, rows: 15 })
    await watching.error('VIEW_ONLY')
    await turn(desk, agent.id, 'after the watcher tried')
    expect(await d.capture(agent.tmuxPane)).not.toContain('typed by the watcher')
    expect(await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_width}x#{pane_height}')).toBe('100x30')
    desk.close()
    phone.close()
  })

  it('one window holds four terminals at once, and each keystroke reaches only its own agent', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agents = []
    for (const [i, engine] of (['claude', 'codex', 'claude', 'codex'] as const).entries()) agents.push(await create(d, client, engine, `grid-${i}`))
    const terminals = await Promise.all(agents.map((agent) => Terminal.open(client, agent.id)))
    await Promise.all(terminals.map((terminal) => terminal.keyframe()))
    const ended = agents.map((agent) => client.next(isTurn('turn_ended', agent.id), 45_000, `turn_ended ${agent.id.slice(0, 8)}`))
    terminals.forEach((terminal, i) => terminal.type(`only for tile ${i}\r`, 3))
    await Promise.all(ended)
    for (const [i, terminal] of terminals.entries()) {
      await terminal.shows(`answer 1: only for tile ${i}`)
      for (const other of [0, 1, 2, 3].filter((j) => j !== i)) expect(terminal.output()).not.toContain(`only for tile ${other}`)
    }
    // Closing one leaves the other three working.
    client.send('terminal_close', { streamId: terminals[0].streamId })
    expect((await terminals[0].closed()).payload?.reason).toBe('client closed')
    const again = client.next(isTurn('turn_ended', agents[3].id), 45_000, 'turn_ended')
    terminals[3].type('still here\r')
    await again
    await terminals[3].shows('answer 2: still here')
    await until('the closed stream\'s tmux client to go', async () => (await attached(d, agents[0].tmuxPane)) === 0 || null, 5_000, 100)
    for (const agent of agents.slice(1)) expect(await attached(d, agent.tmuxPane)).toBe(1)
    client.close()
  })

  it('a window that goes without closing leaves no tmux client behind, and the next window opens cleanly', async () => {
    const d = await fresh()
    const gone = await LocalClient.connect(d)
    const agent = await create(d, gone, 'claude', 'gone-window')
    await (await Terminal.open(gone, agent.id)).keyframe()
    expect(await attached(d, agent.tmuxPane)).toBe(1)
    gone.close()
    await until('the stream\'s tmux client to go with its window', async () => (await attached(d, agent.tmuxPane)) === 0 || null, 15_000, 200)
    const next = await LocalClient.connect(d)
    const terminal = await Terminal.open(next, agent.id)
    expect(text((await terminal.keyframe()).bytes)).toContain(WELCOME.claude)
    expect(next.frames.some((frame) => frame.type === 'terminal_closed')).toBe(false)
    next.close()
  })

  it('a window that stops answering loses its stream after the heartbeat, and the agent goes on', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'frozen-window')
    const terminal = await Terminal.open(client, agent.id)
    await terminal.keyframe()
    // No terminal_alive, no keystroke: the window is frozen. The socket itself stays up.
    const closed = await terminal.closed(50_000)
    expect(closed.payload?.reason).toBe('heartbeat timeout')
    expect(client.closed).toBe(false)
    await turn(client, agent.id, 'after the stream timed out')
    await (await Terminal.open(client, agent.id)).keyframe()
    client.close()
  }, 120_000)

  it('a window kept alive by its heartbeat keeps the stream past the timeout', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'alive-window')
    const terminal = await Terminal.open(client, agent.id)
    await terminal.keyframe()
    const beat = setInterval(() => client.send('terminal_alive', { streamId: terminal.streamId }), 5_000)
    try {
      await new Promise((resolve) => setTimeout(resolve, 40_000))
      expect(client.frames.some((frame) => frame.type === 'terminal_closed')).toBe(false)
      // Syncs came while it was quiet, so the window knew the stream was live.
      expect(terminal.frames().some((frame) => frame.kind === TerminalBinaryKind.sync)).toBe(true)
      const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
      terminal.type('still mine\r')
      await ended
    } finally {
      clearInterval(beat)
    }
    client.close()
  }, 120_000)

  it.each(engines)('%s: a flood of output reaches a window that keeps up, every line in order', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `flood-${engine}`)
    const terminal = await Terminal.open(client, agent.id)
    await terminal.keyframe()
    const acking = setInterval(() => terminal.ack(), 20)
    try {
      await turn(client, agent.id, '!flood 1536')
      await terminal.shows('flooded 1536 KiB', 30_000)
    } finally {
      clearInterval(acking)
    }
    const lines = [...terminal.output().matchAll(/flood (\d{7}) /g)].map((match) => Number(match[1]))
    expect(lines.length).toBeGreaterThan(15_000)
    expect(lines.every((line, i) => line === i), 'a line lost, repeated or out of order').toBe(true)
    expect(client.frames.filter((frame) => frame.type === 'terminal_error')).toEqual([])
    client.close()
  })

  it('a window that stops drawing is cut off from a flood, alone: the agent, the daemon and other windows go on', async () => {
    const d = await fresh()
    const stuck = await LocalClient.connect(d)
    const other = await LocalClient.connect(d)
    const agent = await create(d, stuck, 'claude', 'stuck-renderer')
    const neighbour = await create(d, other, 'codex', 'neighbour')
    const frozen = await Terminal.open(stuck, agent.id)
    await frozen.keyframe()
    const fine = await Terminal.open(other, neighbour.id)
    await fine.keyframe()
    // The stuck window never acknowledges a frame, so its buffer fills and the daemon gives up on it.
    await turn(stuck, agent.id, '!flood 1536')
    const cut = await stuck.waitFor((frame) => frame.type === 'terminal_error'
      && ['TERMINAL_RENDER_STALLED', 'TERMINAL_OUTPUT_OVERFLOW'].includes(frame.payload?.code), 30_000, 'the stream cut off')
    expect(cut.payload?.streamId).toBe(frozen.streamId)
    await frozen.closed()
    expect(stuck.closed).toBe(false)
    const ended = other.next(isTurn('turn_ended', neighbour.id), 45_000, 'turn_ended')
    fine.type('the neighbour is unaffected\r')
    await ended
    await fine.shows('answer 1: the neighbour is unaffected')
    // Reopened, the stuck window gets the screen as it is now.
    const reopened = await Terminal.open(stuck, agent.id)
    expect(text((await reopened.keyframe()).bytes)).toContain('flooded 1536 KiB')
    expect(d.coresStarted()).toBe(1)
    stuck.close()
    other.close()
  })

  it('an agent stopped under an open terminal closes it, and once resumed it opens again', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'stopped-under')
    const terminal = await Terminal.open(client, agent.id)
    await terminal.keyframe()
    const stopped = await client.request('agent_delete', { agentId: agent.id }, 60_000)
    expect(stopped.error, JSON.stringify(stopped)).toBeUndefined()
    await terminal.closed()
    const refused = await Terminal.answer(client, { agentId: agent.id, cols: 100, rows: 30 })
    expect(refused.type).toBe('terminal_error')
    const resumed = await client.request('agent_resume', { agentId: agent.id }, 90_000)
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
    const back = await until('the agent to be back', async () => {
      const now = await row(client, agent.id)
      return now?.status === 'active' && now.sessionId ? now : null
    }, 60_000, 500)
    const again = await Terminal.open(client, back.id)
    expect(text((await again.keyframe()).bytes)).toContain(WELCOME.claude)
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    again.type('after the resume\r')
    await ended
    client.close()
  })

  it('a daemon restart under an open terminal: the window reconnects and the screen is still there', async () => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'daemon-restart')
    const terminal = await Terminal.open(client, agent.id)
    await terminal.keyframe()
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    terminal.type('before the restart\r')
    await ended
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    await until('the agent to be back', async () => (await row(client, agent.id))?.status === 'active' || null, 60_000, 500)
    const again = await Terminal.open(client, agent.id)
    expect(text((await again.keyframe()).bytes)).toContain('answer 1: before the restart')
    const next = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    again.type('after the restart\r')
    await next
    await again.shows('answer 2: after the restart')
    client.close()
  })

  it('opens that cannot be served are answered with why, and leave nothing open', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'bad-opens')
    const code = async (payload: Record<string, unknown>) => (await Terminal.answer(client, payload)).payload?.code
    expect(await code({ agentId: agent.id, cols: 100, rows: 30, protocolVersion: 2 })).toBe('TERMINAL_PROTOCOL_UNSUPPORTED')
    expect(await code({ agentId: 'no-such-agent', cols: 100, rows: 30 })).toBe('TERMINAL_AGENT_NOT_FOUND')
    expect(await code({ agentId: agent.id, cols: 0, rows: 30 })).toBe('TERMINAL_OPEN_INVALID')
    expect(await code({ agentId: agent.id, cols: 100, rows: 500 })).toBe('TERMINAL_OPEN_INVALID')
    expect(await code({ cols: 100, rows: 30 })).toBe('TERMINAL_OPEN_INVALID')
    expect(await attached(d, agent.tmuxPane)).toBe(0)
    // Frames naming a stream that does not exist do nothing at all.
    for (const type of ['terminal_ack', 'terminal_alive', 'terminal_resize', 'terminal_close', 'terminal_resync', 'terminal_scroll']) {
      client.send(type, { streamId: '00000000-0000-4000-8000-000000000000', lastSeq: 3, resizeSeq: 9, cols: 80, rows: 24, direction: 'up', lines: 3 })
    }
    client.sendBinary({ kind: TerminalBinaryKind.input, streamId: '00000000-0000-4000-8000-000000000000', seq: 0, compressed: false, bytes: Buffer.from('ghost\r') })
    await turn(client, agent.id, 'after the bad opens')
    expect(await d.capture(agent.tmuxPane)).not.toContain('ghost')
    expect(client.closed).toBe(false)
    client.close()
  })

  it('a garbage binary frame ends only the connection that sent it', async () => {
    const d = await fresh()
    const good = await LocalClient.connect(d)
    const agent = await create(d, good, 'codex', 'garbage-frame')
    const terminal = await Terminal.open(good, agent.id)
    await terminal.keyframe()
    const bad = await LocalClient.connect(d)
    bad.sendRaw(Buffer.from('HTRL not really a terminal frame'), true)
    await until('the bad connection to be closed', () => bad.closed || null, 10_000, 50)
    expect(bad.closeCode).toBe(4400)
    const ended = good.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    terminal.type('the good window is fine\r')
    await ended
    expect(good.closed).toBe(false)
    good.close()
  })
})
