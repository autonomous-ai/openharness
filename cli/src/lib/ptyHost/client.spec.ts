import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PtyHostClient, type PtyHostDiscovery } from './client.js'
import { encodeFrame, FrameKind, FrameReader, helloAuth, helloProof, PTY_PROTOCOL, type PtyEvent } from './protocol.js'

type Request = { id: number; op: string } & Record<string, unknown>
interface FakeHostOptions {
  token?: string
  /** Answer a control request; the default replies `{id, ok: true}`. */
  onRequest?: (request: Request, socket: net.Socket) => void
  /** What to do with a hello: answer it (default), close at once, or never answer. */
  hello?: 'answer' | 'close' | 'silent'
  /** Bytes a stream connection gets in the same write as its hello reply. */
  streamGreeting?: Buffer
  /** Refuse stream-role hellos as incompatible. */
  refuseStreams?: boolean
  /**
   * The hello reply's proof: the token's (default, a host that knows it), or a squatter's, which has only what the
   * client sent: none at all, the client's `auth` sent back, a proof made from the `auth` as if it were the token, or
   * one made with a guessed token.
   */
  proof?: 'right' | 'none' | 'reflect' | 'fromAuth' | 'guess'
  /** The hello reply's `features`: absent (a host from before them) unless given. */
  features?: unknown
}
interface FakeHost {
  discovery: PtyHostDiscovery
  /** Every hello line received, parsed. */
  hellos: Array<{ hello: Record<string, unknown> }>
  sockets: Set<net.Socket>
  close(): Promise<void>
}

const line = (socket: net.Socket, value: unknown) => socket.write(`${JSON.stringify(value)}\n`)

/** A fresh endpoint to listen at: a named pipe on Windows, a socket file elsewhere. */
const tempEndpoint = () => process.platform === 'win32'
  ? `\\\\.\\pipe\\pty-${randomUUID()}`
  // A socket path has 104 bytes on macOS and the temporary folder takes about half.
  : path.join(tmpdir(), `pty-${randomUUID().slice(0, 8)}.sock`)

