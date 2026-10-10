/** Eager native conversation authority. Legacy search/listing helpers cannot authorize control. */
import { basename } from 'node:path'
import type { BigIntStats } from 'node:fs'
import { sessionStoreOf } from '../engines/sessionStoreContracts.js'
import type { AgentEngine } from '../engines/types.js'
import { NativeEvidenceBudget, nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import { readDescriptorEvidence, descriptorPaths, descriptorKey, type DescriptorEvidence, type NativeDescriptor } from '../engines/kit/nativeDescriptors.js'
import { NativePaths, nativeFileKey } from '../engines/kit/nativePaths.js'
import { descriptorHeader } from '../engines/kit/nativeHeader.js'
import { readProcessEvidence } from './processEvidence.js'
import { argvTokens, engineProcessMatchScore } from './tmux.js'
import type { ProcessIdentity } from './terminalTypes.js'
import type { RepairedSession } from './sessionRepair.js'

export interface NativeConversationSources {
  processes: typeof readProcessEvidence
  descriptors: typeof readDescriptorEvidence
}
export interface NativeConversationOptions {
  expected?: ProcessIdentity
  budget?: NativeEvidenceBudget
  sources?: NativeConversationSources
}
const nativeSources: NativeConversationSources = { processes: readProcessEvidence, descriptors: readDescriptorEvidence }

export async function nativeOpenFiles(pid: number): Promise<string[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return []
  const evidence = await readDescriptorEvidence(pid, new NativeEvidenceBudget())
  await evidence.verify()
  return evidence.descriptors.map(row => row.path).filter(path => path.startsWith('/'))
}

async function conversationDescriptors(engine: AgentEngine, pid: number, budget: NativeEvidenceBudget,
  { expected, sources = nativeSources }: NativeConversationOptions = {}) {
  const live = sessionStoreOf(engine)?.live
  if (!live || !('open' in live)) return { descriptors: [] as readonly NativeDescriptor[], verify: async () => {} }
  const pools: { pid: number; proof: DescriptorEvidence }[] = []
  const process = await sources.processes(pid, budget, async parent => {
    const own = await sources.descriptors(pid, budget)
    pools.push({ pid, proof: own })
    // A launcher can hold another profile's rollout while its native child owns this one.
    // Its filenames cannot establish ownership before the complete pool and headers are read.
    return [parent.executable, parent.nativeArgv?.[0] ?? argvTokens(parent.args)[0] ?? '']
      .some(path => live.open.launcher.test(basename(path)))
  }, expected)
  const children = process.children.filter(row => engineProcessMatchScore(row, engine) > 0)
  if (children.length > 1) return nativeUnavailable('more than one native child could own the conversation')
  if (children.length) pools.push({ pid: children[0].pid, proof: await sources.descriptors(children[0].pid, budget) })
  return { descriptors: pools.flatMap(pool => pool.proof.descriptors), verify: async () => {
    await process.verify()
    for (const pool of pools) await pool.proof.verify()
    // One joined native read checks process generation/image/argv and the complete numeric FD
    // pool. Alternating asynchronous ps/lsof reads always left one stale across the final await.
    await process.verifyDescriptors(new Map(pools.map(pool => [pool.pid, pool.proof.descriptors])), children[0]?.pid)
  } }
}

export async function nativeProcessFiles(engine: AgentEngine, pid: number, options: NativeConversationOptions = {}): Promise<string[]> {
  const evidence = await conversationDescriptors(engine, pid, options.budget ?? new NativeEvidenceBudget(), options)
  await evidence.verify()
  return evidence.descriptors.map(row => row.path).filter(path => path.startsWith('/'))
}

export async function nativeOpenFileSession(engine: AgentEngine, pid: number, roots: readonly string[], cwd: string,
  options: NativeConversationOptions = {},
): Promise<RepairedSession | null> {
  const store = sessionStoreOf(engine), live = store?.live
  if (!store?.first || !live || !('open' in live)) return null
  const budget = options.budget ?? new NativeEvidenceBudget()
  const evidence = await conversationDescriptors(engine, pid, budget, options)
  const paths = new NativePaths(budget)
  if (roots.length > 64) return nativeUnavailable('the native session-home limit was reached')
  const canonicalRoots: BigIntStats[] = []
  for (const root of roots) {
    const location = await paths.resolve(root, true)
    if (location && !location.info.isDirectory()) return nativeUnavailable('a native session home is not a directory')
    if (location) canonicalRoots.push(location.info)
  }
  const headers: { key: string; verify(): void }[] = [], found = new Map<string, RepairedSession>()
  let candidates = 0
  for (const descriptor of evidence.descriptors) {
    const name = descriptor.path.replace(/ \(deleted\)$/, '')
    if (!live.open.file.test(name)) continue
    if (++candidates > 64) return nativeUnavailable('the native rollout descriptor limit was reached')
    if (!/^\d+$/.test(descriptor.fd) || descriptor.path !== name || descriptor.kind !== 'REG' || descriptor.device === undefined || descriptor.inode === undefined) {
      return nativeUnavailable('an open rollout has no available regular file')
    }
    // On macOS lsof escapes names. On Linux readlink is already literal, including backslashes.
    const spellings = process.platform === 'linux' ? [name] : descriptorPaths(name)
    let location: Awaited<ReturnType<NativePaths['resolve']>> = null
    for (const spelling of spellings) {
      const candidate = await paths.resolve(spelling, true)
      if (candidate && nativeFileKey(candidate.info) === descriptorKey(descriptor)) location ??= candidate
    }
    if (!location || !location.info.isFile()) return nativeUnavailable('the open rollout pathname does not name the process file')
    if (!paths.within(location.path, canonicalRoots)) continue
    const key = descriptorKey(descriptor)
    if (headers.some(header => header.key === key)) continue
    const header = await descriptorHeader(location.path, { device: descriptor.device, inode: descriptor.inode }, store.first, budget)
    headers.push({ key, verify: header.verify })
    const meta = header.meta
    if (!('id' in store.byId) || !store.byId.id.test(meta.id)
      || (meta.parentThreadId !== null && !store.byId.id.test(meta.parentThreadId))) return nativeUnavailable('the native rollout has no conclusive conversation id')
    if (meta.isSubagent) continue
    if (!meta.cwd) return nativeUnavailable('the native rollout has no conclusive conversation folder')
    const declared = await paths.resolve(meta.cwd, true), requested = await paths.resolve(cwd, true)
    // A deleted workspace is still an exact string claim. Different missing spellings cannot
    // conclusively exclude a competitor whose old alias no longer resolves.
    if (meta.cwd !== cwd && (!declared || !requested)) return nativeUnavailable('a native conversation folder could not be compared conclusively')
    if ((declared && !declared.info.isDirectory()) || (requested && !requested.info.isDirectory())) return nativeUnavailable('a native conversation folder is not a directory')
    const same = meta.cwd === cwd || (declared && requested && nativeFileKey(declared.info) === nativeFileKey(requested.info))
    if (!same) continue
    found.set(key, { sessionId: meta.id, transcriptPath: location.path })
  }
  await evidence.verify()
  paths.verify()
  // Excluded headers stay evidence too. Check the selected header last, with no later await.
  const selected = found.size === 1 ? found.keys().next().value : undefined
  for (const header of [...headers.filter(header => header.key !== selected), ...headers.filter(header => header.key === selected)]) header.verify()
  if (found.size > 1) return nativeUnavailable('more than one open rollout could own the conversation')
  return found.values().next().value ?? null
}
