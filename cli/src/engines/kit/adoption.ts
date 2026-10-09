/**
 * Adoption as an engine's contract declares it (facets/adoption.ts): its conversations on disk, the process that
 * holds each, and whether a turn is running there. Moved from lib/sessionSearch/externals/{claude,codex}.ts, whose
 * every answer this reproduces (engines/transcriptReads.golden.spec.ts). A provider reads the engine's own store and
 * nothing else: it never writes, never starts the engine, and never logs a process's arguments (they can carry a key).
 */
import { join } from 'node:path'
import { externalEvidenceActive, externalReadFailed } from '../../lib/sessionSearch/evidence.js'

import { agentCommandOwnershipSnapshot } from '../../lib/engineBin.js'
import { absoluteFolder, entries, fileStamp, firstLine, parseLine, readHead, readJson, readTail, readText, record, text } from '../../lib/sessionSearch/externals/support.js'
import { argvTokens, engineProcessMatch, resumeSessionId } from '../../lib/tmux.js'
import {
  type ExternalEngine, type ExternalOrigin, type ExternalProvider, type ExternalSession, type OwnerClaim, type Ownership, type ProcessView,
  type RunningProcess, type ScanContext, UNSETTLED,
} from '../../lib/sessionSearch/externals/types.js'
import type { AdoptionContract } from '../facets/adoption.js'

type Head = AdoptionContract['head']
type Owners = AdoptionContract['owners']
type Tail = Extract<AdoptionContract['busy'], { tail: unknown }>['tail']

export interface AdoptedHead { sessionId: string; cwd: string; origin: ExternalOrigin }

/** Where a provider looks: each root its layout lists (a sessions folder, or a home), and where an engine that
 *  keeps process records keeps them (beside each root, unless given). Asked on every scan: a home the person moves
 *  is adopted while the daemon runs. */
export interface AdoptionPlaces {
  roots(): string[]
  records?(): string[]
}

/** The value at `path` below `row`, each step an object. */
function at(row: Record<string, unknown> | null, path: readonly string[]): unknown {
  let value: unknown = row
  for (const key of path) value = record(value)?.[key]
  return value
}

/** Who wrote it, from the record's fields; null for anyone but a person at a terminal, an app or an editor. */
function originOf(fields: Record<string, unknown>, origin: Head['origin']): ExternalOrigin | null {
  const value = fields[origin.field]
  if (typeof value !== 'string' || !Object.hasOwn(origin.values, value)) return null
  const rule = origin.values[value]
  return typeof rule === 'string' ? rule : fields[rule.field] === rule.is ? rule.then : rule.otherwise
}

/** What a head record says: its conversation, folder and author, or null when it is not a person's. */
function judge(row: Record<string, unknown> | null, head: Head): AdoptedHead | null {
  const fields = head.at ? record(at(row, head.at)) : row
  if ((head.type !== undefined && row?.type !== head.type) || !fields) return null
  if (head.skip && fields[head.skip.field] === head.skip.is) return null
  const origin = originOf(fields, head.origin)
  const cwd = absoluteFolder(fields[head.cwd])
  if (!origin || !head.id.pattern.test(text(fields[head.id.field])) || !cwd) return null
  return { sessionId: text(fields[head.id.field]), cwd, origin }
}

/**
 * A file's conversation, folder and author, from its head. UNSETTLED while the engine is still writing the line
 * that would say: a file read whole without one.
 */
export async function readAdoptedHead(path: string, head: Head): Promise<AdoptedHead | null | typeof UNSETTLED> {
  if (head.line === 'first') {
    let line: string | null = null
    for (const bytes of head.windows) {
      line = await firstLine(path, bytes)
      if (line !== null) break
      // The whole file was read and it has no line yet: the engine is still writing it.
      if (Buffer.byteLength(await readHead(path, bytes)) < bytes) return UNSETTLED
    }
    return line === null ? null : judge(record(parseLine(line)), head)
  }
  const marker = head.line.marked
  for (const bytes of head.windows) {
    const read = await readHead(path, bytes)
    const whole = Buffer.byteLength(read) < bytes
    // A window that ends mid-file ends mid-line: that line is read whole by the next, wider one.
    const lines = read.split('\n')
    if (!whole) lines.pop()
    for (const line of lines) {
      if (!line.includes(marker)) continue
      let row: Record<string, unknown> | null
      try { row = record(JSON.parse(line)) } catch { continue }
      if (!row) continue
      return judge(row, head)
    }
    if (whole) return UNSETTLED
  }
  return null
}

