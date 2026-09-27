/**
 * EXPORT (daemons/LEARNING.md, L2): for plain coding sessions and engines outside Harness, approved skills are
 * also written to the folders the engines read on their own. Opt-in, per destination:
 * `pair.jsonc` `"learn": { "export": ["agents", "claude"] }`.
 *
 *   agents  `~/.agents/skills/<name>/SKILL.md` (Codex, Copilot, Cursor and the others that read Agent Skills)
 *   claude  `~/.claude/skills/<name>/SKILL.md` (`$CLAUDE_CONFIG_DIR/skills` when that is set)
 *
 * Each copy carries `metadata.harness.managed: true`. ONLY a file Harness created is ever updated or removed:
 * the manifest (`export.json` in the lessons folder, not committed) keeps each file's hash, and a file whose
 * content is no longer what Harness wrote — the person edited it — is left alone and forgotten. A folder of
 * that name Harness did not make, a symlink, or a file it did not write is never touched ("taken"). A reverted
 * or archived skill, or a destination taken out of pair.jsonc, is removed the same careful way.
 * `harness pair lessons export --dry-run` says what it would do.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExportDestination } from '../rules.js'
import { renderSkill, type LessonRecord, type LessonStore } from './store.js'

export interface ExportDirs { agents: string; claude: string }

export interface ExportStep {
  dest: ExportDestination
  name: string
  id: string
  /** write: new; update: ours, changed; keep: ours, current; remove: ours, no longer wanted; skip: not ours. */
  action: 'write' | 'update' | 'keep' | 'remove' | 'skip'
  path: string
  why?: 'taken' | 'edited' | 'symlink' | 'gone'
}

interface ManifestEntry { dest: ExportDestination; name: string; id: string; path: string; hash: string }
interface Manifest { v: 1; entries: ManifestEntry[] }

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

/** The SKILL.md written into an engine's folder: the lesson's, marked as Harness's. */
export function renderExported(record: LessonRecord): string {
  return renderSkill(record).replace(/^(  harness:\n)/m, '$1    managed: true\n')
}

export interface ExporterDeps {
  store: LessonStore
  dirs: ExportDirs
  /** The destinations pair.jsonc turns on. */
  destinations: () => ExportDestination[]
}

export class LessonExporter {
  constructor(private readonly deps: ExporterDeps) {}

  private get manifestFile(): string { return join(this.deps.store.root, 'export.json') }

  /** What a sync would do, touching nothing. */
  plan(): ExportStep[] {
    const manifest = this.manifest()
    const wanted = new Set(this.deps.destinations())
    const steps: ExportStep[] = []
    const desired = new Set<string>()
    for (const dest of wanted) {
      for (const record of this.deps.store.approved()) {
        if (record.kind !== 'skill') continue
        desired.add(`${dest}:${record.name}`)
        steps.push(this.step(dest, record, manifest))
      }
    }
    for (const entry of manifest.entries) {
      if (desired.has(`${entry.dest}:${entry.name}`)) continue
      const file = entry.path
      if (isLink(file) || isLink(join(file, '..'))) { steps.push({ dest: entry.dest, name: entry.name, id: entry.id, action: 'skip', path: file, why: 'symlink' }); continue }
      if (!existsSync(file)) { steps.push({ dest: entry.dest, name: entry.name, id: entry.id, action: 'skip', path: file, why: 'gone' }); continue }
      const text = this.read(file)
      const ours = text !== null && sha(text) === entry.hash
      steps.push({ dest: entry.dest, name: entry.name, id: entry.id, action: ours ? 'remove' : 'skip', path: file, ...(ours ? {} : { why: 'edited' as const }) })
    }
    return steps
  }

