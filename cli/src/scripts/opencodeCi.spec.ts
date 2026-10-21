import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

const helper = join(process.cwd(), 'scripts', 'windows-ci', 'opencode.mjs')
const credential = 'a'.repeat(43)
const sentence = 'OpenCode does not run on Windows on Arm yet: its Arm build stops before its screen opens. Use another engine on this computer.'
type Frame = { type: string; payload: Record<string, unknown> }

/** The real helper, an isolated installed profile, and a credential-protected disposable daemon protocol. */
async function run(options: {
  credential?: string | null
  rejectUpgrade?: boolean
  refusal?: string
  leftover?: boolean
  mode?: 'refused' | 'bind'
} = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'opencode-ci-'))
  const root = join(profile, '.harness')
  const data = join(root, 'cli', 'data')
  mkdirSync(data, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'computer-id'), 'fixture-computer\n')
  const file = join(data, 'hook-credential')
  const given = options.credential === undefined ? `${credential}\n` : options.credential
  if (given !== null) writeFileSync(file, given, { mode: 0o600 })
  const requests: Frame[] = []
  let upgrades = 0
  const server = createServer()
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    upgrades++
    if (options.rejectUpgrade || req.headers['x-harness-local'] !== credential) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req))
  })
  sockets.on('connection', ws => {
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as Frame
      requests.push(frame)
      if (frame.type === 'machine_select') {
        ws.send(JSON.stringify({ type: 'connected', payload: { machineId: 'fixture-computer' } }))
        return
      }
      let reply: Record<string, unknown> = {}
      if (frame.type === 'agent_create') reply = options.mode === 'bind'
        ? { agent: { id: 'fixture-agent', launch: { state: 'ready' } } }
        : { error: options.refusal ?? 'ENGINE_LAUNCH_REFUSED', detail: sentence }
      if (frame.type === 'agents_list') reply = { agents: options.mode === 'bind'
        ? [{ id: 'fixture-agent', engine: 'opencode', sessionId: 'fixture-session', status: 'running' }]
        : options.leftover ? [{ id: 'leftover', engine: 'opencode' }] : [] }
      ws.send(JSON.stringify({ type: `${frame.type}_result`, payload: { requestId: frame.payload.requestId, ...reply } }))
    })
  })
  let child: ReturnType<typeof spawn> | undefined
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture has no TCP address')
    const environment = { ...process.env }
    for (const name of Object.keys(environment)) {
      if (['home', 'userprofile', 'port', 'adapter_data_dir'].includes(name.toLowerCase())) delete environment[name]
    }
    child = spawn(process.execPath, [helper, options.mode ?? 'refused', join(profile, 'project')], {
      env: { ...environment, HOME: profile, USERPROFILE: profile, PORT: String(address.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout!.on('data', chunk => { stdout += chunk })
    child.stderr!.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child?.kill(), 5_000)
    let code: number | null
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child!.once('error', reject)
        child!.once('close', resolve)
      })
    } finally { clearTimeout(timer) }
    return { code, stdout, stderr, requests, upgrades, credentialAfter: existsSync(file) ? readFileSync(file, 'utf8') : null }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    for (const client of sockets.clients) client.terminate()
    await new Promise<void>(resolve => sockets.close(() => resolve()))
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(profile, { recursive: true, force: true })
  }
}

describe('the OpenCode installed-daemon CI helper', { timeout: 10_000 }, () => {
  it('authenticates with the installed credential and validates refusal before any pane is left', async () => {
    const out = await run()
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toContain('ok   refused before a pane opened')
    expect(out.requests.map(frame => frame.type)).toEqual(['machine_select', 'agent_create', 'agents_list'])
    expect(out.requests[0].payload).toEqual({ machineId: 'fixture-computer', localProtocolVersion: 1 })
    expect(out.requests[1].payload).toMatchObject({ engine: 'opencode', bypassPermission: false })
    expect(out.requests[1].payload).not.toHaveProperty('prompt')
    expect(out.credentialAfter).toBe(`${credential}\n`)
    expect(out.stdout + out.stderr).not.toContain(credential)
  })

  it.each([null, 'not-a-valid-credential\n'])('refuses a missing or malformed credential without creating one (%s)', async given => {
    const out = await run({ credential: given })
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/valid local credential/i)
    expect(out.upgrades).toBe(0)
    expect(out.requests).toEqual([])
    expect(out.credentialAfter).toBe(given)
  })

  it('reports a real HTTP 401 response rather than calling the live server absent', async () => {
    const out = await run({ rejectUpgrade: true })
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('401')
    expect(out.stderr).not.toContain('no daemon on')
    expect(out.upgrades).toBe(1)
    expect(out.requests).toEqual([])
    expect(out.stdout + out.stderr).not.toContain(credential)
  })

  it.each([{ refusal: 'OTHER_ERROR' }, { leftover: true }])('still rejects incorrect refusal or a leftover OpenCode pane (%j)', async options => {
    const out = await run(options)
    expect(out.code).toBe(1)
    expect(out.stdout).toContain('FAIL')
    expect(out.requests.map(frame => frame.type)).toEqual(['machine_select', 'agent_create', 'agents_list'])
  })

  it('preserves bind mode prompt, session binding and deletion', async () => {
    const out = await run({ mode: 'bind' })
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toContain('bound: fixture-agent has session fixture-session')
    expect(out.requests.map(frame => frame.type)).toEqual(['machine_select', 'agent_create', 'agents_list', 'agent_delete'])
    expect(out.requests[1].payload).toMatchObject({ engine: 'opencode', prompt: 'Reply with the single word ok.' })
    expect(out.requests[3].payload).toMatchObject({ agentId: 'fixture-agent' })
    expect(out.stdout + out.stderr).not.toContain(credential)
  })
})
