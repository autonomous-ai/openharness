import { createConnection } from 'node:net'

// Opens a TCP connection to the database; the error names host and port, never the credentials in the URL.
export function connect({ url, connectTimeoutMs }) {
  const { hostname, port } = new URL(url)
  const where = `${hostname}:${port}`
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: hostname, port: Number(port) })
    socket.setTimeout(connectTimeoutMs, () => {
      socket.destroy()
      reject(new Error(`cannot reach database at ${where}: timed out after ${connectTimeoutMs} ms`))
    })
    socket.once('connect', () => {
      socket.setTimeout(0)
      resolve(socket)
    })
    socket.once('error', (error) => reject(new Error(`cannot reach database at ${where}: ${error.code ?? error.message}`)))
  })
}