  private step(dest: ExportDestination, record: LessonRecord, manifest: Manifest): ExportStep {
    const dir = join(this.deps.dirs[dest], record.name)
    const file = join(dir, 'SKILL.md')
    const base = { dest, name: record.name, id: record.id, path: file }
    if (isLink(dir) || isLink(file)) return { ...base, action: 'skip', why: 'symlink' }
    const want = sha(renderExported(record))
    const entry = manifest.entries.find((e) => e.dest === dest && e.name === record.name)
    if (!existsSync(file)) {
      if (existsSync(dir)) {
        let empty = false
        try { empty = lstatSync(dir).isDirectory() && readdirSync(dir).length === 0 } catch { /* not a folder */ }
        if (!empty) return { ...base, action: 'skip', why: 'taken' }
      }
      return { ...base, action: 'write' }
    }
    const text = this.read(file)
    if (text === null) return { ...base, action: 'skip', why: 'taken' }
    const disk = sha(text)
    if (entry && entry.hash === disk) return { ...base, action: disk === want ? 'keep' : 'update' }
    if (disk === want) return { ...base, action: 'keep' }        // exactly what Harness writes: adopted
    return { ...base, action: 'skip', why: entry ? 'edited' : 'taken' }
  }

  /** Do what the plan says, and keep the manifest. `dryRun`: only say it. */
  sync(opts: { dryRun?: boolean } = {}): { steps: ExportStep[]; dryRun: boolean } {
    const steps = this.plan()
    if (opts.dryRun) return { steps, dryRun: true }
    const manifest = this.manifest()
    const records = new Map(this.deps.store.approved().map((r) => [`${r.name}`, r]))
    const entries: ManifestEntry[] = []
    const done: ExportStep[] = []
    for (const step of steps) {
      try {
        if (step.action === 'write' || step.action === 'update') {
          const record = records.get(step.name)!
          const text = renderExported(record)
          mkdirSync(join(step.path, '..'), { recursive: true })
          const tmp = `${step.path}.harness-tmp`
          writeFileSync(tmp, text, { mode: 0o644 })
          chmodSync(tmp, 0o644)
          renameSync(tmp, step.path)
          entries.push({ dest: step.dest, name: step.name, id: step.id, path: step.path, hash: sha(text) })
        } else if (step.action === 'keep') {
          const text = this.read(step.path)
          if (text !== null) entries.push({ dest: step.dest, name: step.name, id: step.id, path: step.path, hash: sha(text) })
        } else if (step.action === 'remove') {
          rmSync(step.path, { force: true })
          try { rmdirSync(join(step.path, '..')) } catch { /* something else is in it: it stays */ }
        }
        done.push(step)
      } catch {
        done.push({ ...step, action: 'skip', why: 'taken' })
        const kept = manifest.entries.find((e) => e.dest === step.dest && e.name === step.name)
        if (kept && step.action !== 'remove') entries.push(kept)
      }
    }
    if (entries.length || manifest.entries.length) this.save({ v: 1, entries })
    return { steps: done, dryRun: false }
  }

  /** Whether anything is, or should be, exported: a sync has work to look at. */
  active(): boolean {
    return this.deps.destinations().length > 0 || this.manifest().entries.length > 0
  }

  private read(file: string): string | null {
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null
      return readFileSync(file, 'utf8')
    } catch { return null }
  }

  private manifest(): Manifest {
    try {
      const parsed = JSON.parse(readFileSync(this.manifestFile, 'utf8')) as Partial<Manifest>
      if (parsed?.v !== 1 || !Array.isArray(parsed.entries)) return { v: 1, entries: [] }
      return { v: 1, entries: parsed.entries.filter((e) => e && typeof e.path === 'string' && typeof e.hash === 'string' && (e.dest === 'agents' || e.dest === 'claude') && typeof e.name === 'string') }
    } catch { return { v: 1, entries: [] } }
  }

  private save(manifest: Manifest): void {
    if (!this.deps.store.exists) return
    const tmp = `${this.manifestFile}.tmp`
    writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    renameSync(tmp, this.manifestFile)
  }
}