/** The engine's own names for its conversations, the last one winning, read again only when the file changes. */
export async function adoptedTitles(engine: string, path: string, titles: NonNullable<AdoptionContract['titles']>, ctx: ScanContext): Promise<Map<string, string>> {
  const stamp = await fileStamp(path)
  if (!stamp) return new Map()
  return ctx.memo(`${engine}:titles:${path}`, stamp.stamp, async () => {
    const found = new Map<string, string>()
    for (const line of (await readText(path)).split('\n')) {
      const row = record(parseLine(line))
      const name = text(row?.[titles.title]).trim()
      if (text(row?.[titles.id]) && name) found.set(text(row?.[titles.id]), name)
    }
    return found
  })
}

/** Every file a walk layout lists below `dir`, at any depth up to its limit. */
export async function walkFiles(dir: string, files: Extract<AdoptionContract['files'], { layout: 'walk' }>): Promise<string[]> {
  const out: string[] = []
  const walk = async (from: string, depth: number): Promise<void> => {
    for (const entry of await entries(from)) {
      const path = join(from, entry.name)
      if (entry.isDirectory() && depth < files.depth) await walk(path, depth + 1)
      // A file or a link to one; the scan's stat drops a broken link.
      else if (!entry.isDirectory() && entry.name.startsWith(files.prefix) && entry.name.endsWith(files.suffix)) out.push(path)
    }
  }
  await walk(dir, 0)
  return out
}

/** Whether a process serves other clients rather than a person's terminal. */
export function servesOthers(row: RunningProcess | undefined, servers: Extract<Owners, { open: unknown }>['open']['servers']): boolean {
  if (!row) return false
  if (servers.executable.test(row.executable) || servers.args.test(row.args)) return true
  // The subcommand: the first argument that is not an option.
  const subcommand = argvTokens(row.args).slice(1).find((token) => !token.startsWith('-'))
  return !!subcommand && servers.subcommands.includes(subcommand)
}

/**
 * Whether a file's last turn is still running: the last turn event near its end says. What was said can name the
 * events; only events count. A file that cannot say answers `unknown`.
 */
export async function turnOpen(path: string, tail: Tail, unknown: boolean | null): Promise<boolean | null> {
  const mark = new RegExp(`"(${[tail.open, ...tail.closed].join('|')})"`)
  for (const bytes of tail.windows) {
    const lines = (await readTail(path, bytes)).split('\n')
    for (let i = lines.length - 1; i > 0; i--) {
      const line = lines[i]
      if (!line.includes(tail.marker) || !mark.test(line)) continue
      const kind = at(record(parseLine(line)), tail.at)
      if (kind === tail.open) return true
      if (typeof kind === 'string' && tail.closed.includes(kind)) return false
    }
  }
  return unknown
}

/** The conversation a process's arguments say it started on: a resume of it, or one of `flags` naming it. */
function namedSession(engine: ExternalEngine, args: string, flags: readonly string[], pattern: RegExp): string | null {
  const resumed = resumeSessionId(engine as never, args)
  if (resumed) return resumed
  const tokens = argvTokens(args)
  for (const [i, token] of tokens.entries()) {
    const flag = flags.find(name => token === name || token.startsWith(`${name}=`))
    const value = flag && (token === flag ? tokens[i + 1] : token.slice(flag.length + 1))
    if (value && pattern.test(value)) return value
  }
  return null
}

