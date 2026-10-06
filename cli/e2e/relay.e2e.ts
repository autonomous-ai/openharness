/**
 * The relay link under stress, as a phone sees it (round 34). A signed-in daemon on the fake backend
 * (harness/fakeBackend.ts), a phone paired with it reaching it through the fake relay with an end-to-end
 * encrypted session (harness/relayPhone.ts, the CLI's own relay client role), and the desktop window on
 * the machine itself. Then the relay misbehaves:
 * - it drops mid-turn and comes back;
 * - the backend restarts;
 * - it is slow, by seconds;
 * - it sends garbage, or replays an old sealed frame;
 * - and the daemon restarts while the phone is connected.
 *
 * What correct is, from the code:
 * - The phone resyncs after every reconnect: it opens a new session and re-reads the conversation
 *   (`session_get`). Every message is in that history once.
 * - Nothing the daemon sends after that re-read announces, as live news, a turn already in it: a phone
 *   would show it twice (notify a turn that ended long ago, open a turn that is over).
 * - A message the phone tries while it has no session is refused at once and never appears. One sent
 *   with a session appears once.
 * - The relay is not trusted: garbage costs it nothing but the frame, a replayed sealed frame never
 *   becomes a second turn, and a frame sealed for a dead session opens nowhere.
 *
 * Nothing here reaches beyond this machine: the daemon's every server setting is the fake backend's,
 * and `assertLocalOnly` refuses one that is not.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { until, type IsolatedDaemon } from './harness/daemon.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { RelayPhone, type PhoneFrame } from './harness/relayPhone.js'

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)

/** A Claude Code agent started from the desktop window, bound to its conversation. */
async function boundAgent(daemon: IsolatedDaemon, desk: LocalClient, name: string): Promise<{ agentId: string; sessionId: string }> {
  const cwd = join(daemon.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const created = await desk.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const agentId: string = created.agent.id
  const sessionId = await until('the agent to bind its conversation', async () => (await row(desk, agentId))?.sessionId || null, 45_000, 500)
  return { agentId, sessionId }
}

const isTurn = (type: string, agentId: string) => (frame: Frame | PhoneFrame) => frame.type === type && frame.agentId === agentId

/** A turn from the desktop window, to its end. */
async function deskTurn(desk: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = desk.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  desk.send('message', { agentId, content })
  await ended
}

/** What the phone shows of a conversation after it re-reads it: each message asked, oldest first. */
async function history(phone: RelayPhone, sessionId: string): Promise<string[]> {
  const page = await phone.request('session_get', { sessionId, limit: 500 }, 30_000)
  expect(page.error, JSON.stringify(page)).toBeUndefined()
  return (page.events as Array<{ type: string; payload: Record<string, any> }>)
    .filter((event) => event.type === 'user_message')
    .map((event) => String(event.payload.content ?? event.payload.text ?? ''))
}

/** Each message once, in this order, and nothing else. */
const once = (seen: string[], expected: string[]) => {
  for (const message of expected) expect(seen.filter((m) => m === message), `"${message}" in ${JSON.stringify(seen)}`).toHaveLength(1)
}

/** The live turn news the phone got after frame `from`: what it would show as happening now. */
const liveNews = (phone: RelayPhone, agentId: string, from: number) => phone.frames.slice(from)
  .filter((frame) => (frame.type === 'turn_started' || frame.type === 'turn_ended') && frame.agentId === agentId && !frame.replay && !frame.payload?.replay)

describe('the relay link under stress, as a phone sees it', () => {
  let world: PhoneMachine | undefined
  let phone: RelayPhone | undefined
  let desk: LocalClient | undefined
  afterEach(async () => {
    phone?.close()
    desk?.close()
    await world?.close()
    world = undefined; phone = undefined; desk = undefined
  })

  const fresh = async (env: Record<string, string> = {}) => {
    const w = await startPhoneMachine({ env })
    world = w
    const { backend, machine } = w
    onTestFailed(() => {
      console.log(`---- daemon log\n${machine.daemon.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- fake backend saw\n${backend.seen.slice(-40).join('\n')}`)
      console.log(`---- the phone opened\n${phone?.frames.map((f) => `${f.session}:${f.type}${f.replay || f.payload?.replay ? '(replay)' : ''}`).join(' ') ?? '(no phone)'}`)
    })
    await until('the machine to be connected to the backend', () => backend.nodeUp(machine.machineId) || null, 30_000)
    desk = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const agent = await boundAgent(machine.daemon, desk, 'on-a')
    phone = new RelayPhone({ backend, machineId: machine.machineId, identity: w.phone.identity, machinePub: machine.identity.pub, token: w.phone.token })
    await phone.open()
    return { w, backend, machine, desk, phone, ...agent }
  }
  /** The phone back: once the machine is on the relay again, a new session, retried until it opens. */
  const reopen = async (w: PhoneMachine, p: RelayPhone) => {
    await until('the machine to be back on the relay', () => w.backend.nodeUp(w.machine.machineId) || null, 60_000, 200)
    await until('the phone to open a new session', async () => { await p.open(10_000); return true }, 60_000, 500)
  }

  it('a turn from the phone runs, and its news reaches the phone once, sealed', async () => {
    const { phone, agentId, sessionId, backend, machine } = await fresh()
    const started = phone.next(isTurn('turn_started', agentId), 30_000, 'turn_started on the phone')
    const ended = phone.next(isTurn('turn_ended', agentId), 30_000, 'turn_ended on the phone')
    expect(phone.send('message', { agentId, content: 'from the phone' })).toBe(true)
    expect((await started).payload?.userMessage).toBe('from the phone')
    await ended
    once(await history(phone, sessionId), ['from the phone'])
    // The relay saw only sealed payloads both ways.
    const relayed = [...(backend.webSent.get(phone.connId!) ?? []), ...(backend.webReceived.get(phone.connId!) ?? [])]
    expect(relayed.filter((f) => f.type === 'message' || f.type === 'turn_started').every((f) => (f.payload as any)?.__e2e)).toBe(true)
    expect(JSON.stringify(relayed)).not.toContain('from the phone')
    expect(machine.daemon.log()).not.toMatch(/getaddrinfo|ENOTFOUND|autonomous\.ai/)
  })

  it('the relay drops mid-turn and comes back: no turn lost or shown twice, and a message tried meanwhile is refused visibly', async () => {
    const { w, phone, desk, agentId, sessionId, backend } = await fresh()
    const started = phone.next(isTurn('turn_started', agentId), 30_000, 'the slow turn starting')
    expect(phone.send('message', { agentId, content: '!slow 4000 mid-turn' })).toBe(true)
    await started
    // A message the relay is still holding (it is slow for a moment) when it goes: both its ends drop,
    // and nothing connects for a while.
    const deskSawEnd = desk.next(isTurn('turn_ended', agentId), 30_000, 'the slow turn ending')
    backend.latencyMs = 1_500
    expect(phone.send('message', { agentId, content: 'in flight when the relay drops' })).toBe(true)
    backend.goDown()
    backend.latencyMs = 0
    await until('the phone to know it has no session', () => !phone.ready || null, 10_000, 50)
    // Tried while down: refused, visibly, right away.
    expect(phone.send('message', { agentId, content: 'tried while the relay is down' })).toBe(false)
    await expect(phone.request('agents_list')).rejects.toThrow(/no session/)
    // The turn ends meanwhile, and the desktop window starts and finishes another one.
    await deskSawEnd
    await deskTurn(desk, agentId, 'from the desk while the relay is down')
    backend.comeUp()
    await reopen(w, phone)
    const resynced = phone.frames.length
    const asked = await history(phone, sessionId)
    once(asked, ['!slow 4000 mid-turn', 'from the desk while the relay is down'])
    expect(asked).not.toContain('tried while the relay is down')
    // Lost in the relay: the daemon never had it. No message is acknowledged end to end, so reading the
    // conversation again is the only way the phone learns it was not delivered (listed in the report).
    expect(asked).not.toContain('in flight when the relay drops')
    // A while later: nothing announced as live what the phone already read.
    await new Promise((done) => setTimeout(done, 3_000))
    expect(liveNews(phone, agentId, resynced)).toEqual([])
    // And the link works: a new turn from the phone, its news once.
    const next = phone.next(isTurn('turn_ended', agentId), 30_000, 'a turn after the relay came back')
    expect(phone.send('message', { agentId, content: 'after the relay came back' })).toBe(true)
    await next
    once(await history(phone, sessionId), ['!slow 4000 mid-turn', 'from the desk while the relay is down', 'after the relay came back'])
    expect(liveNews(phone, agentId, resynced).filter((f) => f.type === 'turn_ended')).toHaveLength(1)
  })

  it('the backend restarts: the daemon and the phone come back to it, and nothing is lost or doubled', async () => {
    const { w, phone, desk, agentId, sessionId, backend, machine } = await fresh()
    const ended = phone.next(isTurn('turn_ended', agentId), 30_000, 'a turn before the restart')
    expect(phone.send('message', { agentId, content: 'before the restart' })).toBe(true)
    await ended
    const restarting = backend.restart(3_000)
    await until('the phone to know it has no session', () => !phone.ready || null, 10_000, 50)
    await deskTurn(desk, agentId, 'from the desk during the restart')
    await restarting
    await reopen(w, phone)
    const resynced = phone.frames.length
    once(await history(phone, sessionId), ['before the restart', 'from the desk during the restart'])
    await new Promise((done) => setTimeout(done, 3_000))
    expect(liveNews(phone, agentId, resynced)).toEqual([])
    const after = phone.next(isTurn('turn_ended', agentId), 30_000, 'a turn after the restart')
    expect(phone.send('message', { agentId, content: 'after the restart' })).toBe(true)
    await after
    expect(machine.daemon.coresStarted()).toBe(1)
  })

  it('the relay is slow by seconds: the session opens, requests are answered, and turns arrive in order, once', async () => {
    const w = await startPhoneMachine()
    world = w
    const { backend, machine } = w
    onTestFailed(() => { console.log(`---- daemon log\n${machine.daemon.log().split('\n').slice(-120).join('\n')}`) })
    await until('the machine to be connected to the backend', () => backend.nodeUp(machine.machineId) || null, 30_000)
    desk = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const { agentId, sessionId } = await boundAgent(machine.daemon, desk, 'slow-relay')
    backend.latencyMs = 2_500
    phone = new RelayPhone({ backend, machineId: machine.machineId, identity: w.phone.identity, machinePub: machine.identity.pub, token: w.phone.token })
    await phone.open(30_000)
    const listed = await phone.request('agents_list', {}, 30_000)
    expect(listed.agents.map((agent: Record<string, any>) => agent.id)).toContain(agentId)
    const from = phone.frames.length
    for (const content of ['one', 'two', 'three']) {
      const ended = phone.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
      expect(phone.send('message', { agentId, content })).toBe(true)
      await ended
    }
    const starts = phone.frames.slice(from).filter((f) => f.type === 'turn_started' && f.agentId === agentId).map((f) => f.payload?.userMessage)
    expect(starts).toEqual(['one', 'two', 'three'])
    expect(phone.frames.slice(from).filter((f) => f.type === 'turn_ended' && f.agentId === agentId)).toHaveLength(3)
    once(await history(phone, sessionId), ['one', 'two', 'three'])
    expect(backend.nodeUp(machine.machineId)).toBe(true)
  })

  it('the relay sends garbage or replays an old sealed frame: no second turn, no crash, the link goes on', async () => {
    const { w, phone, desk, agentId, sessionId, backend, machine } = await fresh()
    const ended = phone.next(isTurn('turn_ended', agentId), 30_000, 'the original turn')
    expect(phone.send('message', { agentId, content: 'said once' })).toBe(true)
    await ended
    const original = phone.sealed.find((frame) => frame.type === 'message')!
    const connId = phone.connId!
    // Garbage towards the daemon, on the phone's connection and on the backend's own address.
    for (const garbage of ['not json', '{"t":"down"}', '{"t":"down","connId":"x","frame":null}', JSON.stringify({ t: 'down', connId, frame: { type: 'message' } })]) {
      expect(backend.injectDown(machine.machineId, connId, garbage)).toBe(true)
    }
    backend.injectDown(machine.machineId, connId, { type: 'message', payload: { agentId, content: 'unsealed from the relay' } })
    backend.injectDown(machine.machineId, connId, { type: 'message', payload: { __e2e: { v: 1, k: 'p', n: 'x', ct: 7 } } })
    backend.injectDown(machine.machineId, connId, { type: 'message', payload: { __e2e: { v: 1, k: 'p', n: 999, ct: 'AAAA' } } })
    backend.injectDown(machine.machineId, connId, { type: '__clients', payload: { commander: 9 } })
    backend.injectDown(machine.machineId, connId, { type: 'machine_meta', payload: { name: 'renamed by the relay' } })
    backend.injectDown(machine.machineId, connId, { type: 'e2e_hello', payload: { identityPub: 'AAAA', ephPub: 'AAAA', sig: 'AAAA' } })
    // The phone's own sealed message, replayed on its connection: the session has seen that counter.
    for (let n = 0; n < 3; n++) backend.injectDown(machine.machineId, connId, original)
    // Garbage and an old sealed broadcast towards the phone: dropped there, never shown.
    const capturedStart = (backend.webReceived.get(connId) ?? []).find((frame) => frame.type === 'turn_started')!
    const droppedBefore = phone.dropped
    backend.injectUp(connId, 'not json either')
    backend.injectUp(connId, capturedStart)
    await until('the phone to drop what the relay injected', () => phone.dropped >= droppedBefore + 2 || null, 10_000, 100)
    // Nothing became a turn: the conversation still has the message once.
    await new Promise((done) => setTimeout(done, 3_000))
    once(await history(phone, sessionId), ['said once'])
    expect(await history(phone, sessionId)).not.toContain('unsealed from the relay')
    // Unsealed client frames are refused, and the backend's own frames on a client's address ignored.
    expect(machine.daemon.log()).toContain('refusing plaintext "message" from relay')
    expect(machine.daemon.log()).toContain('ignoring "machine_meta" from relay')
    expect(machine.daemon.log()).toContain('ignoring "__clients" from relay')
    // The phone comes back on a new connection; its old sealed message replayed there opens nowhere.
    phone.drop()
    await reopen(w, phone)
    backend.injectDown(machine.machineId, phone.connId!, original)
    // And a broadcast sealed before, replayed to the new session, is not shown as news.
    const resynced = phone.frames.length
    backend.injectUp(phone.connId!, capturedStart)
    await new Promise((done) => setTimeout(done, 3_000))
    once(await history(phone, sessionId), ['said once'])
    expect(liveNews(phone, agentId, resynced), 'an old sealed turn_started replayed to a new session').toEqual([])
    // The link goes on, and the daemon never restarted.
    const after = phone.next(isTurn('turn_ended', agentId), 30_000, 'a turn after the garbage')
    expect(phone.send('message', { agentId, content: 'after the garbage' })).toBe(true)
    await after
    expect(machine.daemon.coresStarted()).toBe(1)
    expect(await row(desk, agentId)).toMatchObject({ id: agentId })
  })

  it('the daemon restarts under a phone that keeps its socket, as the phone app does: what it sends on its dead session is refused visibly', async () => {
    const { w, machine, agentId, sessionId } = await fresh()
    // Its own phone: one that keeps its socket and session through the machine going offline.
    phone!.close()
    const keeper = new RelayPhone({ backend: w.backend, machineId: machine.machineId, identity: w.phone.identity, machinePub: machine.identity.pub, token: w.phone.token, keepSessionWhenOffline: true })
    phone = keeper
    await keeper.open()
    desk!.close()
    const back = keeper.next((frame) => frame.type === 'node_status' && frame.payload?.online === true, 60_000, 'node_status online on the phone')
    await machine.daemon.restart()
    await back
    expect(keeper.ready).toBe(true)
    // Its session is from the daemon's last process. A message sent on it must not vanish silently, and
    // a request must not wait out its timeout: the daemon says the session is gone.
    const told = keeper.next((frame) => frame.type === 'e2e_session_unknown', 10_000, 'the daemon saying the session is gone')
    expect(keeper.send('message', { agentId, content: 'on a session the daemon no longer has' })).toBe(true)
    const refused = await told
    expect(refused.payload).toMatchObject({ refused: { type: 'message' } })
    expect(keeper.ready).toBe(false)
    // The phone opens a new session and sends again: delivered, once.
    await reopen(w, keeper)
    const ended = keeper.next(isTurn('turn_ended', agentId), 45_000, 'the message sent again')
    expect(keeper.send('message', { agentId, content: 'sent again on a new session' })).toBe(true)
    await ended
    const asked = await history(keeper, sessionId)
    expect(asked).not.toContain('on a session the daemon no longer has')
    once(asked, ['sent again on a new session'])
  })

  it('the daemon restarts while the phone is connected: the phone is told, opens a new session, and nothing is lost or doubled', async () => {
    const { w, phone, desk, agentId, sessionId, machine } = await fresh()
    const ended = phone.next(isTurn('turn_ended', agentId), 30_000, 'a turn before the restart')
    expect(phone.send('message', { agentId, content: 'before the daemon restarts' })).toBe(true)
    await ended
    desk.close()
    const offline = phone.next((frame) => frame.type === 'node_status' && frame.payload?.online === false, 30_000, 'node_status offline on the phone')
    await machine.daemon.restart()
    await offline
    expect(phone.ready).toBe(false)
    await reopen(w, phone)
    const resynced = phone.frames.length
    once(await history(phone, sessionId), ['before the daemon restarts'])
    const after = phone.next(isTurn('turn_ended', agentId), 45_000, 'a turn after the daemon restarted')
    expect(phone.send('message', { agentId, content: 'after the daemon restarted' })).toBe(true)
    await after
    once(await history(phone, sessionId), ['before the daemon restarts', 'after the daemon restarted'])
    expect(liveNews(phone, agentId, resynced).filter((f) => f.type === 'turn_ended')).toHaveLength(1)
  })
})
