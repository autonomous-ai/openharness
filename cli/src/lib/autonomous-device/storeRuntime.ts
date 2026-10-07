/** Narrow adapter onto the SAME Store, project preparation and engine creator used by Desktop.
 * Never passes device frames to BackendSocket's generic dispatcher. It runs with the Wi-Fi device's
 * service, in the devices' process (services/wifi.ts): the agents it reads and the one it creates are the
 * core's (`CoreApi.wifi.view` and `create`, core/wifiAgents.ts).
 */
import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ForkResult } from '../../core/api.js'
import { refreshDshRegistry } from '../../dsh/catalog.js'
import { installedDsh, listDshState } from '../../dsh/installed.js'
import { runDshDoctor } from '../../dsh/install.js'
import { viewerUse } from '../../dsh/manifest.js'
import { HARNESS_MONOREPO, type DshRegistryEntry } from '../../dsh/registry.js'
import { mutateDsh } from '../../dsh/service.js'
import { prepareProjectFolder, ProjectFolderError } from '../projectFolder.js'
import { AutonomousDeviceStore, type StoreAgent, type StorePackage } from './store.js'
import { DeviceStoreError } from './storeContract.js'

function trusted(entry: DshRegistryEntry | undefined): boolean {
  return !!entry && entry.verified === true && entry.repo.replace(/\.git$/, '') === HARNESS_MONOREPO
    && entry.id.startsWith('autonomous/') && entry.path === `store/${entry.kind === 'viewer' ? 'viewers' : 'agents'}/${entry.id.slice(11)}`
}
export async function deviceStorePackages(): Promise<StorePackage[]> {
  const catalog = await refreshDshRegistry()
  const { installed, broken } = listDshState()
  const ids = new Set([...catalog.filter(e => e.kind !== 'viewer').map(e => e.id), ...installed.filter(e => e.manifest.kind !== 'viewer').map(e => e.id), ...broken.map(e => e.id)])
  const byId = new Map(catalog.map(e => [e.id, e]))
  const allowed = (id: string, seen = new Set<string>()): boolean => {
    if (installedDsh(id)) return true // already installed by the owner
    if (seen.has(id)) return false
    seen.add(id)
    const e = byId.get(id)
    return trusted(e) && (!e?.viewerUse || allowed(e.viewerUse, seen))
  }
  return [...ids].sort().map(id => {
    const record = installed.find(e => e.id === id), entry = byId.get(id), bad = broken.find(e => e.id === id)
    const m = record?.manifest
    return { packageId: id, name: (m?.name ?? entry?.name ?? id).slice(0, 200), description: (m?.description ?? entry?.description ?? '').slice(0, 1000),
      category: m?.category ?? entry?.category ?? null, engine: m?.engine ?? entry?.engine ?? null,
      installed: !!record || !!bad, catalog: !!entry, verified: trusted(entry),
      viewerPackageId: m ? viewerUse(m) : entry?.viewerUse ?? null, installAllowed: allowed(id),
      version: record?.revision ?? record?.commit ?? null, broken: bad?.error.slice(0, 1000) ?? null }
  })
}

export interface DeviceStoreOptions {
  dataDir: string
  machineId: string
  /** Every agent with the Store's evidence on it, as the core last listed them. */
  agents(): StoreAgent[]
  /** The core starts the agent, with the device's fixed launch arguments, unless another works in `cwd`. */
  create(packageId: string, engine: string, cwd: string): Promise<ForkResult>
  reveal?: (operationId: string, agentId: string) => void
}

export function createDeviceStore(options: DeviceStoreOptions): AutonomousDeviceStore {
  return new AutonomousDeviceStore({
    directory: join(options.dataDir, 'device-preparations'), machineId: options.machineId, reveal: options.reveal,
    packages: deviceStorePackages,
    agents: () => options.agents(),
    install: async (id, progress) => {
      const pkg = (await deviceStorePackages()).find(p => p.packageId === id)
      if (!pkg?.installAllowed) return { ok: false, error: 'PACKAGE_REVIEW_REQUIRED', detail: 'Review this package and its dependencies in Harness Store first.' }
      return mutateDsh({ id }, p => progress(p.phase))
    },
    doctor: async id => {
      const root = installedDsh(id)
      if (!root) return { ok: false, checked: false, lines: ['Package is not installed'] }
      const dependency = viewerUse(root.manifest)
      const viewer = dependency ? installedDsh(dependency) : undefined
      if (dependency && !viewer) return { ok: false, checked: false, lines: [`Missing viewer ${dependency}. Install it through Harness Store.`] }
      const lines: string[] = []
      let checked = true
      for (const pkg of [root, ...(viewer ? [viewer] : [])]) {
        checked &&= !!pkg.manifest.toolchain?.doctor
        const result = await runDshDoctor(pkg)
        lines.push(...result.lines.map(l => `${pkg.id}: ${l}`))
        if (!result.ok) return { ok: false, checked, lines }
      }
      return { ok: true, checked, lines }
    },
    workspace: async (request, label) => {
      if (request.kind === 'new') {
        try { return realpathSync(await prepareProjectFolder({ source: 'new', ...(request.name ? { name: request.name } : {}) }, { label })) }
        catch (error) {
          if (error instanceof ProjectFolderError) throw new DeviceStoreError(error.code, error.message)
          throw error
        }
      }
      try {
        const path = realpathSync(request.path)
        if (!statSync(path).isDirectory()) throw new Error('Not a directory')
        return path
      } catch { throw new DeviceStoreError('INVALID_WORKSPACE', 'Select an existing accessible directory, or request a new workspace.') }
    },
    create: async (id, cwd) => {
      const pkg = installedDsh(id)
      if (!pkg?.manifest.engine || pkg.manifest.kind === 'viewer') return { state: 'failed', error: 'INVALID_DSH' }
      // The core checks again immediately before materialization, where the agents are: never retarget another agent.
      const result = await options.create(id, pkg.manifest.engine, cwd)
      if (result.ok) return { state: 'created', agentId: result.agentId }
      if (result.error === 'WORKSPACE_IN_USE') return { state: 'failed', error: 'WORKSPACE_IN_USE' }
      if (['SPAWN_FAILED', 'REGISTRATION_FAILED'].includes(result.error)) return { state: 'unconfirmed' }
      return { state: 'failed', error: result.error, detail: result.detail }
    },
  })
}