async function recordOwners(engine: ExternalEngine, owners: Extract<Owners, { records: unknown }>['records'], pattern: RegExp, dirs: string[], view: ProcessView): Promise<Ownership> {
  const claims: OwnerClaim[] = []
  for (const dir of dirs) {
    const records = (await entries(dir)).filter((file) => file.isFile() && file.name.endsWith(owners.suffix))
    if (!records.length) continue
    const processes = new Map((await view.list()).map((process): [number, RunningProcess] => [process.pid, process]))
    const ownership = agentCommandOwnershipSnapshot()
    for (const file of records) {
      const path = join(dir, file.name)
      const row = record(await readJson(path))
      const pid = row?.[owners.pid]
      if (externalEvidenceActive() && (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff
        || !pattern.test(text(row?.[owners.id])))) {
        externalReadFailed(new Error('incomplete owner record'), 'owner record'); continue
      }
      if (typeof pid !== 'number' || !text(row?.[owners.id]) || !view.alive(pid)) continue
      // A record outlives a crash, and its pid can be handed to anything after — a shell in another tab. Only a
      // process of this engine already running when the record says it started still has it.
      const process = processes.get(pid)
      if (!process && externalEvidenceActive()) externalReadFailed(new Error('missing owner process'), 'owner process')
      if (!process || engineProcessMatch(process, engine as never, ownership).score <= 0) continue
      const started = row?.[owners.started]
      if (externalEvidenceActive() && (typeof started !== 'number' || !Number.isFinite(started) || started <= 0
        || !Number.isFinite(process.started) || process.started! <= 0)) {
        externalReadFailed(new Error('incomplete owner incarnation'), 'owner record'); continue
      }
      if (process.started !== undefined && typeof started === 'number' && process.started > started + owners.slackMs) continue
      claims.push({ sessionId: text(row?.[owners.id]), pid, record: path })
    }
  }
  const unresolved: Array<{ pid: number; named?: string }> = []
  if (externalEvidenceActive()) {
    const ownership = agentCommandOwnershipSnapshot()
    for (const process of await view.list()) {
      if (!view.alive(process.pid) || engineProcessMatch(process, engine as never, ownership).score <= 0) continue
      const ids = new Set(claims.filter(claim => claim.pid === process.pid).map(claim => claim.sessionId))
      if (ids.size === 1) continue
      // Records that disagree about one live process are a store nobody can read: nothing is admitted on it.
      if (ids.size > 1) { externalReadFailed(new Error('no unambiguous current process record'), 'current owner'); continue }
      // No record. This used to fail every conversation: one long-running `claude` started before it kept
      // records (two such TUIs on a developer's Mac, days old) held every adoption on the machine forever,
      // "The conversation's current owner could not be verified" (CLI 0.3.70). Such a process can hold only
      // the conversation its arguments name and, moved on with `/resume` or `/clear`, one its folder's picker
      // lists. The first is a claim never stopped on; for the rest it stays unplaced, and admission judges it
      // against each conversation's folder. A name alone is not enough: it is where it started, not where it is.
      const named = namedSession(engine, process.args, owners.sessionFlags ?? [], pattern)
      if (named) claims.push({ sessionId: named, pid: process.pid, record: '', fromArgs: true })
      unresolved.push({ pid: process.pid, ...(named ? { named } : {}) })
    }
  }
  const cwds = unresolved.length ? await view.cwds(unresolved.map(row => row.pid)) : new Map<number, string>()
  return { claims, unresolved: unresolved.map(row => ({ ...row, cwd: cwds.get(row.pid) ?? null })) }
}

async function openFileOwners(engine: ExternalEngine, open: Extract<Owners, { open: unknown }>['open'], view: ProcessView): Promise<OwnerClaim[]> {
  const claims: OwnerClaim[] = []
  const held = await view.openFilesOf(open.commands)
  if (!held.size) return claims
  const processes = new Map((await view.list()).map((row): [number, RunningProcess] => [row.pid, row]))
  const ownership = agentCommandOwnershipSnapshot()
  for (const [pid, files] of held) {
    const records = files.filter(path => open.id.test(path) && path.includes(open.contains))
    if (!records.length) continue
    // lsof -c selects command prefixes; a codex-audit helper can hold a rollout too. The exact
    // process snapshot must identify the engine before an FD claim can authorize its termination.
    const process = processes.get(pid)
    if (externalEvidenceActive() && (!process || !view.alive(pid) || engineProcessMatch(process, engine as never, ownership).score <= 0)) {
      externalReadFailed(new Error('unverified file owner process'), 'owner process'); continue
    }
    // A server holding a thread is never stopped from here, even when a terminal started it.
    const app = servesOthers(processes.get(pid), open.servers)
    for (const path of records) {
      const id = open.id.exec(path)?.[1]
      if (id && path.includes(open.contains)) claims.push({ sessionId: id, pid, record: path, ...(app ? { app: true } : {}) })
    }
  }
  return claims
}

