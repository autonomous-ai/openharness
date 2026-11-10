import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXIT_LOOKUP_URL, exitZone, testProxy, type Proxy } from './exitLookup.js'

const ANSWER = { status: 'success', timezone: 'Asia/Ho_Chi_Minh', query: '203.0.113.7' }
const reply = (body: unknown, status = '200 OK') => `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\n\r\n${typeof body === 'string' ? body : JSON.stringify(body)}`

const servers: Server[] = []
const sockets: Socket[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) server.close()
})

/** A proxy on loopback: `answer` gets what it was sent (after any SOCKS5 handshake) and writes the reply. */
async function listen(onSocket: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => { sockets.push(socket); onSocket(socket) })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

/** An HTTP proxy: the whole request head, then `body`. */
async function httpProxy(body: string, heard: string[] = []): Promise<number> {
  return listen((socket) => {
    let head = ''
    socket.on('data', (chunk) => {
      head += chunk.toString()
      if (!head.includes('\r\n\r\n')) return
      heard.push(head)
      socket.end(body)
    })
  })
}

/** A SOCKS5 proxy with a login, which records the CONNECT it was asked for and then the HTTP request. */
async function socksProxy(body: string, heard: { login?: string; type?: number; target?: string; request?: string }): Promise<number> {
  return listen((socket) => {
    let data = Buffer.alloc(0)
    let stage = 0
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk])
      if (stage === 0 && data.length >= 3) { data = data.subarray(3); stage = 1; socket.write(Buffer.from([5, 2])) }
      if (stage === 1 && data.length >= 2) {
        const ulen = data[1]!, plen = data[2 + ulen]!
        heard.login = `${data.subarray(2, 2 + ulen)}:${data.subarray(3 + ulen, 3 + ulen + plen)}`
        data = data.subarray(3 + ulen + plen); stage = 2; socket.write(Buffer.from([1, 0]))
      }
      if (stage === 2 && data.length >= 5) {
        const len = data[4]!
        heard.type = data[3]
        heard.target = `${data.subarray(5, 5 + len)}:${data.readUInt16BE(5 + len)}`
        data = data.subarray(7 + len); stage = 3
        socket.write(Buffer.from([5, 0, 0, 1, 10, 0, 0, 1, 0, 80]))
      }
      if (stage === 3 && data.includes('\r\n\r\n')) { heard.request = data.toString(); socket.end(body) }
    })
  })
}

const proxy = (port: number, over: Partial<Proxy> = {}): Proxy => ({ scheme: 'http', host: '127.0.0.1', port, username: 'kim', password: 'p4ss', ...over })

describe('testProxy', () => {
  it('asks ip-api through an HTTP proxy, an HTTPS proxy and a SOCKS5 proxy, each with its login, and returns the address and zone', async () => {
    expect(EXIT_LOOKUP_URL).toBe('http://ip-api.com/json/?fields=status,timezone,query')
    const ok = { ok: true, address: '203.0.113.7', timeZone: 'Asia/Ho_Chi_Minh' }
    const basic = `Proxy-Authorization: Basic ${Buffer.from('kim:p4ss').toString('base64')}\r\n`

    const heard: string[] = []
    expect(await testProxy(proxy(await httpProxy(reply(ANSWER), heard)))).toEqual(ok)
    expect(heard[0]).toBe(`GET ${EXIT_LOOKUP_URL} HTTP/1.0\r\nHost: ip-api.com\r\n${basic}Connection: close\r\n\r\n`)

    // An HTTPS proxy is the same request inside TLS to the proxy; here the TLS is left out, the rest is the same.
    const viaTls: string[] = []
    const httpsPort = await httpProxy(reply(ANSWER), viaTls)
    const opened: Proxy[] = []
    expect(await testProxy(proxy(httpsPort, { scheme: 'https' }), { connect: (to) => { opened.push(to); return connect(to.port, to.host) } })).toEqual(ok)
    expect(opened).toEqual([proxy(httpsPort, { scheme: 'https' })])
    expect(viaTls[0]).toBe(heard[0])

    const socks: { login?: string; type?: number; target?: string; request?: string } = {}
    expect(await testProxy(proxy(await socksProxy(reply(ANSWER), socks), { scheme: 'socks5' }))).toEqual(ok)
    expect(socks).toEqual({ login: 'kim:p4ss', type: 3, target: 'ip-api.com:80',
      request: 'GET /json/?fields=status,timezone,query HTTP/1.0\r\nHost: ip-api.com\r\nConnection: close\r\n\r\n' })
  })

  it('sends no login to a proxy that has none', async () => {
    const heard: string[] = []
    expect(await testProxy(proxy(await httpProxy(reply(ANSWER), heard), { username: '', password: '' }))).toMatchObject({ ok: true })
    expect(heard[0]).not.toContain('Proxy-Authorization')
  })

  it('an HTTPS proxy is reached over TLS', async () => {
    const hellos: Buffer[] = []
    const port = await listen((socket) => { socket.once('data', (chunk) => { hellos.push(chunk); socket.destroy() }) })
    expect(await testProxy(proxy(port, { scheme: 'https' }))).toEqual({ ok: false })
    expect(await testProxy(proxy(port, { scheme: 'https', host: 'localhost' }))).toEqual({ ok: false })
    // 0x16: a TLS handshake record, the ClientHello; a host name is sent as its server name, an address is not.
    expect(hellos.map(hello => hello[0])).toEqual([0x16, 0x16])
    expect(hellos.map(hello => hello.includes('localhost'))).toEqual([false, true])
  })

  it('a failed lookup is ok:false', async () => {
    for (const body of [
      reply({ status: 'fail', message: 'reserved range' }),
      reply(ANSWER, '407 Proxy Authentication Required'),
      reply('not json'),
      reply({ ...ANSWER, query: 'not an address' }),
      'garbage',
    ]) expect(await testProxy(proxy(await httpProxy(body))), body).toEqual({ ok: false })
    // A proxy that is not there.
    const port = await listen(() => {})
    servers.pop()!.close()
    await new Promise(done => setTimeout(done, 20))
    expect(await testProxy(proxy(port))).toEqual({ ok: false })
    // A refused SOCKS5 login.
    const refusing = await listen((socket) => socket.once('data', () => socket.end(Buffer.from([5, 0xff]))))
    expect(await testProxy(proxy(refusing, { scheme: 'socks5' }))).toEqual({ ok: false })
  })

  it('an answer past 64 KiB is not read', async () => {
    expect(await testProxy(proxy(await httpProxy(reply({ ...ANSWER, pad: 'x'.repeat(70 * 1024) }))))).toEqual({ ok: false })
  })

  it('times out after 15 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const port = await listen(() => {})
    let answer: unknown = null
    void testProxy(proxy(port)).then((a) => { answer = a })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(answer).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toEqual({ ok: false })
  })

  it('an invalid zone is ignored', async () => {
    for (const timezone of ['Mars/Olympus_Mons', '+07:00', 7]) {
      expect(await testProxy(proxy(await httpProxy(reply({ ...ANSWER, timezone })))), String(timezone)).toEqual({ ok: false })
    }
  })
})

describe('exitZone', () => {
  it('is the lookup\'s zone, or null', async () => {
    expect(await exitZone(proxy(await httpProxy(reply(ANSWER))))).toBe('Asia/Ho_Chi_Minh')
    expect(await exitZone(proxy(await httpProxy(reply({ status: 'fail' }))))).toBeNull()
  })
})
