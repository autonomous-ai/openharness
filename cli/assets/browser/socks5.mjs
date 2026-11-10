/**
 * The SOCKS5 handshake (RFC 1928, with RFC 1929's username and password) on a socket already connected to the proxy.
 * Shared by the daemon's proxy test (cli/src/services/agentBrowser/exitLookup.ts) and the proxy relay inside the
 * browser's container. It always sends the host name (address type 3) and never resolves it here, so the name is
 * looked up by the proxy and DNS leaves through it too.
 *
 * Plain JavaScript with no imports: the container runs it with its own Node, and the CLI imports it through
 * socks5.d.mts.
 */

const VERSION = 0x05
const NO_LOGIN = 0x00
const LOGIN = 0x02
const LOGIN_VERSION = 0x01
const CONNECT = 0x01
const DOMAIN = 0x03
const IPV4 = 0x01
const IPV6 = 0x04

/**
 * Reads exactly `n` bytes at a time, in paused mode: what the proxy sent after the handshake stays in the socket's own
 * buffer for whoever reads it next, and once the `readable` listener goes, a `data` listener starts the flow as usual.
 */
function reader(socket) {
  let waiting = null
  const fail = (error) => {
    if (!waiting) return
    const { reject } = waiting
    waiting = null
    reject(error)
  }
  const pull = () => {
    if (!waiting) return
    const bytes = socket.read(waiting.n)
    if (bytes === null) return
    // At its end a stream hands over what is left, however short.
    if (bytes.length < waiting.n) return fail(new Error('the SOCKS5 proxy closed the connection'))
    const { resolve } = waiting
    waiting = null
    resolve(bytes)
  }
  const onEnd = () => fail(new Error('the SOCKS5 proxy closed the connection'))
  socket.on('readable', pull)
  socket.on('end', onEnd)
  socket.on('close', onEnd)
  socket.on('error', fail)
  return {
    read: (n) => new Promise((resolve, reject) => { waiting = { n, resolve, reject }; pull() }),
    done: () => {
      socket.off('readable', pull)
      socket.off('end', onEnd)
      socket.off('close', onEnd)
      socket.off('error', fail)
    },
  }
}

/** @param {import('node:stream').Duplex} socket @param {{ host: string, port: number, username: string, password: string }} target */
export async function socks5Connect(socket, { host, port, username, password }) {
  const name = Buffer.from(host, 'utf8')
  const user = Buffer.from(username, 'utf8')
  const pass = Buffer.from(password, 'utf8')
  if (name.length === 0 || name.length > 255) throw new Error('SOCKS5 host names are 1 to 255 bytes')
  if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 logins are at most 255 bytes each')
  const login = user.length > 0 || pass.length > 0
  const bytes = reader(socket)
  try {
    socket.write(Buffer.from([VERSION, 1, login ? LOGIN : NO_LOGIN]))
    const [version, method] = await bytes.read(2)
    if (version !== VERSION) throw new Error('the proxy does not speak SOCKS5')
    if (method !== (login ? LOGIN : NO_LOGIN)) throw new Error('the SOCKS5 proxy refused the login method')
    if (login) {
      socket.write(Buffer.concat([Buffer.from([LOGIN_VERSION, user.length]), user, Buffer.from([pass.length]), pass]))
      const [, status] = await bytes.read(2)
      if (status !== 0) throw new Error('the SOCKS5 proxy refused the login')
    }
    socket.write(Buffer.concat([Buffer.from([VERSION, CONNECT, 0, DOMAIN, name.length]), name, Buffer.from([port >> 8, port & 0xff])]))
    const [, reply, , type] = await bytes.read(4)
    // The reply code tells a proxy that could not reach the target (the target's failure) from one that refused us.
    if (reply !== 0) throw Object.assign(new Error(`the SOCKS5 proxy refused the connection (${reply})`), { reply })
    // The address the proxy bound, then its port: read and dropped.
    const length = type === IPV4 ? 4 : type === IPV6 ? 16 : type === DOMAIN ? (await bytes.read(1))[0] : -1
    if (length < 0) throw new Error('the SOCKS5 proxy answered an unknown address type')
    await bytes.read(length + 2)
  } finally {
    bytes.done()
  }
}
