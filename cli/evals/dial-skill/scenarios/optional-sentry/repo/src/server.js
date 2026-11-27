import { createServer } from 'node:http'
import { handle } from './app.js'

// The container health check runs `--check`: the /health response without opening a port.
if (process.argv.includes('--check')) {
  const { status, body } = handle('GET', '/health')
  console.log(JSON.stringify(body))
  process.exit(status === 200 ? 0 : 1)
}

const port = Number(process.env.PORT ?? 8080)
createServer((req, res) => {
  const { status, body } = handle(req.method, req.url)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}).listen(port, () => console.log(`billing-api listening on ${port}`))