/** One engine's provider, from its contract, looking where `places` says. */
export function adoptionProvider(engine: ExternalEngine, contract: AdoptionContract, places: AdoptionPlaces): ExternalProvider {
  const { files, head } = contract
  const sessionAt = async (path: string, ctx: ScanContext): Promise<{ head: AdoptedHead; mtime: number } | null> => {
    // A file, or a link to one; not a folder, not a broken link.
    const stamp = await fileStamp(path)
    if (!stamp) return null
    // A head never changes: read once, however the file grows.
    const found = await ctx.head(`${engine}:${path}`, stamp.stamp, () => readAdoptedHead(path, head))
    await ctx.pace()
    return found && !ctx.excluded(found.cwd) ? { head: found, mtime: stamp.mtime } : null
  }
  const owners = contract.owners
  const busy = contract.busy
  const ownership = async (view: ProcessView): Promise<Ownership> => 'records' in owners
    ? recordOwners(engine, owners.records, head.id.pattern, places.records?.() ?? places.roots().map((root) => join(root, '..', owners.records.folder)), view)
    : { claims: await openFileOwners(engine, owners.open, view), unresolved: [] }
  return {
    engine,
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      const found: ExternalSession[] = []
      for (const root of places.roots()) {
        if (files.layout === 'projects') {
          for (const project of await entries(root)) {
            if (!project.isDirectory()) continue
            const folder = join(root, project.name)
            // Only the project's own files: a sub-agent's are in a folder beneath it.
            for (const file of await entries(folder)) {
              if (!file.name.endsWith(files.suffix)) continue
              const path = join(folder, file.name)
              const session = await sessionAt(path, ctx)
              if (session) found.push({ ...session.head, engine, title: '', mtime: session.mtime, transcriptPath: path })
            }
          }
          continue
        }
        const titles = contract.titles ? await adoptedTitles(engine, join(root, contract.titles.file), contract.titles, ctx) : new Map<string, string>()
        const archived = new Set(files.folders.archived ? await walkFiles(join(root, files.folders.archived), files) : [])
        for (const path of [...await walkFiles(join(root, files.folders.sessions), files), ...archived]) {
          const session = await sessionAt(path, ctx)
          if (!session) continue
          found.push({
            ...session.head, engine, title: titles.get(session.head.sessionId) ?? '', mtime: session.mtime, transcriptPath: path,
            ...(archived.has(path) ? { archived: true as const } : {}),
          })
        }
      }
      return found
    },
    ownership,
    owners: async (view: ProcessView) => (await ownership(view)).claims,
    async confirmOwner(owner, process) {
      // Only its arguments name it (no record): nothing says whether it is still there or mid-turn, and it is
      // never stopped on that, so its activity stays unknown.
      if (!('records' in owners) || !('record' in busy) || owner.fromArgs) return null
      // Claude's one record carries the session, PID, incarnation and activity together. A final
      // transcript read cannot offer this guarantee when ownership lives in a separate store.
      const row = record(await readJson(owner.record)), fields = owners.records
      const started = row?.[fields.started]
      if (!process || process.pid !== owner.pid || row?.[fields.pid] !== owner.pid || row?.[fields.id] !== owner.sessionId
        || typeof started !== 'number' || !Number.isFinite(started) || started <= 0
        || !Number.isFinite(process.started) || process.started! <= 0 || process.started! > started + fields.slackMs)
        return { current: false, busy: null }
      return { current: true, busy: row?.[busy.record.field] === busy.record.busy ? true : row?.[busy.record.field] === busy.record.idle ? false : null }
    },
    async busy(owner): Promise<boolean | null> {
      if ('tail' in busy) return turnOpen(owner.record, busy.tail, null)
      // A process placed by its arguments has no record to read; that absence says nothing here.
      if (!owner.record) return null
      const row = record(await readJson(owner.record))
      // No record: the process ended with it, so it is not mid-turn.
      if (!row) return false
      return row[busy.record.field] === busy.record.busy ? true : row[busy.record.field] === busy.record.idle ? false : null
    },
  }
}
