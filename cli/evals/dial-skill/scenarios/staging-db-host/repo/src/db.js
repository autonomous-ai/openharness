import { createConnection } from 'node:net'

// A plain TCP connection to the database's port: enough to know the host answers, without a Postgres driver.
export function reach({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const fail = (reason) => {
      socket.destroy()
      reject(new Error(`cannot reach ${host}:${port} (${reason})`))
    }
    socket.setTimeout(timeoutMs, () => fail(`no answer in ${timeoutMs} ms`))
    socket.once('error', (error) => fail(error.code ?? 'error'))
    socket.once('connect', () => {
      socket.end()
      resolve()
    })
  })
}
