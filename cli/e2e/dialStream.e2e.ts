/**
 * The `dial` stream (docs/specs/2026-11-16-orca-device-plugin.md), on the real daemon: fake dials on the desk turn to
 * Claude Code sessions outside Harness (harness/inOrca.ts), and the stream says whether a dial is attached and which
 * agent it shows. The stream is found as Orca's Harness Device plugin finds it: the real `harness device orca link`,
 * under the throwaway daemon's environment only, prints the devices' socket, and the test opens it there.
 *
 * Every agent is listed before the first focus. After a ring push that re-asserted the focus, a session drops a dial's
 * other `focus` until it hears that focus echoed (cableSession.ts, `expectedAppFocusEcho`), and the fake dial echoes
 * nothing: each move is sent again every 2 s until its line is read.
 *
 * Orca's plugin's own loop (plugins/harness-device-orca/src/dial.ts, with Node's inputs) runs too, in a process whose
 * whole environment is the throwaway home and a bare PATH (harness/pluginDial.ts): it finds this daemon through a
 * launcher shim in that home, and nothing on this Mac's PATH.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { request, type ClientRequest } from 'node:http'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { FakeDial } from './harness/fakeDial.js'
import { InOrca } from './harness/inOrca.js'
import type { DialState } from '../../plugins/harness-device-orca/src/protocol.ts'

const run = promisify(execFile)

const ORCA = 'com.stablyai.orca'
/** The everyday daemon's port: a `link` under test that reached it would hand the test this Mac's devices' socket. */
const EVERYDAY_PORT = '18473'
/** What Orca's plugin sends to open the stream: 30 bytes. */
const OPEN = '{"type":"dial","standby":true}'
const DETACHED = '{"attached":false}'
const NO_AGENT = '{"attached":true,"agent":null}'

// How the CLI is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

interface Link { daemon: boolean; devicesSocket?: string; devicesReady: boolean }

/** The plugin's loop, running. */
interface Loop {
  /** Each state it told, in order. */
  states: DialState[]
  /** Its log lines. */
  logs: string[]
  /** Ends its stdin, which stops it; its exit code. */
  stop(): Promise<number | null>
}

interface Stream {
  status: number | undefined
  /** Its lines so far, in the order they came. */
  lines: string[]
  /** Whether the listener or the test has closed it. */
  closed(): boolean
  close(): void
}

