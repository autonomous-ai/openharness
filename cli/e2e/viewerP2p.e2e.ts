/** A harness viewer's rendered surface over a real werift `viewer-v1` channel: the real daemon, the fake
 *  backend, and a paired phone (harness/p2pPhone.ts) that opens the surface on its viewer channel, takes
 *  the pushed JPEG frames as sealed binary parts, answers over the relay, and falls back to the WS
 *  long-poll when its viewer channel dies, while its terminal channel keeps working. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFailed } from 'vitest'
import { viewerBrowser } from '../src/sharing/viewer.js'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { surfaceStreamId } from '../src/lib/viewerFrameParts.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { P2pPhone } from './harness/p2pPhone.js'

const HARNESS = 'e2e/sketch'
// Ticks twice a second, so the screencast always has a next frame to send (a static page sends one, then
// nothing): the push's credit, not the page, is what holds frames back.
const PAGE = `<!doctype html><body style="margin:0;background:#c00" onclick="document.body.style.background='#0c0'">
<div id=n style="font:40px sans-serif;color:#fff">0</div><script>let n=0;setInterval(()=>{document.getElementById('n').textContent=++n},500)</script></body>`

/** A harness whose viewer serves PAGE, installed in the daemon's harness folder (read on each agent_create). */
function installHarness(d: IsolatedDaemon): void {
  const dir = join(d.env.DSH_DIR!, 'e2e', 'sketch')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'viewer.mjs'), [
    "import { createServer } from 'node:http'",
    `createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(${JSON.stringify(PAGE)}) })`,
    "  .listen(Number(process.env.HARNESS_VIEWER_PORT), '127.0.0.1')",
  ].join('\n') + '\n')
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({
    spec: 1, id: HARNESS, name: 'Sketch', engine: 'claude',
    viewer: { command: `'${process.execPath}' '${join(dir, 'viewer.mjs')}'`, url: 'http://127.0.0.1:${port}/' },
  }))
  writeFileSync(join(d.env.DSH_DIR!, 'installed.json'), JSON.stringify([
    { id: HARNESS, dir, source: dir, ref: null, commit: null, linked: false, installedAt: Date.now() },
  ]))
}

async function withPhone(run: (world: PhoneMachine, desk: LocalClient, phone: P2pPhone) => Promise<void>): Promise<void> {
  const world = await startPhoneMachine()
  let desk: LocalClient | undefined
  let phone: P2pPhone | undefined
  onTestFailed(() => {
    console.log(`---- daemon log\n${world.machine.daemon.log().split('\n').slice(-200).join('\n')}`)
    console.log(`---- phone errors\n${JSON.stringify(phone?.errors)}`)
  })
  try {
    desk = await LocalClient.connect(world.machine.daemon, { machineId: world.machine.machineId })
    phone = await P2pPhone.open(world)
    await phone.negotiate()
    await until('the viewer channel to open', () => phone!.peer.viewerReady || null, 15_000)
    await run(world, desk, phone)
    expect(phone.errors).toEqual([])
  } finally {
    await phone?.close()
    desk?.close()
    await world.close()
  }
}

it('advertises the viewer channel in its welcome and accepts viewer-v1 beside terminal-v1', () => withPhone(async (_world, _desk, phone) => {
  expect(phone.p2pViewerVersion).toBe(1)
  expect(phone.peer.isReady).toBe(true)
}), 120_000)

