import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer, type Server, type TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalP2pInitiator, TerminalP2pResponderPool, type TerminalP2pSignal } from './terminalP2p.js'
import { armTurnTls } from './turnTlsGuard.js'

/**
 * A TLS server that accepts TCP and destroys the socket before the handshake finishes.
 * Node reports that to the client as ECONNRESET
 * "Client network socket disconnected before secure TLS connection was established",
 * with the host and port of the dial — the same error that ends the gateway.
 */
function testMaterial(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'turn-tls-reset-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' })
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') }
}

function resettingTlsServer(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  const material = testMaterial()
  let connections = 0
  const server: Server = createServer(
    material,
    (_socket: TLSSocket) => { /* handshake completed; the reset below should prevent this */ },
  )
  server.on('connection', (socket) => {
    connections += 1
    socket.destroy()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { reject(new Error('expected a tcp port')); return }
      resolve({
        port: address.port,
        connections: () => connections,
        close: () => new Promise((done) => { server.close(() => done()) }),
      })
    })
  })
}

function rejectionText(reason: unknown): string {
  if (reason instanceof Error) return `${reason.message} ${(reason as NodeJS.ErrnoException).code ?? ''}`
  return String(reason)
}

describe('TURN over TLS reset', () => {
  const rejections: unknown[] = []
  const onUnhandled = (reason: unknown): void => { rejections.push(reason) }

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    rejections.length = 0
  })

  it('does not kill the process, and a direct pair still opens', async () => {
    const turn = await resettingTlsServer()
    process.on('unhandledRejection', onUnhandled)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let initiator!: TerminalP2pInitiator
    let responderData = ''
    const responder = new TerminalP2pResponderPool({
      // UDP did not answer, so the responder must pick the turns: url (the restricted-network case).
      selectStunUrls: async () => ({ urls: [], udpReachable: false }),
      sendSignal: (_connId, type, payload) => { void initiator.handleSignal(type, payload) },
      onData: (_connId, data) => { responderData = typeof data === 'string' ? data : data.toString() },
    })
    initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: [], openWaitMs: 1_500 },
      selectStunUrls: async () => ({ urls: [], udpReachable: null }),
      sendSignal: (type, payload) => {
        const signal: TerminalP2pSignal = type === 'p2p_offer'
          ? {
              ...payload,
              turn: {
                urls: [
                  'turn:127.0.0.1:3478?transport=udp',
                  `turns:127.0.0.1:${turn.port}?transport=tcp`,
                ],
                username: 'user',
                credential: 'credential',
              },
            }
          : payload
        void responder.handleSignal('source-1', type, signal)
      },
      onData: () => { /* the responder is the side that dials TURN */ },
    })

    try {
      initiator.start()
      expect(await initiator.waitUntilReady(8_000)).toBe(true)
      // The orphaned reconnect rejects on a later turn of the event loop than the handshake error.
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(rejections.map(rejectionText)).toEqual([])
      expect(initiator.send('still-up')).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(responderData).toBe('still-up')
      // One dial. A reconnect loop would open a socket per failure.
      expect(turn.connections()).toBe(1)
    } finally {
      log.mockRestore()
      await initiator?.stop('test_complete', false)
      await responder.stop()
      await turn.close()
    }
  }, 15_000)

  it('fails a relay-only negotiation instead of rejecting out of the process', async () => {
    const turn = await resettingTlsServer()
    process.on('unhandledRejection', onUnhandled)
    const states: string[] = []
    const signals: string[] = []
    const initiator = new TerminalP2pInitiator({
      policy: {
        enabled: true,
        protocolVersion: 1,
        stunUrls: [],
        openWaitMs: 1_500,
        turn: {
          urls: [
            'turn:127.0.0.1:3478?transport=udp',
            `turns:127.0.0.1:${turn.port}?transport=tcp`,
          ],
          username: 'user',
          credential: 'credential',
        },
      },
      relayOnly: true,
      selectStunUrls: async () => ({ urls: [], udpReachable: false }),
      sendSignal: (type) => { signals.push(type) },
      onData: () => { /* no peer answers; the ws relay would keep the terminal */ },
      onState: (state) => { states.push(state) },
    })

    try {
      initiator.start()
      const started = Date.now()
      while (rejections.length === 0 && signals.length === 0 && Date.now() - started < 8_000) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(rejections.map(rejectionText)).toEqual([])
      // Gathering survived the reset, so an offer went out with no relay candidate to nominate.
      // Nothing answers it; the existing negotiation timeout is what returns the terminal to the relay.
      expect(signals).toContain('p2p_offer')
      expect(states[0]).toBe('connecting')
      expect(turn.connections()).toBe(1)
    } finally {
      await initiator.stop('test_complete', false)
      await turn.close()
    }
  }, 15_000)

  it('still reports end once the TURN TLS handshake has finished', async () => {
    const material = testMaterial()
    let port = 0
    const server = createServer({ key: material.key, cert: material.cert }, (socket) => { socket.end() })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('expected a tcp port')); return }
        port = address.port
        resolve()
      })
    })
    armTurnTls({ url: `turns:127.0.0.1:${port}?transport=tcp` })
    const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
    const ended = new Promise<string>((resolve) => { socket.on('end', () => resolve('ended')) })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', () => resolve())
        socket.once('error', reject)
      })
      expect(await ended).toBe('ended')
    } finally {
      socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
  })
})
