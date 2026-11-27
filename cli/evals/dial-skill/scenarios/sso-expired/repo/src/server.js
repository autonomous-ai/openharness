import { createServer } from 'node:http'
import { loadConfig } from './config.js'

const config = loadConfig()

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, env: config.env }))
    return
  }
  res.writeHead(404)
  res.end()
}).listen(Number(process.env.PORT ?? 8080))
