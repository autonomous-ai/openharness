/** Run the JEV experiment without replacing or restarting the user's Harness daemon. */
import { createServer } from 'node:http'
import { commandBarService } from '../src/lib/commandBar.js'
import { handleCommandBarHttp } from '../src/lib/commandBarHttp.js'

// Optional hidden input for a throwaway experiment. Never write credentials to disk or argv.
if (process.argv.includes('--key-stdin')) {
  if (!process.stdin.isTTY) throw new Error('--key-stdin requires an interactive terminal')
  process.stdout.write('OpenRouter key (hidden, memory only): ')
  const key = await new Promise<string>((resolve, reject) => {
    let input = ''
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const cleanup = () => {
      process.stdin.off('data', read)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
    }
    const read = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (text.includes('\u0003')) { cleanup(); reject(new Error('Cancelled')); return }
      input += text
      if (input.includes('\n') || input.includes('\r')) {
        cleanup(); resolve(input.split(/[\r\n]/)[0].trim())
      }
    }
    process.stdin.on('data', read)
  })
  if (!key.startsWith('sk-or-') || key.length > 512) throw new Error('Invalid OpenRouter key format')
  process.env.OPENROUTER_API_KEY = key
}

const port = Number(process.env.HARNESS_JEV_PORT ?? '18476')
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('HARNESS_JEV_PORT must be between 1024 and 65535')

const server = createServer((req, res) => {
  void handleCommandBarHttp(req, res, commandBarService).then(handled => {
    if (!handled && !res.writableEnded) { res.writeHead(404); res.end() }
  }).catch(() => { if (!res.destroyed) { res.writeHead(500); res.end() } })
})
server.listen(port, '127.0.0.1', async () => {
  const status = await commandBarService.status()
  console.log(`JEV command bar: http://127.0.0.1:${port}`)
  console.log(`OpenRouter: ${status.configured ? 'connected' : 'not configured — use ori login or OPENROUTER_API_KEY'}`)
  console.log('The existing Harness daemon and sessions are unchanged. Ctrl+C stops this experiment server.')
})
server.on('error', () => { console.error(`Could not listen on port ${port}. Choose a free HARNESS_JEV_PORT.`); process.exitCode = 1 })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)))