/** A `net.Server` that speaks the host's hello and control NDJSON, on a temporary socket. */
async function fakeHost(options: FakeHostOptions = {}): Promise<FakeHost> {
  const token = options.token ?? 'tok'
  const endpoint = tempEndpoint()
  const hellos: FakeHost['hellos'] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let pending = ''
    let role: string | null = null
    socket.on('data', chunk => {
      pending += chunk.toString('utf8')
      let at: number
      while ((at = pending.indexOf('\n')) >= 0) {
        const text = pending.slice(0, at)
        pending = pending.slice(at + 1)
        const value = JSON.parse(text)
        if (role === null) {
          hellos.push(value)
          if (options.hello === 'close') { socket.destroy(); return }
          if (options.hello === 'silent') return
          const knows = options.proof === undefined || options.proof === 'right'
          if ((knows && value.hello.auth !== helloAuth(token, String(value.hello.nonce)))
            || (options.refuseStreams && value.hello.role === 'stream')) {
            line(socket, { hello: { ok: false, code: 'incompatible', reason: 'wrong token' } })
            socket.end()
            return
          }
          role = value.hello.role
          const nonce = String(value.hello.nonce)
          const sent = String(value.hello.auth)
          const proof = options.proof === 'none' ? {}
            : options.proof === 'reflect' ? { proof: sent }
            : options.proof === 'fromAuth' ? { proof: helloProof(sent, nonce) }
            : options.proof === 'guess' ? { proof: helloProof('tok-guess', nonce) }
            : { proof: helloProof(token, nonce) }
          const features = options.features === undefined ? {} : { features: options.features }
          const ok = Buffer.from(`${JSON.stringify({ hello: { ok: true, instance: 'p1', version: 'test', pid: 1, ...features, ...proof } })}\n`)
          socket.write(role === 'stream' && options.streamGreeting ? Buffer.concat([ok, options.streamGreeting]) : ok)
          continue
        }
        if (options.onRequest) options.onRequest(value, socket)
        else line(socket, { id: value.id, ok: true })
      }
    })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  return {
    discovery: { protocol: PTY_PROTOCOL, instance: 'p1', endpoint, pid: 1, version: 'test', token },
    hellos,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function connected(options: FakeHostOptions = {}) {
  const fake = await fakeHost(options)
  cleanup.push(() => fake.close())
  const client = await PtyHostClient.connect(fake.discovery)
  if (!(client instanceof PtyHostClient)) throw new Error(`not connected: ${JSON.stringify(client)}`)
  cleanup.push(() => client.close())
  return { fake, client }
}

describe('PtyHostClient.connect', () => {
  it('knows the pid of the host it reached, from its discovery file', async () => {
    const { fake, client } = await connected()
    expect(client.pid).toBe(fake.discovery.pid)
  })

  it('says hello with the token, the protocol and the control role', async () => {
    const { fake, client } = await connected()
    expect(client.instance).toBe('p1')
    expect(fake.hellos).toHaveLength(1)
    expect(fake.hellos[0].hello).toMatchObject({ protocol: PTY_PROTOCOL, role: 'control' })
    expect(typeof fake.hellos[0].hello.clientId).toBe('string')
  })

  it.runIf(PTY_PROTOCOL >= 2)('speaks an older host\'s own protocol, and none it does not support', async () => {
    const fake = await fakeHost()
    cleanup.push(() => fake.close())
    const old = await PtyHostClient.connect({ ...fake.discovery, protocol: PTY_PROTOCOL - 1 })
    if (!(old instanceof PtyHostClient)) throw new Error(`not connected: ${JSON.stringify(old)}`)
    cleanup.push(() => old.close())
    expect(old.protocol).toBe(PTY_PROTOCOL - 1)
    expect(fake.hellos[0].hello).toMatchObject({ protocol: PTY_PROTOCOL - 1 })
    // Its stream connections too.
    const stream = await old.openStream()
    cleanup.push(() => stream?.destroy())
    expect(stream).not.toBeNull()
    expect(fake.hellos[1].hello).toMatchObject({ protocol: PTY_PROTOCOL - 1, role: 'stream' })
    for (const protocol of [PTY_PROTOCOL + 1, PTY_PROTOCOL - 2]) {
      expect(await PtyHostClient.connect({ ...fake.discovery, protocol }))
        .toEqual({ incompatible: expect.stringContaining(`protocol ${protocol} is not supported`) })
    }
    // Nothing was said to the host for them.
    expect(fake.hellos).toHaveLength(2)
  })

  it('features come from the hello reply, empty when absent', async () => {
    expect((await connected({ features: ['seed'] })).client.features).toEqual(['seed'])
    // A host from before features lists none.
    expect((await connected()).client.features).toEqual([])
    // Only names: anything else in the list, or a list that is not one, is no feature.
    expect((await connected({ features: ['seed', 7, null, 'later'] })).client.features).toEqual(['seed', 'later'])
    expect((await connected({ features: 'seed' })).client.features).toEqual([])
  })

  it('refuses a host whose hello names another pid than its discovery file', async () => {
    const fake = await fakeHost()
    cleanup.push(() => fake.close())
    // The stand-in says pid 1.
    expect(await PtyHostClient.connect({ ...fake.discovery, pid: 2 }))
      .toEqual({ incompatible: 'the host answering is pid 1, not the 2 its discovery file names' })
  })

  it('reports a bad token as incompatible', async () => {
    const fake = await fakeHost({ token: 'right' })
    cleanup.push(() => fake.close())
    const result = await PtyHostClient.connect({ ...fake.discovery, token: 'wrong' })
    expect(result).toEqual({ incompatible: expect.stringContaining('token') })
  })

  it('gives null when nothing listens at the endpoint', async () => {
    const fake = await fakeHost()
    await fake.close()
    expect(await PtyHostClient.connect(fake.discovery)).toBeNull()
  })

  it('never sends the token: the hello proves it with an auth over a fresh 32-byte nonce', async () => {
    const fake = await fakeHost({ token: 'sekrit-T0KEN-value' })
    cleanup.push(() => fake.close())
    for (let i = 0; i < 2; i++) {
      const client = await PtyHostClient.connect(fake.discovery)
      if (!(client instanceof PtyHostClient)) throw new Error(JSON.stringify(client))
      client.close()
    }
    const nonces = fake.hellos.map(h => h.hello.nonce)
    expect(nonces).toHaveLength(2)
    for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(nonces[0]).not.toBe(nonces[1])
    for (const { hello } of fake.hellos) {
      expect(hello).not.toHaveProperty('token')
      expect(JSON.stringify(hello)).not.toContain('sekrit-T0KEN-value')
      expect(hello.auth).toBe(helloAuth('sekrit-T0KEN-value', String(hello.nonce)))
    }
  })

  it.each(['none', 'reflect', 'fromAuth', 'guess'] as const)('reports a squatter that says ok (proof: %s) as incompatible', async (proof) => {
    // A process squatting on the endpoint: it says ok, and builds its proof from what the client sent; it never sees
    // the token.
    const fake = await fakeHost({ proof })
    cleanup.push(() => fake.close())
    expect(await PtyHostClient.connect(fake.discovery)).toEqual({ incompatible: 'the endpoint does not know this host\'s token' })
  })

  it('reports a host that closes during the hello as incompatible', async () => {
    const fake = await fakeHost({ hello: 'close' })
    cleanup.push(() => fake.close())
    expect(await PtyHostClient.connect(fake.discovery)).toEqual({ incompatible: expect.stringContaining('closed') })
  })

  it('reports a host that never answers the hello as incompatible within the timeout', async () => {
    const fake = await fakeHost({ hello: 'silent' })
    cleanup.push(() => fake.close())
    expect(await PtyHostClient.connect(fake.discovery, 100)).toEqual({ incompatible: expect.stringContaining('hello') })
    // The abandoned connection is closed, not left open on the host.
    await expect.poll(() => fake.sockets.size).toBe(0)
  })

  it('reports a hello reply that never ends as incompatible', async () => {
    const endpoint = tempEndpoint()
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.resume(); socket.write('x'.repeat(100_000)) })
    server.listen(endpoint)
    await once(server, 'listening')
    cleanup.push(() => new Promise(resolve => server.close(resolve)))
    const result = await PtyHostClient.connect({ protocol: PTY_PROTOCOL, instance: 'p1', endpoint, pid: 1, version: 'x', token: 't' })
    expect(result).toEqual({ incompatible: expect.stringContaining('too long') })
  })

  it('reports an unreadable hello reply as incompatible', async () => {
    const endpoint = tempEndpoint()
    // resume(): a socket nobody reads never sees the client's end, and server.close() waits for it.
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.resume(); socket.write('not json\n') })
    server.listen(endpoint)
    await once(server, 'listening')
    cleanup.push(() => new Promise(resolve => server.close(resolve)))
    const result = await PtyHostClient.connect({ protocol: PTY_PROTOCOL, instance: 'p1', endpoint, pid: 1, version: 'x', token: 't' })
    expect(result).toEqual({ incompatible: expect.stringContaining('hello') })
  })
})

