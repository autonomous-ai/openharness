// node trust-probe.mjs <owner-profile> <port>: run on the Windows machine as ANOTHER standard user than the daemon's
// owner. It tries what such a user can reach of the owner's daemon and prints one line per attempt, what came back.
// The owner's files must be unreadable and every trusted call refused (docs/testing/windows-cli-e2e.md, scenario 6).
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const [profile, port] = process.argv.slice(2)
if (!profile || !port) { console.error('usage: node trust-probe.mjs <owner-profile> <port>'); process.exit(2) }
const line = (what, result) => console.log(`${what}: ${result}`)
const call = (options, body) => new Promise((resolve) => {
  const req = request(options, (res) => {
    let text = ''
    res.on('data', (chunk) => { text += chunk })
    res.on('end', () => resolve(`${res.statusCode} ${text.slice(0, 160)}`))
  })
  req.on('error', (error) => resolve(`error ${error.code ?? error.message}`))
  req.setTimeout(5000, () => req.destroy(new Error('timeout')))
  req.end(body)
})

const data = join(profile, '.harness', 'cli', 'data')
for (const file of [join(data, `daemon-${port}.json`), join(data, 'daemon-token'), join(data, 'hook-credential')]) {
  try { readFileSync(file); line(`read ${file}`, 'READABLE') } catch (error) { line(`read ${file}`, `refused ${error.code}`) }
}
const pipes = readdirSync('\\\\.\\pipe\\').filter((name) => name.startsWith('harness-'))
line('harness pipes this user can list', pipes.join(' ') || 'none')
const body = '{}'
const headers = { 'content-type': 'application/json', 'x-adapter-local': '1' }
for (const pipe of pipes) {
  const socketPath = `\\\\.\\pipe\\${pipe}`
  line(`${pipe} POST /api/auth/handoff, no proof`, await call({ socketPath, method: 'POST', path: '/api/auth/handoff', headers }, body))
  // B2's nonce form (pipeAuth.ts newPipeNonce): this pipe's id, then 128 random bits. Only the HMAC is wrong.
  const nonce = pipe.slice(-32) + randomBytes(16).toString('hex')
  const forged = `${nonce}.${createHmac('sha256', randomBytes(32)).update(Buffer.concat([Buffer.from([1]), Buffer.from(nonce)])).digest('hex')}`
  line(`${pipe} POST /api/auth/handoff, forged proof`, await call({ socketPath, method: 'POST', path: '/api/auth/handoff', headers: { ...headers, 'x-harness-auth': forged } }, body))
}
line('loopback POST /api/auth/handoff', await call({ host: '127.0.0.1', port: Number(port), method: 'POST', path: '/api/auth/handoff', headers: { ...headers, host: `127.0.0.1:${port}` } }, body))
