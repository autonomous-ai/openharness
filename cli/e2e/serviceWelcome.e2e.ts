/** Found by QA on a quiet machine: a cold Share request reached its process before `connected`, so its
 * agent read ran without a core connection and said HARNESS_NOT_FOUND. Separate the real wire's frames
 * in time, preserving their order: socket coalescing must not decide whether an agent can be shared. */
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { runServiceProcess } from '../src/services/process.js'
import { runSharingService } from '../src/services/sharingProcess.js'

/** The real socket, with successive received frames delivered in separate turns, in their original order. */
class SeparateFrames extends EventEmitter {
  private readonly socket: WebSocket
  private readonly queued: Array<[WebSocket.RawData, boolean]> = []
  private timer: ReturnType<typeof setTimeout> | null = null
  readonly types: string[] = []
  constructor(url: string) {
    super()
    this.socket = new WebSocket(url)
    this.socket.on('open', () => this.emit('open'))
    this.socket.on('error', (error) => this.emit('error', error))
    this.socket.on('close', (code) => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.queued.length = 0
      this.emit('close', code)
    })
    this.socket.on('message', (raw, binary) => { this.queued.push([raw, binary]); this.pump() })
  }
  private pump(): void {
    if (this.timer || !this.queued.length) return
    this.timer = setTimeout(() => {
      this.timer = null
      const [raw, binary] = this.queued.shift()!
      if (!binary) this.types.push(JSON.parse(raw.toString()).type)
      this.emit('message', raw, binary)
      this.pump()
    }, 20)
  }
  get readyState(): number { return this.socket.readyState }
  send(value: string): void { this.socket.send(value) }
  close(): void { this.socket.close() }
}

it('a cold Share reads its live agent after being welcomed, even when each wire frame arrives separately', async () => {
  const token = 'isolated-service-welcome-token'
  // The fixture supplies the one service, so the core knows its private boot token but no real master
  // starts a competing Share. Every other service runs inline; no real daemon or credential is involved.
  const d = await IsolatedDaemon.create({ noMaster: true, env: {
    HARNESS_NO_MASTER: '1', HARNESSD_SUPERVISED: '1', HARNESSD_SERVICE_TOKEN: token,
    HARNESSD_SERVICE_PROCESSES: 'sharing', HARNESSD_SERVICES: 'sharing',
  } })
  let client: LocalClient | undefined
  let service: ReturnType<typeof runSharingService> | undefined
  let wire: SeparateFrames | undefined
  onTestFailed(() => console.log(`---- daemon log\n${d.log()}`))
  try {
    await d.start()
    const core = d.corePid()
    client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'share-first-request')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    await until('the agent to bind', async () => {
      const rows = (await client!.request('agents_list', {})).agents as Array<Record<string, any>>
      return rows.some((row) => row.id === created.agent.id && row.sessionId) || null
    }, 60_000, 100)
    const first = client.request('harness_share_list', { agentId: created.agent.id }, 30_000)
    // This later reply on the same ordered connection proves the first request reached the core.
    await client.request('agents_list', {})
    service = runSharingService({ dataDir: d.dataDir, socketPath: d.socketPath, machineId: d.computerId, token,
      run: (options) => runServiceProcess({ ...options, connect: (url) => {
        wire = new SeparateFrames(url)
        return wire as unknown as WebSocket
      } }),
    })
    const result = await first
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    expect(result).toMatchObject({ shares: [], link: null, collaboration: true })
    expect(wire!.types.slice(0, 2)).toEqual(['connected', 'harness_share_list'])
    expect(d.corePid()).toBe(core)
  } finally {
    await service?.stop()
    client?.close()
    await d.close()
  }
})