describe('PtyHostClient.call', () => {
  it('maps a write with no reply to possibly_executed', async () => {
    const { client } = await connected({ onRequest: () => {} /* never reply */ })
    const result = await client.call({ op: 'write', pane: '%1', data: 'aA==' }, 100)
    expect(result).toMatchObject({ state: 'unknown', dispatch: 'possibly_executed' })
  })

  it('maps a closed connection before write to not_started', async () => {
    const { client } = await connected({ onRequest: () => {} })
    client.close()
    expect(await client.call({ op: 'inventory' })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
  })

  it('returns the reply fields without id and ok', async () => {
    const { client } = await connected({
      onRequest: (r, s) => line(s, { id: r.id, ok: true, panes: [{ pane: '%1', rootPid: null }] }),
    })
    const result = await client.call({ op: 'inventory' })
    expect(result).toEqual({ state: 'ok', value: { panes: [{ pane: '%1', rootPid: null }] } })
  })

  it('sends one line per request with an id and the op fields', async () => {
    const seen: Request[] = []
    const { client } = await connected({ onRequest: (r, s) => { seen.push(r); line(s, { id: r.id, ok: true }) } })
    await client.call({ op: 'kill', pane: '%2', graceMs: 2000 })
    await client.call({ op: 'titles' })
    expect(seen).toEqual([
      { id: expect.any(Number), op: 'kill', pane: '%2', graceMs: 2000 },
      { id: expect.any(Number), op: 'titles' },
    ])
    expect(seen[0].id).not.toBe(seen[1].id)
  })

  it('maps ok:false to rejected, with the code and reason', async () => {
    const { client } = await connected({
      onRequest: (r, s) => line(s, { id: r.id, ok: false, code: 'spawn_failed', reason: 'no such file' }),
    })
    expect(await client.call({ op: 'create', command: ['x'], cols: 80, rows: 24, owner: 'o', hold: true })).toEqual({
      state: 'failed', dispatch: 'rejected', code: 'spawn_failed', reason: 'no such file',
    })
  })

  it('maps no_pane to not_started', async () => {
    const { client } = await connected({
      onRequest: (r, s) => line(s, { id: r.id, ok: false, code: 'no_pane', reason: 'no pane %9' }),
    })
    expect(await client.call({ op: 'paneInfo', pane: '%9' })).toEqual({
      state: 'failed', dispatch: 'not_started', code: 'no_pane', reason: 'no pane %9',
    })
  })

  it('maps a connection the host closes after the write to possibly_executed', async () => {
    const { client } = await connected({ onRequest: (_r, s) => s.destroy() })
    const result = await client.call({ op: 'key', pane: '%1', key: 'Enter' })
    expect(result).toEqual({ state: 'unknown', dispatch: 'possibly_executed', reason: expect.stringContaining('closed') })
  })

  it('settles every call in flight when the connection closes', async () => {
    const { fake, client } = await connected({ onRequest: () => {} })
    const calls = [client.call({ op: 'titles' }), client.call({ op: 'inventory' })]
    await expect.poll(() => fake.sockets.size).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    for (const socket of fake.sockets) socket.destroy()
    expect(await Promise.all(calls)).toEqual([
      expect.objectContaining({ state: 'unknown', dispatch: 'possibly_executed' }),
      expect.objectContaining({ state: 'unknown', dispatch: 'possibly_executed' }),
    ])
    expect(await client.call({ op: 'titles' })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
  })

  it('settles calls in flight as possibly_executed on close()', async () => {
    const { client } = await connected({ onRequest: () => {} })
    const pending = client.call({ op: 'titles' })
    await new Promise(resolve => setTimeout(resolve, 20))
    client.close()
    expect(await pending).toMatchObject({ state: 'unknown', dispatch: 'possibly_executed' })
  })

  it('matches replies by id, in any order, and ignores a reply that came too late', async () => {
    const held: Request[] = []
    const { client } = await connected({
      onRequest: (r, s) => {
        held.push(r)
        if (held.length < 3) return
        // Answer the third, then the second; the first has timed out by then.
        line(s, { id: held[2].id, ok: true, titles: { '%3': 'c' } })
        line(s, { id: held[1].id, ok: true, titles: { '%2': 'b' } })
        line(s, { id: held[0].id, ok: true, titles: { '%1': 'late' } })
      },
    })
    const first = client.call({ op: 'titles' }, 50)
    expect(await first).toMatchObject({ state: 'unknown' })
    const second = client.call({ op: 'titles' })
    const third = client.call({ op: 'titles' })
    expect(await third).toEqual({ state: 'ok', value: { titles: { '%3': 'c' } } })
    expect(await second).toEqual({ state: 'ok', value: { titles: { '%2': 'b' } } })
  })

  it('reads replies split across chunks, and several in one chunk', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024)
    const { client } = await connected({
      onRequest: (r, s) => {
        if (r.op === 'capture') {
          const text = `${JSON.stringify({ id: r.id, ok: true, text: big })}\n`
          for (let at = 0; at < text.length; at += 7_000) s.write(text.slice(at, at + 7_000))
          return
        }
        line(s, { id: r.id, ok: true })
      },
    })
    const result = await client.call({ op: 'capture', pane: '%1', ansi: false, visible: true })
    expect(result.state === 'ok' && result.value.text.length).toBe(big.length)
  })

  it('ignores lines it cannot read', async () => {
    const { client } = await connected({
      onRequest: (r, s) => { s.write('garbage\n\n[1]\n'); line(s, { id: r.id, ok: true, titles: {} }) },
    })
    expect(await client.call({ op: 'titles' })).toEqual({ state: 'ok', value: { titles: {} } })
  })
})

