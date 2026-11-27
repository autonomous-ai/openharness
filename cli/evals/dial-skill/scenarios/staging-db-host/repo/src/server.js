import { createServer } from 'node:http'
import { loadConfig } from './config.js'
import { reach } from './db.js'

const config = loadConfig()
await reach(config.db)
createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 404).end()
}).listen(config.port, () => console.log(`orders-api on :${config.port}`))
