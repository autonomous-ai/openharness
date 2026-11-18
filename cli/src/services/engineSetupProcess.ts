import { join } from 'node:path'
import { startEngineSetup } from './engineSetup.js'
import { runServiceProcess, type ServiceProcess } from './process.js'
import { writeBrowserShim } from './browserShim.js'

export function runEngineSetupService(options: {
  dataDir: string; socketPath: string; machineId: string; token: string
  run?: typeof runServiceProcess; start?: typeof startEngineSetup
}): ServiceProcess {
  const setup = (options.start ?? startEngineSetup)(join(options.dataDir, 'native-installations'))
  let preparing: Promise<void> | undefined
  let cancel = () => {}
  const requests = Object.fromEntries(Object.entries(setup.requests).map(([name, handler]) => [name,
    ((payload, asker, closed) => {
      const invoke = () => closed?.aborted ? { error: 'SERVICE_UNAVAILABLE' } : handler(payload, asker, closed)
      return preparing ? preparing.then(invoke) : invoke()
    }) satisfies typeof handler,
  ]))
  const service = (options.run ?? runServiceProcess)({
    name: 'engineSetup', socketPath: options.socketPath, machineId: options.machineId, token: options.token,
    requests,
    onConnected: core => {
      cancel()
      let current = true, done!: () => void
      preparing = new Promise(resolve => { done = resolve })
      const finish = () => {
        if (!current) return
        current = false; clearTimeout(timer); preparing = undefined; done()
      }
      const timer = setTimeout(() => { console.warn('[engine-setup] BROWSER_SHIM_TIMEOUT'); finish() }, 1_000)
      timer.unref?.()
      cancel = finish
      // The service's own argv can name a lean entry. Only this connected core supplies the actual CLI command.
      void core.query('daemon').then(answer => {
        if (!current) return
        if (typeof answer.command !== 'string' || !answer.command || answer.command.length > 16_384 || answer.command.includes('\0')
          || !writeBrowserShim(answer.command, join(options.dataDir, 'bin', 'harness-browser'))) {
          console.warn('[engine-setup] BROWSER_SHIM_UNAVAILABLE')
        }
      }).catch(() => { if (current) console.warn('[engine-setup] BROWSER_SHIM_UNAVAILABLE') }).finally(finish)
    },
    onDisconnected: () => { cancel(); setup.disconnect() },
  })
  return { stop() { cancel(); setup.stop(); return service.stop() } }
}
