import { request as httpRequest } from 'node:http'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — the relay is plain ESM, run by Node inside the browser's container.
import { createRelay, probe } from '../../../assets/browser/proxy-relay.mjs'

const LOGIN = `Basic ${Buffer.from('kim:p4ss').toString('base64')}`
const servers: Server[] = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  await new Promise(done => server.close(done))
  return port
}

/** An HTTP proxy that records each request head, answers `status`, and echoes a tunnel it accepted. */
function httpProxy(status = 200) {
  const heads: string[] = []
  const server = createServer((socket) => {
    let data = ''
    socket.on('data', function onHead(chunk) {
      data += chunk.toString('latin1')
      const end = data.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onHead)
      heads.push(data.slice(0, end))
      if (data.startsWith('CONNECT ')) {
        socket.write(`HTTP/1.1 ${status} Whatever\r\n\r\n`)
        if (status === 200) socket.on('data', bytes => socket.write(bytes))
        else socket.end()
        return
      }
      socket.end(`HTTP/1.1 ${status} Whatever\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok`)
    })
  })
  return { server, heads }
}

/** A SOCKS5 proxy that records what it was asked; then answers an HTTP request with its head, or echoes. */
function socksProxy(opts: { acceptLogin?: boolean; reply?: number } = {}) {
  const asked: { login: string; type: number; host: string; port: number }[] = []
  const heads: string[] = []
  const server = createServer((socket) => {
    let data = Buffer.alloc(0)
    let stage = 0
    let login = ''
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk])
      if (stage === 0 && data.length >= 2 + data[1]!) {
        data = data.subarray(2 + data[1]!)
        socket.write(Buffer.from([5, 2]))
        stage = 1
      }
      if (stage === 1 && data.length >= 2 && data.length >= 3 + data[1]! && data.length >= 3 + data[1]! + data[2 + data[1]!]!) {
        const ulen = data[1]!
        const plen = data[2 + ulen]!
        login = `${data.subarray(2, 2 + ulen)}:${data.subarray(3 + ulen, 3 + ulen + plen)}`
        data = data.subarray(3 + ulen + plen)
        if (opts.acceptLogin === false) return void socket.end(Buffer.from([1, 1]))
        socket.write(Buffer.from([1, 0]))
        stage = 2
      }
      if (stage === 2 && data.length >= 5 && data.length >= 7 + data[4]!) {
        const len = data[4]!
        asked.push({ login, type: data[3]!, host: data.subarray(5, 5 + len).toString(), port: data.readUInt16BE(5 + len) })
        data = data.subarray(7 + len)
        socket.write(Buffer.from([5, opts.reply ?? 0, 0, 1, 10, 0, 0, 1, 0, 80]))
        if (opts.reply) return void socket.end()
        stage = 3
      }
      if (stage === 3 && data.length) {
        const text = data.toString('latin1')
        data = Buffer.alloc(0)
        if (!text.startsWith('GET ')) return void socket.write(text)
        heads.push(text.slice(0, text.indexOf('\r\n\r\n')))
        socket.end(`HTTP/1.1 ${opts.reply ?? 500} Whatever\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok`)
      }
    })
  })
  return { server, asked, heads }
}

async function relay(upstream: object): Promise<number> {
  return listen(createRelay(upstream))
}

/** Sends a CONNECT and resolves with the relay's answer line and the socket. */
function tunnel(port: number, authority: string) {
  return new Promise<{ line: string; socket: Socket }>((done) => {
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => {})
    let data = ''
    socket.on('data', function onHead(chunk) {
      data += chunk.toString('latin1')
      if (!data.includes('\r\n\r\n')) return
      socket.off('data', onHead)
      done({ line: data.slice(0, data.indexOf('\r\n')), socket })
    })
    socket.on('close', () => done({ line: data.slice(0, data.indexOf('\r\n')), socket }))
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
  })
}

