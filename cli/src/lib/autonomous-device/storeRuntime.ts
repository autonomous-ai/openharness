/** Narrow adapter onto the SAME Store, project preparation and engine creator used by Desktop.
 * Never passes device frames to BackendSocket's generic dispatcher.
 */
import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BackendSocket } from '../../backendSocket.js'
import { refreshDshRegistry } from '../../dsh/catalog.js'
import { installedDsh, listDshState } from '../../dsh/installed.js'
import { runDshDoctor } from '../../dsh/install.js'
import { viewerUse } from '../../dsh/manifest.js'
import { HARNESS_MONOREPO, type DshRegistryEntry } from '../../dsh/registry.js'
import { mutateDsh } from '../../dsh/service.js'
import { prepareProjectFolder, ProjectFolderError } from '../projectFolder.js'
import { registry } from '../registry.js'
import { AutonomousDeviceStore, type StoreAgent, type StorePackage } from './store.js'
import { DeviceStoreError } from './storeContract.js'

const canonicalPath = (path: string | null): string | null => {
  if (!path) return null
  try { return realpathSync(path) } catch { return path }
}
export function deviceStoreAgents(machineId: string): StoreAgent[] {
  return registry.list().map(s => ({ agentId: s.agentId, machineId, packageId: s.dsh ? installedDsh(s.dsh)?.id ?? s.dsh : null,
    engine: s.engine, workspace: canonicalPath(s.cwd), state: s.active ? 'active' : 'inactive',
    runtime: !registry.terminalAvailable(s.agentId) || s.launch?.state === 'failed' ? 'unavailable'
      : s.launch?.state === 'starting' ? 'starting' : s.active ? (s.launch?.state === 'ready' || s.sessionId || s.engine === 'terminal' ? 'ready' : 'starting') : 'unavailable',
    ...(s.launch?.state === 'failed' ? { error: s.launch.detail ?? s.launch.error } : {}) }))
}
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

export function createDeviceStore(options: { dataDir: string; machineId: string; create: NonNullable<BackendSocket['onCreateAgent']>; reveal?: (operationId: string, agentId: string) => void }): AutonomousDeviceStore {
  return new AutonomousDeviceStore({
    directory: join(options.dataDir, 'device-preparations'), machineId: options.machineId, reveal: options.reveal,
    packages: deviceStorePackages,
    agents: () => deviceStoreAgents(options.machineId),
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
      // Check again immediately before materialization; never retarget another agent.
      if (deviceStoreAgents(options.machineId).some(a => a.workspace === cwd)) return { state: 'failed', error: 'WORKSPACE_IN_USE' }
      const result = await options.create({ engine: pkg.manifest.engine, cwd, dsh: id,
        bypassPermission: false, permissionMode: null, grid: null, codexHome: null, prompt: null, name: null, agent: null })
      if (result.ok) return { state: 'created', agentId: result.session.agentId }
      if (['SPAWN_FAILED', 'REGISTRATION_FAILED'].includes(result.error)) return { state: 'unconfirmed' }
      return { state: 'failed', error: result.error, detail: result.detail }
    },
  })
}