describe('the dial stream, for Orca\'s Harness Device plugin', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  const requests: ClientRequest[] = []
  afterEach(async () => {
    for (const sent of requests.splice(0)) sent.destroy()
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  /**
   * A daemon of its own, with a desk it finds its dials on, and a fake `orca` first on its PATH: a swipe to an agent in an
   * Orca terminal runs `orca terminal switch`, and with none on PATH a Mac's daemon runs the Orca app's own.
   */
  const fresh = async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    writeFileSync(join(d.root, 'bin', 'orca'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    return { d, desk: theDesk }
  }

  /** A dial with no appFilter, so one ring holds every agent, shown its first list. */
  const plugged = async (on: Desk, serial: string, mac: string): Promise<FakeDial> => {
    const dial = await on.plug(serial, mac)
    await dial.next((m) => m.t === 'agents.end', 45_000, `${serial}'s first list`)
    return dial
  }

  /** O in an Orca terminal and W in WezTerm, each started and listed on every dial. */
  const sessions = async (d: IsolatedDaemon, ...dials: FakeDial[]) => {
    const o = new InOrca(d, 'o', children, { ORCA_TERMINAL_HANDLE: `term_${randomUUID()}`, __CFBundleIdentifier: ORCA })
    const w = new InOrca(d, 'w', children, { WEZTERM_PANE: '7' })
    for (const claude of [o, w]) {
      await claude.hook('SessionStart', { source: 'startup' })
      for (const dial of dials) await dial.next((m) => m.t === 'agent' && m.id === claude.id, 45_000, 'the agent listed')
    }
    return { o, w }
  }

  /** The daemon's environment names its own data folder, port and devices' socket, never this Mac's. */
  const isolated = (d: IsolatedDaemon): void => {
    expect(d.env.ADAPTER_DATA_DIR).toBe(d.dataDir)
    expect(d.dataDir.startsWith(d.root + sep)).toBe(true)
    expect(d.env.PORT).not.toBe(EVERYDAY_PORT)
    expect(devicesListenerPath(d.dataDir, process.platform, d.env.HOME)).toBe(join(d.dataDir, 'devices.sock'))
  }

  /** `harness device orca link`, the real CLI, under the daemon's environment only: what it prints is this daemon's. */
  const link = async (d: IsolatedDaemon): Promise<Link> => {
    isolated(d)
    const { stdout } = await run(process.execPath, [...CLI_ENTRY, 'device', 'orca', 'link'], { cwd: CLI_ROOT, env: d.env, timeout: 30_000 })
    return JSON.parse(stdout) as Link
  }

  /** The devices' socket, once `link` says it is ready. */
  const ready = async (d: IsolatedDaemon): Promise<string> => {
    const said = await until('the devices ready', async () => { const it = await link(d); return it.devicesReady && it }, 30_000, 200)
    expect(said.devicesSocket).toBe(join(d.dataDir, 'devices.sock'))
    return said.devicesSocket!
  }

  /** The stream opened as the plugin opens it, on the socket `link` printed. */
  const stream = (socketPath: string): Promise<Stream> => new Promise((resolve, reject) => {
    const sent = request({ socketPath, agent: false, method: 'POST', path: '/' }, (res) => {
      const lines: string[] = []
      let closed = false
      let rest = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        const parts = (rest + chunk).split('\n')
        rest = parts.pop()!
        lines.push(...parts)
      })
      // The listener ends a stream by closing its connection, which its client reads as an error.
      res.on('error', () => {})
      res.once('close', () => { closed = true })
      resolve({ status: res.statusCode, lines, closed: () => closed, close: () => sent.destroy() })
    })
    requests.push(sent)
    sent.on('error', reject)
    sent.end(OPEN)
  })

  /** The name the dial draws for [agent]: the last `agent` frame it got for that id. */
  const nameOn = (dial: FakeDial, agent: InOrca): string | undefined =>
    dial.messages.filter((m) => m.t === 'agent' && m.id === agent.id).at(-1)?.name as string | undefined

  const shown = (dial: FakeDial, agent: InOrca, app: string): string =>
    JSON.stringify({ attached: true, agent: { name: nameOn(dial, agent), app } })

  /** [dial] turns to [agent], again every 2 s until [probe] gives a value; that value. */
  const turned = <T>(dial: FakeDial, agent: InOrca, what: string, probe: () => T | undefined): Promise<T> => {
    let sent = 0
    return until(what, () => {
      const got = probe()
      if (got !== undefined) return got
      if (Date.now() - sent >= 2_000) {
        dial.send({ t: 'focus', agentId: agent.id })
        sent = Date.now()
      }
      return undefined
    }, 60_000, 50)
  }

  /** [dial] turns to [agent] until the stream's line [count] is there; that line. */
  const moved = (dial: FakeDial, agent: InOrca, open: Stream, count: number): Promise<string> =>
    turned(dial, agent, `line ${count}`, () => (open.lines.length >= count ? open.lines[count - 1] : undefined))

  /** A word the shell takes as it is. */
  const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

  /**
   * The plugin's loop, started as Orca would start it for someone whose launcher is `~/.local/bin/harness`: the home is
   * the throwaway one, and the launcher there starts this checkout's CLI under the daemon's environment and nothing else.
   * `/usr/bin:/bin` holds no `harness`: with no shim the loop would say `noHarness`, never find this Mac's launcher.
   */
  const loop = (d: IsolatedDaemon): Loop => {
    isolated(d)
    const bin = join(d.env.HOME!, '.local', 'bin')
    const shim = join(bin, 'harness')
    expect(shim.startsWith(d.root + sep)).toBe(true)
    const env = Object.entries(d.env).flatMap(([name, value]) => (value === undefined ? [] : [quoted(`${name}=${value}`)]))
    mkdirSync(bin, { recursive: true })
    writeFileSync(shim, `#!/bin/sh\ncd ${quoted(CLI_ROOT)} && exec /usr/bin/env -i ${env.join(' ')} ${[process.execPath, ...CLI_ENTRY].map(quoted).join(' ')} "$@"\n`, { mode: 0o700 })
    const child = spawn(process.execPath, ['--import', 'tsx', 'e2e/harness/pluginDial.ts'], {
      cwd: CLI_ROOT, env: { HOME: d.env.HOME, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    const states: DialState[] = []
    const logs: string[] = []
    const lines = (from: NodeJS.ReadableStream, take: (line: string) => void): void => {
      let rest = ''
      from.setEncoding('utf8')
      from.on('data', (chunk: string) => {
        const parts = (rest + chunk).split('\n')
        rest = parts.pop()!
        for (const part of parts) take(part)
      })
    }
    lines(child.stdout, (line) => states.push(JSON.parse(line) as DialState))
    lines(child.stderr, (line) => logs.push(line))
    const exited = new Promise<number | null>((done) => child.once('close', (code) => done(code)))
    return { states, logs, stop: () => { child.stdin.end(); return exited } }
  }

  /** The daemon's dial stream lines, each from its `[devices]` on. */
  const streamLines = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').filter((line) => line.includes('dial stream')).map((line) => line.slice(line.indexOf('[devices]')))

  it('before a dial, link says the daemon takes a connect and the devices are not ready; a dial plugged in makes them ready', async () => {
    const { d, desk } = await fresh()
    expect(await link(d)).toEqual({ daemon: true, devicesSocket: join(d.dataDir, 'devices.sock'), devicesReady: false })
    await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    await ready(d)
  })

  it('the stream opens on the state as it is, and each move of the dial is one line', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const { o, w } = await sessions(d, dial)
    const open = await stream(await ready(d))
    expect(open.status).toBe(200)
    await until('the first line', () => open.lines.length >= 1)
    expect(open.lines).toEqual([NO_AGENT])
    const onO = shown(dial, o, 'Orca')
    const onW = shown(dial, w, 'WezTerm')
    expect(await moved(dial, o, open, 2)).toBe(onO)
    expect(await moved(dial, w, open, 3)).toBe(onW)
    // A second focus on W says nothing: the next line is O's.
    dial.send({ t: 'focus', agentId: w.id })
    expect(await moved(dial, o, open, 4)).toBe(onO)
    expect(open.lines).toEqual([NO_AGENT, onO, onW, onO])
  })

  it('a second stream is 409 while the first is open, and a stream once it closed', async () => {
    const { d, desk } = await fresh()
    await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const socket = await ready(d)
    const first = await stream(socket)
    expect(first.status).toBe(200)
    await until('the first line', () => first.lines.length >= 1)
    const second = await stream(socket)
    expect(second.status).toBe(409)
    second.close()
    expect(first.closed()).toBe(false)
    first.close()
    // Once the listener has heard the first go: each try a connection of its own, at most one a second.
    const next = await until('a stream again', async () => {
      const tried = await stream(socket)
      if (tried.status === 200) return tried
      tried.close()
      return undefined
    }, 30_000, 1_000)
    await until('its first line', () => next.lines.length >= 1)
    expect(next.lines).toEqual([NO_AGENT])
  })

  it('two dials: the one that did not move last going changes nothing, the one that did says agent null, and the last one going says attached false', async () => {
    const { d, desk } = await fresh()
    const a = await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const b = await plugged(desk, 'E2E-B', 'e2:e0:00:00:00:0b')
    const { o, w } = await sessions(d, a, b)
    const open = await stream(await ready(d))
    await until('the first line', () => open.lines.length >= 1)
    expect(await moved(a, o, open, 2)).toBe(shown(a, o, 'Orca'))
    expect(await moved(b, w, open, 3)).toBe(shown(b, w, 'WezTerm'))
    await desk.unplug('E2E-A')
    // A's port closed before B moves: a none from A that reached the stream would come before B's line.
    await until("A's port closed", () => d.log().includes('cable: closed (end of stream) [usb E2E-A]'), 30_000, 50)
    expect(await moved(b, o, open, 4)).toBe(shown(b, o, 'Orca'))
    expect(open.lines).toEqual([NO_AGENT, shown(a, o, 'Orca'), shown(b, w, 'WezTerm'), shown(b, o, 'Orca')])
    await desk.unplug('E2E-B')
    await until('the last line detached', () => open.lines.at(-1) === DETACHED)
    // B's agent may be cleared in a line of its own before the dial is gone, or only the latest written.
    expect(open.lines.slice(4).every((line) => line === NO_AGENT || line === DETACHED)).toBe(true)
  })

  it('two dials: the one that moved last going says agent null, and the other\'s next move is its line', async () => {
    const { d, desk } = await fresh()
    const a = await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const b = await plugged(desk, 'E2E-B', 'e2:e0:00:00:00:0b')
    const { o, w } = await sessions(d, a, b)
    const open = await stream(await ready(d))
    await until('the first line', () => open.lines.length >= 1)
    await moved(a, o, open, 2)
    await moved(b, w, open, 3)
    await desk.unplug('E2E-B')
    await until('agent null', () => open.lines.length >= 4)
    expect(open.lines[3]).toBe(NO_AGENT)
    expect(await moved(a, w, open, 5)).toBe(shown(a, w, 'WezTerm'))
  })

  it('the plugin\'s loop, through the launcher in the throwaway home, follows the dial', async () => {
    const { d, desk } = await fresh()
    const run = loop(d)
    const last = (): DialState | undefined => run.states.at(-1)
    onTestFailed(() => { console.log(`---- the loop's states\n${run.states.map((s) => JSON.stringify(s)).join('\n')}\n---- its log\n${run.logs.join('\n')}`) })
    await until('unplugged', () => last()?.state === 'unplugged', 60_000)
    const dial = await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const attached: DialState = { state: 'attached' }
    await until('attached', () => last()?.state === 'attached', 60_000)
    expect(last()).toEqual(attached)
    // Started once the dial is there, as in the cases above: an agent started before is not on its first list.
    const { o } = await sessions(d, dial)
    const name = nameOn(dial, o)!
    const onO: DialState = { state: 'attached', agent: { name, app: 'Orca' } }
    await turned(dial, o, 'O shown', () => (last()?.agent?.name === name || undefined))
    expect(last()).toEqual(onO)
    await desk.unplug('E2E-A')
    await until('unplugged again', () => last()?.state === 'unplugged', 60_000)
    // O cleared as the dial's session closes may come in a state of its own before the dial is gone, or only the
    // latest be told; nothing else is: no notRunning, noHarness or elsewhere.
    expect(run.states.slice(0, 3)).toEqual([{ state: 'unplugged' }, attached, onO])
    expect(run.states.slice(3, -1).every((state) => JSON.stringify(state) === JSON.stringify(attached))).toBe(true)
    expect(last()).toEqual({ state: 'unplugged' })
    const stopped = run.stop()
    // The loop closed the stream it held.
    await until('the stream ended', () => streamLines(d).at(-1) === '[devices] dial stream · ended · gone')
    expect(await stopped).toBe(0)
    expect(run.logs).toContain('dial: unplugged')
    expect(run.logs).toContain('dial: attached')
    expect(run.logs.filter((line) => line.includes(name) || line.includes('Orca') || line.includes(d.root))).toEqual([])
  })

  it('the daemon\'s log says each open and end of the stream, and nothing of an agent', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const { o, w } = await sessions(d, dial)
    const open = await stream(await ready(d))
    await until('the first line', () => open.lines.length >= 1)
    await moved(dial, o, open, 2)
    await moved(dial, w, open, 3)
    open.close()
    await until('the stream ended', () => streamLines(d).includes('[devices] dial stream · ended · gone'))
    const lines = streamLines(d)
    expect(lines).toContain('[devices] dial stream · open')
    // Each line whole: no name or app could sit in one.
    expect(lines.every((line) => /^\[devices\] dial stream · (open|ended · (gone|stalled|closed)|\d+ lines in the last minute)$/.test(line))).toBe(true)
  })
})