const echoed = (socket: Socket, text: string) => new Promise<string>((done) => {
  let got = ''
  socket.on('data', (chunk) => { got += chunk.toString(); if (got.length >= text.length) done(got) })
  socket.write(text)
})

/** A plain HTTP request through the relay, in absolute form as a browser sends it to its proxy. */
function get(port: number, url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: url, headers: { host: new URL(url).host, ...headers } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => done({ status: res.statusCode!, body }))
    })
    req.on('error', fail)
    req.end()
  })
}

describe('proxy relay', () => {
  it('adds Proxy-Authorization to CONNECT and to plain HTTP', async () => {
    const upstream = httpProxy()
    const port = await relay({ scheme: 'http', host: '127.0.0.1', port: await listen(upstream.server), username: 'kim', password: 'p4ss' })

    const { line, socket } = await tunnel(port, 'example.test:443')
    expect(line).toBe('HTTP/1.1 200 Connection Established')
    expect(await echoed(socket, 'ping')).toBe('ping')
    socket.destroy()
    expect(upstream.heads[0]).toMatch(/^CONNECT example\.test:443 HTTP\/1\.1\r\n/)
    expect(upstream.heads[0]).toContain(`Proxy-Authorization: ${LOGIN}`)

    // A login the page sent is never forwarded; the relay's own replaces it.
    expect(await get(port, 'http://example.test/page?q=1', { 'proxy-authorization': 'Basic bogus' })).toEqual({ status: 200, body: 'ok' })
    expect(upstream.heads[1]).toMatch(/^GET http:\/\/example\.test\/page\?q=1 HTTP\/1\.1\r\n/)
    expect(upstream.heads[1]!.toLowerCase().split('proxy-authorization: ').length).toBe(2)
    expect(upstream.heads[1]).toContain(`proxy-authorization: ${LOGIN}`)
  })

  it('does a SOCKS5 username/password handshake and sends the host name, never a resolved address', async () => {
    const upstream = socksProxy()
    const port = await relay({ scheme: 'socks5', host: '127.0.0.1', port: await listen(upstream.server), username: 'kim', password: 'p4ss' })

    const { line, socket } = await tunnel(port, 'example.test:443')
    expect(line).toBe('HTTP/1.1 200 Connection Established')
    expect(await echoed(socket, 'ping')).toBe('ping')
    socket.destroy()

    // Through SOCKS5 the request goes to the site itself, so in origin form and with no proxy login.
    expect(await get(port, 'http://example.test:8080/page?q=1')).toEqual({ status: 500, body: 'ok' })
    expect(await get(port, 'http://localhost/')).toMatchObject({ status: 500 })
    expect(upstream.asked).toEqual([
      { login: 'kim:p4ss', type: 3, host: 'example.test', port: 443 },
      { login: 'kim:p4ss', type: 3, host: 'example.test', port: 8080 },
      { login: 'kim:p4ss', type: 3, host: 'localhost', port: 80 },
    ])
    expect(upstream.heads[0]).toMatch(/^GET \/page\?q=1 HTTP\/1\.1\r\n/)
    expect(upstream.heads[0]!.toLowerCase()).not.toContain('proxy-authorization')
  })

  it('relay never connects anywhere but the proxy', async () => {
    let reached = 0
    const site = createServer((socket) => { reached++; socket.destroy() })
    const sitePort = await listen(site)
    for (const scheme of ['http', 'socks5']) {
      const port = await relay({ scheme, host: '127.0.0.1', port: await closedPort(), username: 'kim', password: 'p4ss' })
      expect((await tunnel(port, `127.0.0.1:${sitePort}`)).line, scheme).toBe('HTTP/1.1 502 Bad Gateway')
      expect((await get(port, `http://127.0.0.1:${sitePort}/`)).status, scheme).toBe(502)
    }
    expect(reached).toBe(0)
  })

  it('a 407 from the proxy is a 502 for the page', async () => {
    const upstream = httpProxy(407)
    const port = await relay({ scheme: 'http', host: '127.0.0.1', port: await listen(upstream.server), username: 'kim', password: 'wrong' })
    expect((await tunnel(port, 'example.test:443')).line).toBe('HTTP/1.1 502 Bad Gateway')
    expect((await get(port, 'http://example.test/')).status).toBe(502)
  })

  it('every socket has an error handler', async () => {
    // An upstream that resets the connection as it opens, or once the tunnel carries data.
    let resetAfterData = false
    const upstream = createServer((socket) => {
      if (!resetAfterData) return void socket.resetAndDestroy()
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\n\r\n')
        socket.once('data', () => socket.resetAndDestroy())
      })
    })
    const port = await relay({ scheme: 'http', host: '127.0.0.1', port: await listen(upstream), username: '', password: '' })
    expect((await tunnel(port, 'example.test:443')).line).toBe('HTTP/1.1 502 Bad Gateway')
    expect((await get(port, 'http://example.test/')).status).toBe(502)

    resetAfterData = true
    const { line, socket } = await tunnel(port, 'example.test:443')
    expect(line).toBe('HTTP/1.1 200 Connection Established')
    const closed = new Promise(done => socket.on('close', done))
    socket.write('ping')
    await closed

    // The page's own side resets mid-tunnel.
    const second = await tunnel(port, 'example.test:443')
    second.socket.resetAndDestroy()
    // The relay is still up.
    expect((await tunnel(port, 'example.test:443')).line).toBe('HTTP/1.1 200 Connection Established')
  })
})

