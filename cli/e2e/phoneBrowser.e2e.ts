/** Phone sign-in callbacks live in gateway; local work survives losing that process. */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { LocalClient } from './harness/client.js'
import { until } from './harness/daemon.js'
import { startPhoneMachine } from './harness/fleet.js'
import { RelayPhone } from './harness/relayPhone.js'

for (const services of ['gateway,engineSetup', 'none']) {
  it(`routes and redeems a phone callback with services=${services}`, async () => {
    const world = await startPhoneMachine({ env: { HARNESSD_SERVICES: services,
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000' } })
    const { backend, machine } = world, daemon = machine.daemon
    const master = daemon.child!
    const masterClosed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      master.once('close', (code, signal) => resolve({ code, signal }))
    })
    let desk: LocalClient | undefined, phone: RelayPhone | undefined
    const requests: string[] = []
    const server = http.createServer((request, response) => {
      requests.push(request.url ?? '')
      if (request.url?.startsWith('/callback')) {
        response.writeHead(302, { location: '/success' })
        // The replay needs headers only; its own actual socket close ends this response.
        response.flushHeaders()
      } else response.writeHead(200).end('signed in')
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      desk = await LocalClient.connect(daemon, { machineId: machine.machineId })
      const cwd = join(daemon.projectsDir, 'phone-callback'); mkdirSync(cwd, { recursive: true })
      const created = await desk.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
      expect(created.error).toBeUndefined()
      const agentId = created.agent.id as string
      const agent = await until('the phone agent to bind', async () => {
        const listed = await desk!.request<{ agents: Array<Record<string, any>> }>('agents_list', {})
        return listed.agents.find(row => row.id === agentId && row.sessionId) ?? null
      }, 45_000, 100)
      expect(readFileSync(join(daemon.dataDir, 'bin', 'harness-browser'), 'utf8')).toContain('open-url')
      phone = new RelayPhone({ backend, machineId: machine.machineId, identity: world.phone.identity,
        machinePub: machine.identity.pub, token: world.phone.token })
      await until('the gateway to reach the private relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
      await phone.open()
      const ready = phone.next(frame => frame.type === 'terminal_ready' || frame.type === 'terminal_error', 30_000, 'terminal ready')
      expect(phone.send('terminal_open', { agentId, protocolVersion: 3, cols: 100, rows: 30,
        client: { kind: 'phone', name: 'fixture phone' } })).toBe(true)
      const terminal = await ready
      expect(terminal.type).toBe('terminal_ready')
      const ended = phone.next(frame => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, 'phone turn end')
      expect(phone.sendBinary({ kind: TerminalBinaryKind.input, streamId: terminal.payload!.streamId,
        seq: 0, compressed: false, bytes: Buffer.from('callback source\r') })).toBe(true)
      await ended
      const url = `https://sign-in.invalid/authorize?redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`
      const opened = phone.next(frame => frame.type === 'browser_open', 10_000, 'page on the phone')
      expect(await desk.request('browser_open', { pane: agent.tmuxPane, url })).toMatchObject({ handled: true })
      expect((await opened).payload).toMatchObject({ agentId, url })
      const callback = `http://localhost:${port}/callback?code=fixture-only`
      expect(await phone.request('browser_callback', { url: callback })).toMatchObject({ ok: true, status: 302 })
      expect(requests).toEqual(['/callback?code=fixture-only', '/success'])
      expect(await phone.request('browser_callback', { url: callback })).toMatchObject({ error: 'NOT_EXPECTED' })
      expect(daemon.log()).not.toContain('fixture-only')

      if (services !== 'none') {
        const pendingPage = phone.next(frame => frame.type === 'browser_open', 10_000, 'second phone page')
        expect(await desk.request('browser_open', { pane: agent.tmuxPane, url })).toMatchObject({ handled: true })
        await pendingPage
        const pids = daemon.servicePids('gateway')
        expect(pids).toHaveLength(1)
        for (const pid of pids) process.kill(pid, 'SIGKILL')
        await until('the old gateway to end', () => !daemon.servicePids('gateway').includes(pids[0]) || null, 10_000, 50)
        const other = await desk.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
        expect(other.error).toBeUndefined()
        // Creation acknowledges the pane before its engine binds. Early composer input is correctly refused.
        await until('the unrelated local agent to bind', async () => {
          const listed = await desk!.request<{ agents: Array<Record<string, any>> }>('agents_list', {})
          return listed.agents.find(row => row.id === other.agent.id && row.sessionId) ?? null
        }, 45_000, 100)
        await desk.turn(other.agent.id, 'local work after gateway loss')
        await until('the replacement gateway to reach the relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
        await phone.open()
        expect(await phone.request('browser_callback', { url: callback })).toMatchObject({ error: 'NOT_EXPECTED' })
        expect(await desk.request('browser_open', { pane: agent.tmuxPane, url })).toMatchObject({ handled: false })
      }
      expect(daemon.coresStarted()).toBe(1)
    } finally {
      phone?.close(); desk?.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      // The convenience fleet closer swallows daemon cleanup failures. This acceptance case must surface them.
      try {
        await daemon.close()
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          const exited = await Promise.race([masterClosed, new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('phone fixture master did not close')), 5_000)
          })])
          expect(exited).toEqual({ code: 0, signal: null })
          expect(master.stdout?.readableEnded).toBe(true)
          expect(master.stderr?.readableEnded).toBe(true)
          expect(existsSync(daemon.root)).toBe(false)
        } finally { clearTimeout(timeout) }
      } finally { await backend.close() }
    }
  })
}
