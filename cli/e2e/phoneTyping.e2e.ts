/**
 * PHONE_TYPING=1: a phone's keystroke → echo over its P2P channel, idle and while another pane on the same
 * connection is taking a keyframe. PHONE_TYPING_REPORT=<file> writes JSON; PHONE_TYPING_N=<keys> (default 60).
 *
 * Why it exists: a remote client's keystrokes waited in its connection's line behind every request it made —
 * another pane's resize keyframe (Codex: ~200ms at the median, it waits for its repaint), an `agents_list`, a
 * `session_get` — while a window on this computer never did (backendSocket.ts `enqueueTerminalBinary`). The
 * desktop's typing is measured by typingLatency.e2e.ts; this is the phone's. Run alone: the host's load is the noise.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, until } from './harness/daemon.js'
import { startPhoneMachine } from './harness/fleet.js'
import { P2pPhone } from './harness/p2pPhone.js'

const N = Number(process.env.PHONE_TYPING_N ?? 60)
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const key = (i: number) => (i % 2 === 0 ? 'x' : '\x7f')

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1)
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: +sorted[sorted.length - 1].toFixed(1) }
}

it.runIf(process.env.PHONE_TYPING === '1')('a phone\'s typing latency over P2P, idle and beside another pane\'s keyframe', async () => {
  const world = await startPhoneMachine()
  const { machine } = world
  let desk: LocalClient | undefined
  let phone: P2pPhone | undefined
  const alive: NodeJS.Timeout[] = []
  try {
    desk = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const create = async (engine: 'claude' | 'codex', folder: string) => {
      const cwd = join(machine.daemon.projectsDir, folder)
      mkdirSync(cwd, { recursive: true })
      const created = await desk!.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
      if (created.error) throw new Error(JSON.stringify(created))
      return until(`${folder} active`, async () => {
        const rows = (await desk!.request('agents_list', { includeStopped: true }, 30_000)).agents as Array<Record<string, any>>
        return rows.find((row) => row.id === created.agent.id && row.sessionId && row.status === 'active') ?? null
      }, 60_000, 500)
    }
    const target = await create('claude', 'typed-into')
    const beside = await create('codex', 'beside')
    phone = await P2pPhone.open(world)
    await phone.negotiate()
    const open = async (agentId: string, rows: number) => {
      const requestId = `open-${Math.random().toString(36).slice(2)}`
      phone!.send('terminal_open', { requestId, protocolVersion: 3, agentId, cols: 100, rows }, 'p2p')
      const ready = await until('terminal_ready', () => phone!.frames.find(({ frame }) => frame.type === 'terminal_ready' && frame.payload?.requestId === requestId), 30_000)
      const streamId = ready.frame.payload!.streamId as string
      await until('the opening keyframe', () => phone!.binaries.find(({ frame }) => frame.streamId === streamId && frame.kind === TerminalBinaryKind.keyframe), 30_000)
      return streamId
    }
    const typed = await open(target.id, 30)
    const other = await open(beside.id, 30)
    alive.push(setInterval(() => { for (const streamId of [typed, other]) phone!.send('terminal_alive', { streamId }, 'p2p') }, 5_000))
    await sleep(2_000)

    let seq = 0
    let resizeSeq = 0
    const measure = async (besideKeyframe: boolean) => {
      const out: number[] = []
      for (let i = 0; i < N; i++) {
        if (besideKeyframe) phone!.send('terminal_resize', { streamId: other, resizeSeq: resizeSeq++, cols: 100, rows: i % 2 === 0 ? 24 : 30 }, 'p2p')
        const since = phone!.binaries.length
        const started = performance.now()
        phone!.sendBinary({ kind: TerminalBinaryKind.input, streamId: typed, seq: seq++, compressed: false, bytes: Buffer.from(key(i)) })
        const echo = await until('the echo', () => phone!.binaries.slice(since).find(({ frame }) => frame.streamId === typed && frame.kind === TerminalBinaryKind.output), 10_000, 1)
        out.push(performance.now() - started)
        phone!.send('terminal_ack', { streamId: typed, lastSeq: echo.frame.seq }, 'p2p')
        const last = phone!.binaries.filter(({ frame }) => frame.streamId === other).at(-1)
        if (last) phone!.send('terminal_ack', { streamId: other, lastSeq: last.frame.seq }, 'p2p')
        await sleep(besideKeyframe ? 450 : 25)
      }
      return stats(out)
    }
    const idle = await measure(false)
    const besideKeyframe = await measure(true)
    const report = { schema: 1, at: new Date().toISOString(), keys: N, idle, besideKeyframe, errors: phone.errors }
    console.log(`phone typing latency: ${JSON.stringify(report)}`)
    if (process.env.PHONE_TYPING_REPORT) writeFileSync(resolve(CLI_ROOT, process.env.PHONE_TYPING_REPORT), `${JSON.stringify(report, null, 2)}\n`)
  } finally {
    for (const timer of alive) clearInterval(timer)
    await phone?.close().catch(() => {})
    desk?.close()
    await world.close()
  }
}, 600_000)
