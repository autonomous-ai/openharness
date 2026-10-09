/** Filesystem evidence for binding, declared by each engine and available before optional readers load. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { readlink, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { identityEntries, identityFile, identityScanBudget, IdentityReadUnavailable } from './identityScan.js'

export type TranscriptLocation = { id: RegExp; root: string } & (
  | { kind: 'direct'; file: readonly string[] }
  | { kind: 'projects'; folder: string; suffix: string }
  | { kind: 'cwd'; file: string; sidecar: string }
)

export type ProcessSessionLocation = { id: RegExp; root: string; suffix: string } & (
  | { kind: 'newest-lock'; prefix: string }
  | { kind: 'open-lock'; timeoutMs: number }
)

async function inspect(path: string): Promise<Stats | null> {
  try { return await stat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new IdentityReadUnavailable('a native location could not be inspected')
  }
}
async function fileInfo(path: string): Promise<Stats | null> {
  const info = await inspect(path)
  if (info && !info.isFile()) throw new IdentityReadUnavailable('a native identity location is not a regular file')
  return info
}
const signature = (info: Stats | null) => info && `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
const fileIdentity = (info: Stats | null) => info && `${info.dev}:${info.ino}`
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
type WorkspaceProof = { path: string; digest: string }
async function verifyWorkspace(proof: WorkspaceProof): Promise<void> {
  const current = await identityFile(proof.path).catch(() => { throw new IdentityReadUnavailable('a workspace sidecar became unavailable during lookup') })
  if (digest(current) !== proof.digest) throw new IdentityReadUnavailable('a workspace sidecar changed during lookup')
}
// Evidence belongs to this one listing, not a cache reused by later polls.
const groupProofs = new WeakMap<readonly string[], { root: string; signature: string | null }>()

/** A complete bounded listing. An unreadable directory is not an empty store. */
export async function transcriptGroups(home: string, rule: TranscriptLocation): Promise<string[]> {
  const root = join(home, rule.root), groups: string[] = []
  const before = signature(await inspect(root))
  for await (const entry of identityEntries(root, identityScanBudget())) {
    if (entry.isDirectory()) groups.push(entry.name)
    else if (entry.isSymbolicLink()) {
      const info = await inspect(join(root, entry.name))
      if (!info) throw new IdentityReadUnavailable('a native directory link disappeared')
      if (info.isDirectory()) groups.push(entry.name)
    }
  }
  if (signature(await inspect(root)) !== before) throw new IdentityReadUnavailable('the native directory list changed during lookup')
  groupProofs.set(groups, { root, signature: before })
  return groups
}