describe('start probe', () => {
  it('the start probe fails when the proxy is down or refuses the login', async () => {
    for (const scheme of ['http', 'socks5']) {
      await expect(probe({ scheme, host: '127.0.0.1', port: await closedPort(), username: 'kim', password: 'p4ss' }), scheme).rejects.toThrow()
    }
    const refusing = httpProxy(407)
    await expect(probe({ scheme: 'http', host: '127.0.0.1', port: await listen(refusing.server), username: 'kim', password: 'wrong' }))
      .rejects.toThrow('the proxy refused the login')
    const socks = socksProxy({ acceptLogin: false })
    await expect(probe({ scheme: 'socks5', host: '127.0.0.1', port: await listen(socks.server), username: 'kim', password: 'wrong' }))
      .rejects.toThrow('refused the login')
  })

  it('the start probe passes on any answer through the proxy, including a 429 or a 500 from the lookup service', async () => {
    for (const status of [429, 500]) {
      const upstream = httpProxy(status)
      await expect(probe({ scheme: 'http', host: '127.0.0.1', port: await listen(upstream.server), username: 'kim', password: 'p4ss' })).resolves.toBeUndefined()
      expect(upstream.heads[0]).toMatch(/^GET http:\/\/ip-api\.com\/json\/\?fields=status,timezone,query HTTP\/1\.1\r\n/)
      expect(upstream.heads[0]).toContain(`proxy-authorization: ${LOGIN}`)
    }
    const socks = socksProxy()
    await expect(probe({ scheme: 'socks5', host: '127.0.0.1', port: await listen(socks.server), username: 'kim', password: 'p4ss' })).resolves.toBeUndefined()
    expect(socks.asked).toEqual([{ login: 'kim:p4ss', type: 3, host: 'ip-api.com', port: 80 }])
    expect(socks.heads[0]).toMatch(/^GET \/json\/\?fields=status,timezone,query HTTP\/1\.1\r\n/)
    // A SOCKS5 proxy that cannot reach the lookup service answered: that is the service, not the proxy.
    const unreachable = socksProxy({ reply: 4 })
    await expect(probe({ scheme: 'socks5', host: '127.0.0.1', port: await listen(unreachable.server), username: 'kim', password: 'p4ss' })).resolves.toBeUndefined()
  })
})