// Opt-in like interactiveViewer.chrome.spec.ts: frames need a real Chrome, and CI's fast shards must not launch it.
describe.skipIf(!(process.env.RUN_REAL_CHROME_VIEWER === '1' && viewerBrowser()))('a viewer surface pushed over P2P (real Chrome)', () => {
  it('pushes frames under credit, answers input over the relay, and falls back to the WS long-poll when its channel dies', () => withPhone(async (world, desk, phone) => {
    const daemon = world.machine.daemon
    installHarness(daemon)
    const cwd = join(daemon.projectsDir, 'sketch')
    mkdirSync(cwd)
    const created = await desk.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, dsh: HARNESS }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId = created.agent.id as string
    await until('the harness viewer URL', async () => ((await desk.request('agents_list', { includeStopped: true })).agents as Array<Record<string, any>>)
      .find(a => a.id === agentId && a.sessionId && typeof a.viewerUrl === 'string'), 60_000, 250)

    const surfaceId = randomBytes(16).toString('hex')
    const size = { surfaceId, agentId, width: 400, height: 300, dark: false }
    const fromRelay = (type: string, since: number) => phone.frames.slice(since)
      .filter(({ frame }) => frame.type === type && frame.payload?.surfaceId === surfaceId)
    const failure = () => fromRelay('surface_error', 0).map(({ frame }) => JSON.stringify(frame.payload)).join(' ')
    const frameAfter = (seq: number, what: string) => until(what, () => {
      if (fromRelay('surface_error', 0).length) throw new Error(`surface_error: ${failure()}`)
      return phone.viewerFrames.find(f => f.seq > seq) ?? null
    }, 30_000, 50)

    // 2. Opened on the viewer channel: the first whole frame arrives over P2P, binary, a JPEG.
    // The open's id: the machine echoes it on every answer about this push.
    phone.sendViewer('surface_open', { ...size, open: 'e2e-1' })
    const first = await frameAfter(0, 'the first pushed frame')
    expect(first.streamId).toBe(surfaceStreamId(surfaceId))
    expect([...first.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8])
    expect(first).toMatchObject({ width: 400, height: 300, scale: 1 })

    // Two frames in flight, then nothing until an ack: the page ticks, so only the credit holds the third back.
    const second = await frameAfter(first.seq, 'the second pushed frame')
    await new Promise(resolve => setTimeout(resolve, 2_000))  // well under the 5 s ack timeout
    expect(phone.viewerFrames.filter(f => f.seq > second.seq)).toEqual([])

    // 3. An ack returns credit: another frame.
    phone.sendViewer('surface_ack', { surfaceId, seq: second.seq })
    const third = await frameAfter(second.seq, 'a frame after the ack')

    // A click: its answer comes over the relay, and a frame with a higher seq follows on the channel.
    const sinceInput = phone.frames.length
    phone.sendViewer('surface_ack', { surfaceId, seq: third.seq })
    phone.sendViewer('surface_input', { ...size, open: 'e2e-1', input: 'click-1', events: [
      { type: 'pointer', event: 'mousePressed', x: .5, y: .5, buttons: 1, button: 'left', clickCount: 1, modifiers: 0 },
      { type: 'pointer', event: 'mouseReleased', x: .5, y: .5, buttons: 0, button: 'left', clickCount: 1, modifiers: 0 },
    ] })
    const state = await until('surface_state for the click', () => {
      if (fromRelay('surface_error', sinceInput).length) throw new Error(`surface_error: ${failure()}`)
      return fromRelay('surface_state', sinceInput).find(({ frame }) => frame.payload?.input === 'click-1') ?? null
    }, 30_000, 50)
    expect(state.transport).toBe('relay')
    expect(state.frame.payload).toMatchObject({ surfaceId, input: 'click-1', editable: false, open: 'e2e-1' })
    const stateSeq = Number(state.frame.payload!.seq)
    phone.sendViewer('surface_ack', { surfaceId, seq: phone.viewerFrames.at(-1)!.seq })
    const afterClick = await frameAfter(stateSeq, 'a frame after the click')
    expect(afterClick.seq).toBeGreaterThan(stateSeq)

    // The relay never carried a frame: no surface frame type, and no JPEG bytes.
    const connId = world.backend.webConnections(world.machine.machineId).at(-1)!
    const relayed = [...world.backend.webSent.get(connId) ?? [], ...world.backend.webReceived.get(connId) ?? []]
    expect(relayed.some(f => /^surface_(open|input|ack)$/.test(f.type ?? ''))).toBe(false)
    expect(relayed.filter(f => f.type === 'surface_state').every(f => f.payload?.__e2e)).toBe(true)

    // 4. The viewer channel dies: the same surface answers its WS long-poll from the last frame on.
    const lastSeq = phone.viewerFrames.at(-1)!.seq
    phone.closeViewer()
    await until('the viewer channel to close', () => !phone.peer.viewerReady || null, 10_000, 50)
    const requestId = randomUUID()
    phone.send('viewer_surface', { requestId, ...size, op: 'frame', after: lastSeq }, 'relay')
    const answer = await until('the WS long-poll answer', () => phone.frames.find(({ frame }) =>
      frame.type === 'viewer_surface_result' && frame.payload?.requestId === requestId) ?? null, 30_000, 50)
    expect(answer.transport).toBe('relay')
    expect(answer.frame.payload?.error, JSON.stringify(answer.frame.payload)).toBeUndefined()
    expect(answer.frame.payload).toMatchObject({ mime: 'image/jpeg', width: 400, height: 300 })
    expect(Number(answer.frame.payload!.seq)).toBeGreaterThan(lastSeq)
    expect([...Buffer.from(String(answer.frame.payload!.data), 'base64').subarray(0, 2)]).toEqual([0xff, 0xd8])

    // The terminal channel on the same peer connection still carries a terminal stream.
    expect(phone.peer.isReady).toBe(true)
    const openId = randomUUID()
    const since = phone.binaries.length
    phone.send('terminal_open', { requestId: openId, protocolVersion: 3, agentId, cols: 100, rows: 30 }, 'p2p')
    const ready = await until('terminal_ready over the peer channel', () => phone.frames.find(({ frame }: { frame: Frame }) =>
      ['terminal_ready', 'terminal_error'].includes(frame.type) && frame.payload?.requestId === openId) ?? null, 30_000)
    expect(ready.frame.type, JSON.stringify(ready.frame)).toBe('terminal_ready')
    expect(ready.transport).toBe('p2p')
    const keyframe = await until('the P2P keyframe', () => phone.binaries.slice(since).find(({ frame }) =>
      frame.streamId === ready.frame.payload!.streamId && frame.kind === TerminalBinaryKind.keyframe) ?? null, 20_000)
    expect(keyframe.transport).toBe('p2p')
  }), 180_000)
})