/** One known id in a complete pool. Two different files cannot both be its authoritative transcript. */
export async function locateTranscript(rule: TranscriptLocation, home: string, id: string,
  options: { cwd?: string; groups?: readonly string[]; valid?: (path: string) => boolean } = {},
): Promise<string | null> {
  if (!rule.id.test(id)) return null
  const root = join(home, rule.root)
  if (rule.kind === 'direct') {
    const path = join(root, id, ...rule.file)
    return await fileInfo(path) ? path : null
  }
  if (rule.kind === 'cwd' && !options.cwd) return null
  if (options.groups && options.groups.length > 4096) throw new IdentityReadUnavailable('the native location probe limit was reached')
  const shared = options.groups && groupProofs.get(options.groups)
  const groups = shared?.root === root ? options.groups! : await transcriptGroups(home, rule)
  const proof = groupProofs.get(groups)!
  const files: { path: string; info: Stats | null }[] = []
  // Keep fixed-size digests, not up to 64 KiB of retained text for every project.
  const sidecars: WorkspaceProof[] = []
  let selected: { path: string; info: Stats; workspace?: WorkspaceProof } | null = null
  for (const group of groups) {
    const directory = join(root, group)
    const path = rule.kind === 'projects'
      ? join(directory, rule.folder, id, `${id}${rule.suffix}`) : join(directory, id, rule.file)
    const info = await fileInfo(path)
    files.push({ path, info })
    if (!info) continue
    let workspace: WorkspaceProof | undefined
    if (rule.kind === 'cwd' && group !== encodeURIComponent(options.cwd!)) {
      let cwd: string
      try {
        const sidecar = join(directory, rule.sidecar), text = await identityFile(sidecar)
        workspace = { path: sidecar, digest: digest(text) }
        sidecars.push(workspace); cwd = text.trim()
      }
      catch (error) {
        if (error instanceof IdentityReadUnavailable) throw error
        throw new IdentityReadUnavailable('the native workspace sidecar could not be read')
      }
      if (!isAbsolute(cwd)) throw new IdentityReadUnavailable('the native workspace sidecar is invalid')
      if (cwd !== options.cwd) continue
    }
    // Only an existing candidate pays for the registry's synchronous realpath validation.
    if (options.valid && !options.valid(path)) continue
    if (selected && (selected.info.dev !== info.dev || selected.info.ino !== info.ino)) {
      throw new IdentityReadUnavailable('more than one transcript matches the conversation')
    }
    selected ??= { path, info, workspace }
  }
  // Negative candidates matter too: a competing file may appear while later projects are read.
  for (const file of files) {
    if (file.path !== selected?.path && fileIdentity(await fileInfo(file.path)) !== fileIdentity(file.info)) {
      throw new IdentityReadUnavailable('a transcript candidate changed during lookup')
    }
  }
  for (const sidecar of sidecars) {
    if (sidecar !== selected?.workspace) await verifyWorkspace(sidecar)
  }
  if (signature(await inspect(root)) !== proof.signature) throw new IdentityReadUnavailable('the native directory list changed during lookup')
  if (!selected) return null
  // Appending conversation records does not change the identity of its file.
  if (fileIdentity(await fileInfo(selected.path)) !== fileIdentity(selected.info)) {
    throw new IdentityReadUnavailable('the selected transcript changed during lookup')
  }
  // The selected workspace must survive every other native await, including other sidecars.
  if (selected.workspace) await verifyWorkspace(selected.workspace)
  if (options.valid && !options.valid(selected.path)) throw new IdentityReadUnavailable('the selected transcript path changed during lookup')
  return selected.path
}

const execFileAsync = promisify(execFile)
const DESCRIPTOR_BYTES = 256 * 1024

