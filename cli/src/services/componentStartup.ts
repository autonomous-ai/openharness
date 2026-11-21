/** Optional component startup policy. Runs in the existing edge host, never in the default core. */
import { join } from 'node:path'
import { createStartupFiles, type StartupFiles } from './componentStartupFiles.js'

// These paths are the components' state, not part of the core's request or stream contract.
const SAVED_STATE: Readonly<Record<string, readonly string[]>> = {
  orchestrator: ['orchestrator/*.json'],
  sharing: ['harness-shares.json', 'harness-collaboration.json', 'agent-messages/shared-tabs.json'],
  cloud: ['cloud/harnesses.json'],
  agentBrowser: ['agent-browser.json'],
}
const DIAL_LOOK_MS = 2000

export interface ComponentStartupOptions {
  dataDir: string
  runtimeDir: string
  available: ReadonlySet<string>
  started: ReadonlySet<string>
  want(service: string): void
  cableDisabled?: boolean
  testDialPort?: string
  platform?: NodeJS.Platform
  files?: StartupFiles
  log?(line: string): void
}

/** One finite startup pass and, while Devices is still off, one USB-discovery timer. */
export function createComponentStartup(options: ComponentStartupOptions) {
  const log = options.log ?? console.log
  const files = options.files ?? createStartupFiles(log)
  const asked = new Set([...options.started].filter(service => options.available.has(service)))
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const stopLooking = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const want = (service: string, reason: string): void => {
    if (!options.available.has(service) || asked.has(service)) return
    asked.add(service)
    log(`[startup] ${service}: ${reason}`)
    options.want(service)
    if (service === 'devices' || service === 'wifi') stopLooking()
  }
  const stateIsThere = (entry: string): boolean => {
    const slash = entry.lastIndexOf('/')
    const star = entry.indexOf('*', slash + 1)
    return star < 0 ? files.exists(join(options.dataDir, entry))
      : files.matches(join(options.dataDir, entry.slice(0, slash)), entry.slice(slash + 1, star), entry.slice(star + 1))
  }
  for (const [service, state] of Object.entries(SAVED_STATE)) {
    if (options.available.has(service) && !asked.has(service) && state.some(stateIsThere)) want(service, 'saved state')
  }
  if ((options.available.has('gateway') && !asked.has('gateway')) || (options.available.has('wifi') && !asked.has('wifi'))) {
    const direct = files.rows(join(options.dataDir, 'autonomous-device-connections.json'))
    const paired = files.rows(join(options.dataDir, 'e2e', 'paired.json'))
    if (direct.length || paired.length) want('gateway', 'saved links')
    if (direct.length || paired.some(row => (row as { role?: unknown } | null)?.role === 'device')) want('wifi', 'a paired device')
  }
  if (options.available.has('models') && !asked.has('models')) {
    if (files.exists(join(options.runtimeDir, 'current-grid')) || files.matches(join(options.dataDir, 'grid-pictures'), '', '.json')
      || files.matches(join(options.dataDir, 'local-models'), '', '')) want('models', 'saved models')
  }
  if (options.available.has('viewers') && !asked.has('viewers') && files.rows(join(options.dataDir, 'viewers.json')).length) want('viewers', 'retained viewer servers')

  const platform = options.platform ?? process.platform
  const dialThere = (): boolean => {
    if (options.testDialPort) {
      return options.testDialPort.endsWith('.json')
        ? files.rows(options.testDialPort).some(row => typeof (row as { path?: unknown } | null)?.path === 'string')
        : files.exists(options.testDialPort)
    }
    if (platform === 'darwin') return files.matches('/dev', 'cu.usbmodem', '')
    return platform === 'linux' && (files.matches('/dev', 'ttyACM', '') || files.matches('/dev', 'ttyUSB', ''))
  }
  const look = (): void => {
    if (dialThere()) want('devices', 'a dial port')
    else timer = setTimeout(() => { timer = undefined; look() }, DIAL_LOOK_MS).unref()
  }
  if (options.available.has('devices') && !asked.has('devices') && !asked.has('wifi') && !options.cableDisabled) {
    if (platform === 'win32') want('devices', 'Windows USB discovery')
    else look()
  }
  return {
    started(service: string): void {
      if (stopped || !options.available.has(service)) return
      asked.add(service)
      if (service === 'devices' || service === 'wifi') stopLooking()
    },
    stop(): void { stopped = true; stopLooking() },
  }
}
