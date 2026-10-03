import { mkdtempSync, rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { startHookServer } from './hookServer.js'
import { localSocketPath } from './lib/localSocket.js'
import { localDaemonStatus } from './lib/daemonEndpoint.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function directory(): string {
  const path = mkdtempSync('/tmp/hn-users-')
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
async function start(dir: string, configuredPort: number, listenPort: number, machineId: string) {
  const daemon = await startHookServer(listenPort, {
    onRegistered: vi.fn(), onSessionEnd: vi.fn(), onStatus: () => ({ machineId, signedIn: false }),
  }, { socketPath: localSocketPath(dir, configuredPort), allowPortFallback: true })
  cleanup.push(async () => {
    await daemon.localSocket?.close()
    daemon.server.closeAllConnections()
    await new Promise<void>((resolve) => daemon.server.close(() => resolve()))
  })
  return daemon
}

it('starts two OS-user services independently even when both request the same TCP port', async () => {
  const a = directory(), b = directory(), configuredPort = 19418
  const first = await start(a, configuredPort, 0, 'account-a')
  const second = await start(b, configuredPort, first.port, 'account-b')
  expect(second.port).not.toBe(first.port)
  expect((await localDaemonStatus(a, configuredPort))?.machineId).toBe('account-a')
  expect((await localDaemonStatus(b, configuredPort))?.machineId).toBe('account-b')
  await expect(start(a, configuredPort, first.port, 'duplicate')).rejects.toThrow(/already serving/)
  expect((await localDaemonStatus(a, configuredPort))?.machineId).toBe('account-a')
})
