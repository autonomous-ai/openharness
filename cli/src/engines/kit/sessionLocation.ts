/** Filesystem evidence for binding, declared by each engine and available before optional readers load. */
import { execFile } from 'node:child_process'
import { access, readdir, readFile, readlink, stat } from 'fs/promises'
import { basename, join, sep } from 'node:path'
import { promisify } from 'node:util'

export type TranscriptLocation = { id: RegExp; root: string } & (
  | { kind: 'direct'; file: readonly string[] }
  | { kind: 'projects'; folder: string; suffix: string }
  | { kind: 'cwd'; file: string; sidecar: string }
)

export type ProcessSessionLocation = { id: RegExp; root: string; suffix: string } & (
  | { kind: 'newest-lock'; prefix: string }
  | { kind: 'open-lock'; timeoutMs: number }
)

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

export async function transcriptGroups(home: string, rule: TranscriptLocation): Promise<string[]> {
  return readdir(join(home, rule.root)).catch(() => [])
}

/** One known id, never a guess by newest transcript. A grouped lookup may share its listing across a sweep. */
export async function locateTranscript(rule: TranscriptLocation, home: string, id: string,
  options: { cwd?: string; groups?: readonly string[]; valid?: (path: string) => boolean } = {},
): Promise<string | null> {
  if (!rule.id.test(id)) return null
  const root = join(home, rule.root)
  if (rule.kind === 'direct') {
    const path = join(root, id, ...rule.file)
    return await isFile(path) ? path : null
  }
  if (rule.kind === 'cwd') {
    if (!options.cwd) return null
    const direct = join(root, encodeURIComponent(options.cwd), id, rule.file)
    if (await isFile(direct)) return direct
    const groups = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const group of groups) {
      if (!group.isDirectory()) continue
      const directory = join(root, group.name)
      const cwd = await readFile(join(directory, rule.sidecar), 'utf8').catch(() => '')
      if (cwd.trim() !== options.cwd) continue
      const path = join(directory, id, rule.file)
      if (await isFile(path)) return path
    }
    return null
  }
  for (const group of options.groups ?? await transcriptGroups(home, rule)) {
    const path = join(root, group, rule.folder, id, `${id}${rule.suffix}`)
    // Only an existing candidate pays for the registry's synchronous realpath validation.
    if (!await access(path).then(() => true, () => false)) continue
    if (!options.valid || options.valid(path)) return path
  }
  return null
}

const execFileAsync = promisify(execFile)

/** Native process evidence: the newest session lock, or a lock descriptor the process still holds. */
export async function locateProcessSession(rule: ProcessSessionLocation, home: string, pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const root = join(home, rule.root)
  if (rule.kind === 'newest-lock') {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    let best: { id: string; time: number } | null = null
    for (const entry of entries) {
      if (!entry.isDirectory() || !rule.id.test(entry.name)) continue
      const info = await stat(join(root, entry.name, `${rule.prefix}${pid}${rule.suffix}`)).catch(() => null)
      if (info && (!best || info.mtimeMs > best.time)) best = { id: entry.name, time: info.mtimeMs }
    }
    return best?.id ?? null
  }
  let paths: string[]
  if (process.platform === 'linux') {
    const directory = `/proc/${pid}/fd`
    const entries = await readdir(directory).catch(() => [])
    paths = []
    for (const entry of entries) {
      const path = await readlink(join(directory, entry)).catch(() => '')
      if (path) paths.push(path)
    }
  } else {
    const out = await execFileAsync('lsof', ['-w', '-p', String(pid), '-Fn'], { timeout: rule.timeoutMs })
      .then(result => result.stdout).catch((error: { stdout?: string }) => error.stdout ?? '')
    paths = out.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1))
  }
  for (const path of paths) {
    if (!path.startsWith(root + sep) || !path.endsWith(rule.suffix)) continue
    const id = basename(path, rule.suffix)
    if (rule.id.test(id)) return id
  }
  return null
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