/** Native process evidence is useful only when every relevant claim could be inspected. */
export async function locateProcessSession(rule: ProcessSessionLocation, home: string, pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const root = join(home, rule.root)
  if (rule.kind === 'newest-lock') {
    const before = signature(await inspect(root))
    const claims: { path: string; id: string; info: Stats | null }[] = []
    let best: typeof claims[number] | null = null
    let tied = false
    for await (const entry of identityEntries(root, identityScanBudget())) {
      if (!rule.id.test(entry.name)) continue
      if (entry.isSymbolicLink()) throw new IdentityReadUnavailable('a native session directory is a symbolic link')
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name, `${rule.prefix}${pid}${rule.suffix}`)
      const claim = { path, id: entry.name, info: await fileInfo(path) }
      claims.push(claim)
      if (!claim.info) continue
      if (!best || claim.info.mtimeMs > best.info!.mtimeMs) { best = claim; tied = false }
      else if (claim.info.mtimeMs === best.info!.mtimeMs) tied = true
    }
    if (tied) throw new IdentityReadUnavailable('the newest process lock is ambiguous')
    // A current claim is checked last so no later native await can make its answer stale.
    for (const claim of claims.filter(claim => claim !== best)) {
      if (signature(await fileInfo(claim.path)) !== signature(claim.info)) {
        throw new IdentityReadUnavailable('a process lock changed during lookup')
      }
    }
    if (signature(await inspect(root)) !== before) throw new IdentityReadUnavailable('the native session directories changed during lookup')
    if (best && signature(await fileInfo(best.path)) !== signature(best.info)) {
      throw new IdentityReadUnavailable('a process lock changed during lookup')
    }
    return best?.id ?? null
  }
  let paths: string[]
  if (process.platform === 'linux') {
    const directory = `/proc/${pid}/fd`, budget = identityScanBudget()
    const descriptors: { name: string; path: string }[] = []
    const read = async (name: string): Promise<string> => {
      try {
        const path = await readlink(join(directory, name))
        if (path) return path
      } catch { /* A disappearing descriptor cannot prove a complete pool. */ }
      throw new IdentityReadUnavailable('a process descriptor could not be read')
    }
    for await (const entry of identityEntries(directory, budget, false)) {
      descriptors.push({ name: entry.name, path: await read(entry.name) })
    }
    const claimed = descriptors.filter(entry => entry.path.startsWith(root + sep) && entry.path.endsWith(rule.suffix))
    for (const entry of descriptors.filter(entry => !claimed.includes(entry))) {
      if (await read(entry.name) !== entry.path) throw new IdentityReadUnavailable('a process descriptor changed during lookup')
    }
    const names: string[] = []
    for await (const entry of identityEntries(directory, budget, false)) names.push(entry.name)
    if (names.sort().join('\0') !== descriptors.map(entry => entry.name).sort().join('\0')) {
      throw new IdentityReadUnavailable('the process descriptor list changed during lookup')
    }
    // Recheck actual conversation descriptors last, after the complete pool is known.
    for (const entry of claimed) {
      if (await read(entry.name) !== entry.path) throw new IdentityReadUnavailable('a process descriptor changed during lookup')
    }
    paths = descriptors.map(entry => entry.path)
  } else {
    const probe = async (): Promise<string[]> => {
      let out: string
      try {
        out = (await execFileAsync('lsof', ['-n', '-P', '-w', '-p', String(pid), '-Fn'], {
          encoding: 'utf8', timeout: rule.timeoutMs, killSignal: 'SIGKILL', maxBuffer: DESCRIPTOR_BYTES,
        })).stdout
      } catch { throw new IdentityReadUnavailable('the process descriptor probe did not complete') }
      if (Buffer.byteLength(out) > DESCRIPTOR_BYTES || (out && !out.endsWith('\n'))) {
        throw new IdentityReadUnavailable('the process descriptor output is incomplete')
      }
      const lines = out.split('\n')
      if (lines.length > 4096) throw new IdentityReadUnavailable('the process descriptor entry limit was reached')
      return lines.filter(line => line.startsWith('n')).map(line => line.slice(1)).sort()
    }
    paths = await probe()
    if ((await probe()).join('\0') !== paths.join('\0')) throw new IdentityReadUnavailable('the process descriptors changed during lookup')
  }
  const ids = new Set<string>()
  for (const path of paths) {
    if (path.startsWith(root + sep) && path.endsWith(`${rule.suffix} (deleted)`)) {
      throw new IdentityReadUnavailable('the process holds a deleted conversation lock')
    }
    if (!path.startsWith(root + sep) || !path.endsWith(rule.suffix)) continue
    const id = basename(path, rule.suffix)
    if (rule.id.test(id)) ids.add(id)
  }
  if (ids.size > 1) throw new IdentityReadUnavailable('the process holds more than one conversation lock')
  return ids.values().next().value ?? null
}

/** A cwd in the opening records, with its envelope and field path declared by the engine. */
export function recordCwd(lines: readonly string[], rule: { type: string; field: readonly string[] }): string | null {
  for (const line of lines) {
    try {
      const record = JSON.parse(line)
      if (record?.type !== rule.type) continue
      let value: unknown = record
      for (const key of rule.field) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
      return typeof value === 'string' && value ? value : null
    } catch { /* an incomplete record is checked on the next scan */ }
  }
  return null
}
