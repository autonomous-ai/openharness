// Packaged CLI smoke test. No real account, engine, tmux server or installed daemon is touched.
// Run after `npm run bundle`: node scripts/check-connection-environment.mjs
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { join, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'

if (process.platform === 'win32') throw new Error('This isolated daemon smoke test needs a POSIX shell')
const bundle = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
for (const [saved, configured] of [['stag', 'prod'], ['prod', 'stag']]) {
  const root = mkdtempSync('/tmp/hconn-')
  const auth = join(root, 'auth'), data = join(root, 'data'), bin = join(root, 'bin')
  for (const path of [auth, data, bin]) mkdirSync(path, { recursive: true })
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nif [ "$1" = "-V" ]; then echo "tmux 3.5a"; exit 0; fi\necho "no server running" >&2\nexit 1\n', { mode: 0o700 })
  writeFileSync(join(auth, 'session.json'), JSON.stringify({
    version: 1, accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600_000,
    autonomousEnv: saved, computerId: 'connection-fixture', machineId: '12341234123412341234123412341234', updatedAt: Date.now(),
  }), { mode: 0o600 })
  // Run from a project containing unrelated settings; the explicit daemon configuration must win.
  writeFileSync(join(root, '.env'), 'PORT=1\nBACKEND_WS_URL=ws://wrong-project.invalid\n')
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: { machines: [] } }))
  })
  const wss = new WebSocketServer({ server })
  let connectedUrl = null
  wss.on('connection', (ws, req) => {
    if (req.url?.startsWith('/api/adapter-ws')) connectedUrl = new URL(req.url, 'http://fixture')
    ws.on('error', () => {})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const backendUrl = `ws://127.0.0.1:${server.address().port}`
  let logs = ''
  const child = spawn(process.execPath, [bundle, '__run'], {
    cwd: root,
    env: {
      PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), HOME: root,
      NODE_ENV: 'test', PORT: '0', AUTONOMOUS_ENV: configured, BACKEND_WS_URL: backendUrl,
      ADAPTER_DATA_DIR: data, HARNESS_AUTH_DIR: auth, ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
      ADAPTER_CLI_DIR: join(root, 'cli'), ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
      ADAPTER_COMPUTER_ID: 'connection-fixture', ADAPTER_UPDATE_DISABLE: 'true',
      DISABLE_HOOK_INSTALL: 'true', DISABLE_GRID_INSTALL: 'true', CABLE_DISABLE: 'true',
      HARNESS_DAEMONS: 'off', HARNESS_CODING_MEMORY: '0',
      HARNESS_STORE_CATALOG_URL: `http://127.0.0.1:${server.address().port}/catalog`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  const exited = once(child, 'exit')
  try {
    const deadline = Date.now() + 25_000
    while (!connectedUrl && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(connectedUrl, `daemon failed to connect:\n${logs.slice(-4000)}`)
    assert.equal(connectedUrl.searchParams.get('autonomousEnv'), saved)
    const status = await new Promise((resolve, reject) => {
      const req = http.get({ socketPath: join(data, 'daemon-0.sock'), path: '/api/status', signal: AbortSignal.timeout(2000) }, res => {
        let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve(JSON.parse(body)))
      })
      req.on('error', reject)
    })
    assert.equal(status.autonomousEnv, saved)
    assert.equal(status.backendUrl, backendUrl)
    assert.equal(status.dataDir, data)
    assert.equal(status.authDir, auth)
    console.log(`PASS: saved ${saved} account overrides ${configured} shell; packaged daemon connects and reports its real settings`)
  } finally {
    child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
    await exited
    clearTimeout(kill)
    for (const ws of wss.clients) ws.terminate()
    await new Promise(resolve => wss.close(resolve))
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
}
