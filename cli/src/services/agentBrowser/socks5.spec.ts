import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { socks5Connect } from '../../../assets/browser/socks5.mjs'

/** A SOCKS5 proxy that records what it was asked, answers in pieces, and then echoes. */
function proxy(opts: { acceptLogin?: boolean; method?: number; reply?: number; boundType?: number } = {}) {
  const asked: { methods: number[]; login: { user: string; pass: string } | null; type: number; host: string; port: number }[] = []
  const server = createServer((socket) => {
    let data = Buffer.alloc(0)
    let stage = 0
    const seen = { methods: [] as number[], login: null as { user: string; pass: string } | null, type: 0, host: '', port: 0 }
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk])
      if (stage === 0 && data.length >= 2 && data.length >= 2 + data[1]!) {
        seen.methods = [...data.subarray(2, 2 + data[1]!)]
        data = data.subarray(2 + data[1]!)
        stage = seen.methods.includes(2) ? 1 : 2
        socket.write(Buffer.from([5, opts.method ?? seen.methods[0]!]))
      }
      if (stage === 1 && data.length >= 2) {
        const ulen = data[1]!
        if (data.length < 3 + ulen) return
        const plen = data[2 + ulen]!
        if (data.length < 3 + ulen + plen) return
        seen.login = { user: data.subarray(2, 2 + ulen).toString(), pass: data.subarray(3 + ulen, 3 + ulen + plen).toString() }
        data = data.subarray(3 + ulen + plen)
        const ok = opts.acceptLogin !== false
        socket.write(Buffer.from([1, ok ? 0 : 1]))
        if (!ok) return void socket.end()
        stage = 2
      }
      if (stage === 2 && data.length >= 5) {
        const len = data[4]!
        if (data.length < 7 + len) return
        seen.type = data[3]!
        seen.host = data.subarray(5, 5 + len).toString()
        seen.port = data.readUInt16BE(5 + len)
        data = data.subarray(7 + len)
        asked.push(seen)
        stage = 3
        const bound = opts.boundType === 3 ? Buffer.from([3, 4, ...Buffer.from('host')]) : Buffer.from([1, 10, 0, 0, 1])
        const reply = Buffer.concat([Buffer.from([5, opts.reply ?? 0, 0]), bound, Buffer.from([0x1f, 0x90])])
        // Split, and the first bytes of the tunnel in the same write as the end of the reply.
        socket.write(reply.subarray(0, 3))
        setTimeout(() => socket.write(Buffer.concat([reply.subarray(3), Buffer.from('hello ')])), 10)
        return
      }
      if (stage === 3 && data.length) { socket.write(data); data = Buffer.alloc(0) }
    })
  })
  return { server, asked }
}

const servers: Server[] = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })

async function dial(server: Server): Promise<Socket> {
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const socket = connect((server.address() as AddressInfo).port, '127.0.0.1')
  await new Promise(done => socket.once('connect', done))
  return socket
}

const readSome = (socket: Socket, length: number) => new Promise<string>((done) => {
  let got = ''
  socket.on('data', (chunk) => { got += chunk.toString(); if (got.length >= length) done(got) })
})

describe('socks5Connect', () => {
  it('sends the host name, never a resolved address', async () => {
    for (const boundType of [1, 3]) {
      const { server, asked } = proxy({ boundType })
      const socket = await dial(server)
      await socks5Connect(socket, { host: 'ip-api.com', port: 80, username: 'kim', password: 'p4ss' })
      expect(asked).toEqual([{ methods: [2], login: { user: 'kim', pass: 'p4ss' }, type: 3, host: 'ip-api.com', port: 80 }])
      // The tunnel's first bytes, sent with the end of the reply, are not lost to the handshake.
      const read = readSome(socket, 'hello ping'.length)
      socket.write('ping')
      expect(await read).toBe('hello ping')
      socket.destroy()
    }
  })

  it('offers no login when it has none', async () => {
    const { server, asked } = proxy()
    const socket = await dial(server)
    await socks5Connect(socket, { host: 'ip-api.com', port: 443, username: '', password: '' })
    expect(asked[0]).toMatchObject({ methods: [0], login: null, port: 443 })
    socket.destroy()
  })

  it('a refused login rejects', async () => {
    const socket = await dial(proxy({ acceptLogin: false }).server)
    await expect(socks5Connect(socket, { host: 'ip-api.com', port: 80, username: 'kim', password: 'wrong' })).rejects.toThrow('refused the login')
    socket.destroy()
  })

  it('a refused method, a refused connection and a closed proxy reject', async () => {
    let socket = await dial(proxy({ method: 0xff }).server)
    await expect(socks5Connect(socket, { host: 'ip-api.com', port: 80, username: 'kim', password: 'p' })).rejects.toThrow('login method')
    socket.destroy()
    socket = await dial(proxy({ reply: 5 }).server)
    await expect(socks5Connect(socket, { host: 'ip-api.com', port: 80, username: '', password: '' })).rejects.toThrow('refused the connection (5)')
    socket.destroy()
    socket = await dial(createServer(peer => peer.end()))
    await expect(socks5Connect(socket, { host: 'ip-api.com', port: 80, username: '', password: '' })).rejects.toThrow('closed the connection')
  })
})