describe('PtyHostClient events', () => {
  it('delivers exit and title notices, with a null exit status as sent', async () => {
    const { client } = await connected({
      onRequest: (r, s) => {
        line(s, { event: 'title', pane: '%1', title: 'vim' })
        line(s, { event: 'exit', pane: '%1', status: null })
        line(s, { event: 'exit', pane: '%2', status: 3 })
        line(s, { id: r.id, ok: true })
      },
    })
    const events: PtyEvent[] = []
    const off = client.onEvent(e => events.push(e))
    await client.call({ op: 'titles' })
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual([
      { event: 'title', pane: '%1', title: 'vim' },
      { event: 'exit', pane: '%1', status: null },
      { event: 'exit', pane: '%2', status: 3 },
    ])
    off()
  })

  it('stops delivering to a listener once it unsubscribes', async () => {
    const { client } = await connected({
      onRequest: (r, s) => { line(s, { event: 'title', pane: '%1', title: 't' }); line(s, { id: r.id, ok: true }) },
    })
    const events: PtyEvent[] = []
    client.onEvent(e => events.push(e))()
    await client.call({ op: 'titles' })
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual([])
  })

  it('delivers an exit that overtook its create reply after the caller has the pane', async () => {
    // The host queues a pane's exit notice as soon as the process exits, which can be before the
    // reply to the create that made it.
    const { client } = await connected({
      onRequest: (r, s) => {
        line(s, { event: 'exit', pane: '%7', status: 0 })
        line(s, { id: r.id, ok: true, pane: '%7' })
      },
    })
    const known = new Set<string>()
    const seen: string[] = []
    client.onEvent(e => seen.push(known.has(e.pane) ? `known ${e.pane}` : `unknown ${e.pane}`))
    const created = await client.call({ op: 'create', command: ['true'], cols: 80, rows: 24, owner: 'o', hold: false })
    if (created.state === 'ok') known.add(created.value.pane)
    await new Promise(resolve => setImmediate(resolve))
    expect(seen).toEqual(['known %7'])
  })

  it('holds notices behind a respawn in flight too, and releases them if it times out', async () => {
    const { client } = await connected({
      onRequest: (r, s) => { if (r.op === 'respawn') line(s, { event: 'exit', pane: '%1', status: 1 }) },
    })
    const events: PtyEvent[] = []
    client.onEvent(e => events.push(e))
    const result = await client.call({ op: 'respawn', pane: '%1', command: ['false'] }, 100)
    expect(result.state).toBe('unknown')
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual([{ event: 'exit', pane: '%1', status: 1 }])
  })

  it('drops the notices it held once close() ends the connection', async () => {
    const { client } = await connected({
      onRequest: (r, s) => { if (r.op === 'create') line(s, { event: 'exit', pane: '%1', status: 0 }) },
    })
    const events: PtyEvent[] = []
    client.onEvent(e => events.push(e))
    const created = client.call({ op: 'create', command: ['true'], cols: 80, rows: 24, owner: 'o', hold: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    client.close()
    expect((await created).state).toBe('unknown')
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual([])
  })

  it('keeps delivering to other listeners when one throws', async () => {
    const { client } = await connected({
      onRequest: (r, s) => { line(s, { event: 'title', pane: '%1', title: 't' }); line(s, { id: r.id, ok: true }) },
    })
    const events: PtyEvent[] = []
    client.onEvent(() => { throw new Error('boom') })
    client.onEvent(e => events.push(e))
    await client.call({ op: 'titles' })
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toHaveLength(1)
  })
})

describe('PtyHostClient.onClose', () => {
  it('fires once when the host ends the connection', async () => {
    const { fake, client } = await connected()
    let closes = 0
    client.onClose(() => closes++)
    for (const socket of fake.sockets) socket.destroy()
    await expect.poll(() => closes).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closes).toBe(1)
  })

  it('does not fire for close(), nor for a listener that unsubscribed', async () => {
    const first = await connected()
    let closes = 0
    first.client.onClose(() => closes++)
    first.client.close()
    const second = await connected()
    second.client.onClose(() => closes++)()
    for (const socket of second.fake.sockets) socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(closes).toBe(0)
  })

  it('fires for a listener added after the connection ended', async () => {
    const { fake, client } = await connected()
    for (const socket of fake.sockets) socket.destroy()
    await expect.poll(async () => (await client.call({ op: 'titles' })).state).toBe('failed')
    let closes = 0
    client.onClose(() => closes++)
    expect(closes).toBe(1)
  })
})

describe('PtyHostClient.openStream', () => {
  it('opens a stream-role connection whose bytes after the hello are frames', async () => {
    const greeting = encodeFrame(FrameKind.Closed, Buffer.from('{"reason":"exited"}'))
    const { fake, client } = await connected({ streamGreeting: greeting })
    const stream = await client.openStream()
    expect(stream).not.toBeNull()
    cleanup.push(() => stream!.destroy())
    expect(fake.hellos.map(h => h.hello.role)).toEqual(['control', 'stream'])
    const reader = new FrameReader()
    const frames: ReturnType<FrameReader['push']> = []
    stream!.on('data', chunk => frames.push(...reader.push(chunk)))
    stream!.resume()
    await expect.poll(() => frames.length).toBe(1)
    expect(frames[0]).toEqual({ kind: FrameKind.Closed, payload: Buffer.from('{"reason":"exited"}') })
  })

  it('gives null when the host refuses the stream', async () => {
    const { client } = await connected({ refuseStreams: true })
    expect(await client.openStream()).toBeNull()
  })

  it('gives null when the host is gone', async () => {
    const { fake, client } = await connected()
    await fake.close()
    expect(await client.openStream()).toBeNull()
  })
})
