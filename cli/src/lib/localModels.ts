/** The Models popover's local lifecycle. Grid remains the hardware, catalog,
 * download and process authority. A click is a durable daemon operation, never a chat task. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat, mkdir, rename, writeFile, statfs } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { GridFleetRpc, type GridFleetResult } from './gridFleetRpc.js'
import { gridCredentialsPath } from './gridCredentials.js'
import { forgetGridModels } from './gridModels.js'
import { binaryOnPath } from './binaryOnPath.js'

const GiB = 1024 ** 3
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const rows = (v: unknown): Record<string, any>[] => Array.isArray(v) ? v.map(obj) : []
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
const key = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 24)
const cleanName = (v: string): string => basename(v).replace(/\.gguf$/i, '').replace(/-GGUF$/i, '')
// Grid advertises a GGUF filename as a lowercase model name without its extension.
const modelKey = (v: string): string => v.toLowerCase().replace(/\.gguf$/, '')
const validArg = (v: string): boolean => !!v && !v.startsWith('-') && !/[\x00-\x1f]/.test(v)
/** `grid info` statuses of a grid that is not up. Grid refuses `engines` and `join` on one, and
 * names `grid start` as the way back. Anything else unknown stays unknown rather than "down". */
const DOWN = new Set(['stopped', 'asleep'])

export interface LocalModel {
  id: string; name: string; state: 'available' | 'downloaded' | 'running'
  sizeBytes?: number; quant?: string; recommended?: boolean; canStart: boolean; canStop: boolean
  tokensPerSecond?: number; requests?: number; windowSeconds?: number
  operation?: ModelOperation
}
export interface ModelOperation {
  id: string; modelId: string; action: 'start' | 'stop'; phase: 'running' | 'done' | 'failed'
  stage: 'checking' | 'downloading' | 'starting' | 'verifying' | 'stopping'
  progress?: number; error?: string; updatedAt: string
}
export interface LocalModelsSnapshot {
  models: LocalModel[]; memoryBytes?: number; hardware?: string
  /** A sentence to show BESIDE the list — never `error`. On this protocol an `error` field fails
   * the whole request: the app's RPC layer drops the reply and keeps nothing of it, so a list sent
   * with a warning in `error` arrived as no list at all and the Local tab read 0. */
  notice?: string
  observedAt: string; busy: boolean
}
interface Candidate {
  id: string; name: string; pull: string; file: string; files: string[]; size: number; quant: string; context: number
  aliases?: string[]
}
interface Owned { file: string; selector: string; aliases: string[]; nodeId: string; name: string; live: boolean; context: number; siblings: number }
interface Receipt { spec: 1; grid: string; operation?: ModelOperation }
interface Options {
  stateDir: string; processEnv?: NodeJS.ProcessEnv
  run?: (args: string[], output?: (chunk: string) => void, timeout?: number) => Promise<GridFleetResult>
  request?: typeof fetch
}

/** One concrete, machine-fitted version per model. Non-chat and unprobed offline
 * catalog rows are never called compatible. Split GGUF files stay one model. */
export function compatibleModels(raw: unknown): Candidate[] {
  const seen = new Set<string>()
  return rows(obj(raw).models).flatMap(row => {
    const fit = obj(row.fit)
    if (row.runnable !== true || !['text-generation', 'image-text-to-text'].includes(row.task) || row.format !== 'GGUF') return []
    const version = rows(row.versions).find(v => v.version === fit.version)
    const pull = str(version?.pull_spec), size = num(version?.size_bytes)
    const id = str(row.repo_id), split = pull.indexOf(':')
    if (!id || seen.has(id) || !validArg(pull) || split < 1 || !size || !num(fit.ctx)) return []
    const file = basename(pull.slice(split + 1))
    if (!file.toLowerCase().endsWith('.gguf')) return []
    const files = (Array.isArray(version?.urls) ? version.urls : []).flatMap((url: unknown) => {
      try { return [basename(decodeURIComponent(new URL(str(url)).pathname))] } catch { return [] }
    })
    seen.add(id)
    return [{ id, name: cleanName(id), pull, file, files: files.length ? files : [file], size,
      quant: str(fit.version), context: Math.min(16384, Math.floor(fit.ctx)) }]
  })
}

export class LocalModels {
  private readonly processEnv: NodeJS.ProcessEnv
  private readonly home: string
  private readonly run: NonNullable<Options['run']>
  private readonly request: typeof fetch
  private candidates: Candidate[] = []
  private device: Record<string, any> = {}
  private catalogAt = 0
  private catalogError: string | undefined
  private catalogPending?: Promise<void>
  private listPending?: Promise<LocalModelsSnapshot>
  private listGrid?: string
  private cached?: { at: number; grid: string; value: LocalModelsSnapshot }
  private active?: { grid: string; operation: ModelOperation; done: Promise<void> }
  private receipt?: Receipt
  private receiptScope?: string
  private knownByGrid = new Map<string, Candidate[]>()
  private blockers = new Map<string, string>()

  constructor(private readonly options: Options) {
    this.processEnv = options.processEnv ?? process.env
    this.home = dirname(gridCredentialsPath(this.processEnv))
    const rpc = new GridFleetRpc(this.processEnv)
    this.run = options.run ?? ((args, output, timeout = 30_000) =>
      rpc.run('local-models', randomUUID(), { args, timeoutMs: timeout, thinking: false }, output, 4 * 1024 * 1024))
    this.request = options.request ?? fetch
  }

  private async json(args: string[]): Promise<any> {
    const result = await this.run(args)
    if (!result.ok) throw new Error('Models could not be checked. Try again.')
    try { return JSON.parse(result.stdout) } catch { throw new Error('Models could not be checked. Try again.') }
  }

  /** The same authenticated catalog Grid uses, paged until every compatible row
   * is included. Credentials never enter RPC replies, receipts, arguments or logs. */
  private async catalog(device: Record<string, any>): Promise<unknown> {
    const top = (await readFile(gridCredentialsPath(this.processEnv), 'utf8')).split(/^\s*\[/m)[0]
    const value = (name: string): string => {
      const match = new RegExp(`^\\s*${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*$`, 'm').exec(top)
      if (!match) return ''
      try { return match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1) } catch { return '' }
    }
    const token = value('session_token')
    if (!token) throw new Error('Sign in to find models for this computer.')
    const base = value('api_url') || this.processEnv.GRID_CONTROL_PLANE_URL || 'https://api-grid.autonomous.ai'
    const url = new URL(`${base.replace(/\/$/, '')}/v1/grid/catalog`)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('The model catalog address is unavailable.')
    }
    const all: any[] = []
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(url, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ browse: true, page, page_size: 50, device: {
          device_class: device.device_class, usable_bytes: device.usable_bytes, backend: device.backend,
        } }), signal: AbortSignal.timeout(20_000), redirect: 'error',
      })
      if (!response.ok) throw new Error('Compatible models are unavailable. Try again.')
      const body = obj(await response.json())
      if (!Array.isArray(body.models)) throw new Error('Compatible models are unavailable. Try again.')
      all.push(...body.models)
      const totalPages = num(obj(body.pagination).total_pages) ?? 1
      if (page >= totalPages || (num(body.runnable_total) !== undefined && all.filter(m => m.runnable === true).length >= body.runnable_total)) return { models: all }
      if (!body.models.length || obj(body.pagination).page !== page) throw new Error('The model catalog is incomplete. Try again.')
    }
    throw new Error('The model catalog is incomplete. Try again.')
  }

  private async loadCatalog(force = false): Promise<void> {
    if (!force && this.catalogAt && Date.now() - this.catalogAt < 5 * 60_000) return
    return this.catalogPending ??= (async () => {
      try {
        this.device = obj(await this.json(['device-info', '--json']))
        const catalog = obj(await this.catalog(this.device))
        this.candidates = compatibleModels(catalog)
        // Prefer an already downloaded fitting quant rather than downloading
        // the catalog's default version of the same model again.
        for (let i = 0; i < this.candidates.length; i++) {
          const chosen = this.candidates[i]
          if (await this.downloaded(chosen)) continue
          const source = rows(catalog.models).find(m => m.repo_id === chosen.id)
          for (const version of rows(source?.versions)) {
            if ((num(version.size_bytes) ?? Infinity) > chosen.size) continue
            const alternate = compatibleModels({ models: [{ ...source, fit: { ...source?.fit, version: version.version } }] })[0]
            if (alternate && await this.downloaded(alternate)) { this.candidates[i] = alternate; break }
          }
        }
        // A useful small download makes the first reply arrive sooner. Keep
        // the catalog's relevance order within that group, and show all others.
        const suggested = this.candidates.findIndex(c => c.size <= 8 * GiB && c.size >= GiB)
        if (suggested > 0) this.candidates.unshift(...this.candidates.splice(suggested, 1))
        this.catalogError = undefined
        this.catalogAt = Date.now()
      } catch (error) {
        this.catalogError = error instanceof Error && /^(Sign in|The model catalog)/.test(error.message)
          ? error.message : 'Compatible models are unavailable. Try again.'
      }
    })().finally(() => { this.catalogPending = undefined })
  }

  private async downloaded(candidate: Candidate): Promise<boolean> {
    const sizes = await Promise.all(candidate.files.map(file => stat(join(this.home, 'models', file)).then(s => s.isFile() ? s.size : 0).catch(() => 0)))
    return sizes.every(size => size > 0) && sizes.reduce((sum, size) => sum + size, 0) === candidate.size
  }

  /** Grid's non-secret run records distinguish locally owned --serve processes
   * from external endpoints. Stop delegates identity checks and teardown to Grid. */
  private async owned(grid: string): Promise<Owned[]> {
    this.blockers.delete(grid)
    if (!validArg(grid)) return []
    const grids = rows(await this.json(['--remote', 'ls', '--json']))
    const gridId = str(grids.find(g => g.grid === grid)?.id)
    if (!gridId || basename(gridId) !== gridId) return []
    const folder = join(this.home, 'run', 'engines', gridId)
    const names = await readdir(folder).catch(() => [])
    const result: Owned[] = []
    for (const name of names.filter(n => n.endsWith('.json'))) {
      let record: Record<string, any>
      try { record = obj(JSON.parse(await readFile(join(folder, name), 'utf8'))) } catch { continue }
      const heartbeat = await stat(join(folder, name.replace(/\.json$/, '.heartbeat'))).catch(() => null)
      const live = heartbeat !== null && Date.now() - heartbeat.mtimeMs < 90_000
      const specs = rows(record.engines)
      if (specs.length || record.media) this.blockers.set(grid, 'Open Model Manager to add a model alongside those already running.')
      for (const spec of specs) {
        if (spec.endpoint_url || spec.api_kind || !Array.isArray(spec.models) || spec.models.length !== 1) continue
        const file = str(spec.models[0])
        if (!validArg(file) || !file.toLowerCase().endsWith('.gguf')) continue
        const advertised = Array.isArray(record.advertise_as) && specs.length === 1
          ? record.advertise_as.filter((v: unknown) => typeof v === 'string' && v.length > 0) : []
        const aliases: string[] = advertised.length ? advertised : [file]
        result.push({ file: basename(file), selector: file, aliases, nodeId: str(record.node_id), name: str(record.meta_name), live, context: Math.min(16384, num(record.ctx_size) || 8192), siblings: specs.length + (record.media ? 1 : 0) })
        this.blockers.set(grid, `Stop ${cleanName(aliases[0])} first to start another local model.`)
      }
    }
    return result
  }

  /** Keep models imported from an existing Grid setup after Stop removes its
   * run record. Only completed local files that this computer already served
   * become restartable; arbitrary downloaded GGUFs are not assumed compatible. */
  private async known(grid: string, owned: Owned[]): Promise<Candidate[]> {
    const path = join(this.options.stateDir, `${key(grid)}.known.json`)
    let known = this.knownByGrid.get(grid)
    if (!known) {
      try {
        known = rows(JSON.parse(await readFile(path, 'utf8'))).filter(c =>
          c.id === `local:${c.file}` && basename(str(c.file)) === c.file && validArg(c.file) &&
          c.pull === '' && typeof c.name === 'string' && c.name.length < 256 && num(c.size) && num(c.context) && c.context <= 16384 &&
          Array.isArray(c.files) && c.files.length === 1 && c.files[0] === c.file).map(c => ({
            ...c,
            // Older receipts kept only the displayed alias. Preserve that name
            // when upgrading, and never forward malformed saved argv values.
            aliases: (Array.isArray(c.aliases) ? c.aliases : [c.name])
              .filter((alias: unknown): alias is string => typeof alias === 'string' && validArg(alias)),
          })) as Candidate[]
      } catch { known = [] }
      this.knownByGrid.set(grid, known)
    }
    let changed = false
    for (const instance of owned) {
      if (this.candidates.some(c => c.file === instance.file) || known.some(c => c.file === instance.file)) continue
      const file = await stat(join(this.home, 'models', instance.file)).catch(() => null)
      if (!file?.isFile() || !file.size) continue
      known.push({ id: `local:${instance.file}`, name: cleanName(instance.aliases[0]),
        file: instance.file, files: [instance.file], pull: '', size: file.size, quant: '', context: instance.context,
        aliases: instance.aliases.filter(validArg) })
      changed = true
    }
    if (changed) {
      await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
      const temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify(known), { mode: 0o600 }); await rename(temp, path)
    }
    const existing = await Promise.all(known.map(async candidate => await this.downloaded(candidate) ? candidate : null))
    return existing.filter((c): c is Candidate => c !== null)
  }

  private receiptPath(grid: string): string { return join(this.options.stateDir, `${key(grid)}.json`) }
  private async readReceipt(grid: string): Promise<void> {
    if (this.receiptScope === grid) return
    this.receiptScope = grid
    this.receipt = undefined
    try {
      const value = JSON.parse(await readFile(this.receiptPath(grid), 'utf8')) as Receipt
      if (value.spec === 1 && value.grid === grid) {
        this.receipt = value
        if (value.operation?.phase === 'running' && this.active?.operation.id !== value.operation.id) {
          value.operation.phase = 'failed'
          value.operation.error = 'Setup was interrupted. Start again to continue.'
        }
      }
    } catch { /* no prior operation */ }
  }
  private async save(grid: string, operation: ModelOperation): Promise<void> {
    const value: Receipt = { spec: 1, grid, operation: { ...operation, updatedAt: new Date().toISOString() } }
    this.receipt = value; this.receiptScope = grid; this.cached = undefined
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
    const file = this.receiptPath(grid), temp = `${file}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await rename(temp, file)
  }

  async list(grid: string | null, force = false): Promise<LocalModelsSnapshot> {
    if (!grid) return { models: [], notice: 'Sign in to find models for this computer.', observedAt: new Date().toISOString(), busy: false }
    if (!force && this.cached?.grid === grid && Date.now() - this.cached.at < 2500) return this.cached.value
    if (this.listPending) {
      if (this.listGrid === grid) return this.listPending
      await this.listPending; return this.list(grid, force)
    }
    this.listGrid = grid
    this.listPending = this.readList(grid, force)
    try { return await this.listPending } finally { this.listPending = undefined }
  }
  private async readList(grid: string, force: boolean): Promise<LocalModelsSnapshot> {
    await Promise.all([this.loadCatalog(force), this.readReceipt(grid)])
    let owned: Owned[] = [], nodes: Record<string, any>[] = [], inventoryError: string | undefined
    try {
      [owned, nodes] = await Promise.all([this.owned(grid), this.servingNodes(grid)])
    } catch { inventoryError = 'Running models could not be checked. Try again.' }
    const operation = this.active?.grid === grid ? this.active.operation : this.receipt?.grid === grid ? this.receipt.operation : undefined
    const choices = [...this.candidates, ...(await this.known(grid, owned)).filter(k => !this.candidates.some(c => c.file === k.file))]
    const downloaded = await Promise.all(choices.map(candidate => this.downloaded(candidate)))
    // Different repositories can use the same filename for different weights.
    // Attribute the one local engine to the complete file that is actually here.
    // Keep a fallback so an engine can still be stopped if its file was removed.
    const owners = new Map(owned.map(instance => [instance.file,
      choices.find((candidate, index) => candidate.file === instance.file && downloaded[index])
        ?? choices.find(candidate => candidate.file === instance.file)]))
    const servingNode = (instance?: Owned): Record<string, any> | undefined => {
      const matches = instance?.live ? nodes.filter(n => n.online === true &&
        (str(n.node_id || n.id) ? str(n.node_id || n.id) === instance.nodeId :
          !!instance.name && str(n.name) === instance.name) &&
        instance.aliases.every(alias => (Array.isArray(n.models) ? n.models : []).some((m: unknown) =>
          modelKey(str(typeof m === 'string' ? m : obj(m).model)) === modelKey(alias)))) : []
      return matches.length === 1 ? matches[0] : undefined
    }
    const models = choices.map((candidate, index): LocalModel => {
      const instance = owned.find(o => owners.get(o.file) === candidate)
      const node = servingNode(instance)
      const running = !!node
      const available = downloaded[index]
      const answered = obj(node?.answered)
      const perModel = rows(answered.by_model).find(a => instance?.aliases.some(alias => modelKey(alias) === modelKey(str(a.model))))
      const single = Array.isArray(node?.models) && node.models.length === 1
      return { id: candidate.id, name: candidate.name, state: running ? 'running' : available ? 'downloaded' : 'available',
        sizeBytes: candidate.size, quant: candidate.quant, recommended: index === 0,
        canStart: !inventoryError && (!this.catalogError || !candidate.pull) && !instance, canStop: !inventoryError && !!instance,
        // Device memory is deliberately not presented as this model's memory.
        tokensPerSecond: single && running ? num(node?.throughput_tok_s) : undefined,
        requests: running ? num(perModel?.requests) : undefined,
        windowSeconds: running ? num(answered.window_seconds) : undefined,
        operation: operation?.modelId === candidate.id ? operation : undefined }
    })
    for (const instance of owned.filter(o => !choices.some(c => c.file === o.file))) {
      models.push({ id: `local:${instance.file}`, name: cleanName(instance.aliases[0]),
        state: servingNode(instance) ? 'running' : 'available', canStart: false, canStop: !inventoryError,
        operation: operation?.modelId === `local:${instance.file}` ? operation : undefined })
    }
    const value: LocalModelsSnapshot = { models, memoryBytes: num(obj(this.device.memory).total_gb) === undefined ? undefined : this.device.memory.total_gb * GiB,
      hardware: str(obj(this.device.machine).model || obj(this.device.cpu).brand), notice: inventoryError || this.catalogError,
      observedAt: new Date().toISOString(), busy: !!this.active }
    this.cached = { grid, at: Date.now(), value }
    return value
  }

  /** What `grid info` says of [grid]: `running`, `stopped`, `asleep`. */
  private async gridStatus(grid: string): Promise<string> {
    return str(obj(await this.json(['--remote', 'info', grid, '--json'])).status)
  }

  /** The nodes serving [grid] — none at all when the grid is down.
   *
   * ⚠️ A stopped or asleep grid REFUSES `engines` ("isn't up; run `grid start` first") rather than
   * answering an empty list, and reading that refusal as "unknown" disabled every Start in the
   * list: the one state in which a person most needs to start a model was the one in which none
   * could be. Stopping the last model from this list leaves the grid up, so it was only reached by
   * a grid taken down by hand or gone to sleep — but then there was no way back from here. A grid
   * that is down runs nothing, which is an answer, not a gap. Any other refusal still is one. */
  private async servingNodes(grid: string): Promise<Record<string, any>[]> {
    const result = await this.run(['--remote', 'engines', grid, '--json'])
    if (result.ok) {
      try { return rows(JSON.parse(result.stdout)) } catch { throw new Error('Running models could not be checked. Try again.') }
    }
    if (DOWN.has(await this.gridStatus(grid))) return []
    throw new Error('Running models could not be checked. Try again.')
  }

  /** A repeated click or lost RPC acknowledgement joins the same operation.
   * A different model waits: starts/stops must not race on the machine's budget. */
  async act(grid: string | null, modelId: unknown, action: 'start' | 'stop'): Promise<{ operation?: ModelOperation; error?: string }> {
    if (!grid || typeof modelId !== 'string') return { error: 'The model is unavailable. Refresh and try again.' }
    if (this.active) return this.active.grid === grid && this.active.operation.modelId === modelId && this.active.operation.action === action
      ? { operation: this.active.operation } : { error: 'Wait for the current model to finish starting or stopping.' }
    const operation: ModelOperation = { id: randomUUID(), modelId, action, stage: action === 'start' ? 'checking' : 'stopping', phase: 'running', updatedAt: new Date().toISOString() }
    // Reserve before any await; independent RPCs may arrive on separate connections.
    const active = { grid, operation, done: Promise.resolve() }
    this.active = active
    try { await this.save(grid, operation) } catch { this.active = undefined; return { error: 'Setup could not be saved. Try again.' } }
    active.done = this.perform(grid, operation).catch(async error => {
      operation.phase = 'failed'
      operation.error = error instanceof ModelError ? error.message : 'The model could not finish. Start again to retry.'
      await this.save(grid, operation).catch(() => {})
    }).finally(() => { this.active = undefined; this.cached = undefined; forgetGridModels() })
    return { operation }
  }

  async settled(): Promise<void> { await this.active?.done }

  private async perform(grid: string, operation: ModelOperation): Promise<void> {
    const change = async (stage: ModelOperation['stage']) => {
      operation.stage = stage; delete operation.progress; await this.save(grid, operation)
    }
    const must = async (args: string[], message: string, output?: (chunk: string) => void) => {
      if (!(await this.run(args, output, 30 * 60_000)).ok) throw new ModelError(message)
    }
    if (operation.action === 'start') {
      await this.loadCatalog()
      // Leaving the last engine removes Grid's local registration. Restore the
      // account's existing grids before resolving ownership or joining again.
      await must(['--remote', 'sync'], 'Models could not be checked. Try again.')
    }
    const owned = await this.owned(grid)
    const candidate = [...this.candidates, ...await this.known(grid, owned)].find(c => c.id === operation.modelId)
    const instance = owned.find(o => candidate ? o.file === candidate.file : operation.modelId === `local:${o.file}`)
    if (operation.action === 'stop') {
      if (instance) {
        if (instance.siblings > 1) throw new ModelError('Open Model Manager to stop this model. Other models share its engine.')
        await must(['--remote', 'leave', grid, '--engine', instance.selector], 'The model could not stop. Try again.')
        if ((await this.owned(grid)).some(o => o.file === instance.file)) throw new ModelError('The model is still stopping. Check again in a moment.')
      }
    } else {
      if (!candidate || (this.catalogError && candidate.pull)) throw new ModelError('This model could not be checked. Refresh and try again.')
      if (!instance) {
        // The pinned Grid runtime respawns its union when adding --serve.
        // Do not interrupt existing engines as a side effect of a simple Start.
        if (this.blockers.has(grid)) throw new ModelError(this.blockers.get(grid)!)
        // Recheck the machine immediately before downloading or allocating.
        const currentDevice = obj(await this.json(['device-info', '--json']))
        const budget = num(currentDevice.usable_bytes) ?? 0
        if (candidate.pull) {
          const current = compatibleModels(await this.catalog({ ...currentDevice, usable_bytes: Math.max(0, budget) })).find(c => c.id === candidate.id)
          if (!current || current.size < candidate.size) throw new ModelError('Stop a running model to make room, then try again.')
          candidate.context = Math.min(candidate.context, current.context)
        } else if (candidate.size * 1.25 + 2 * GiB > budget) {
          throw new ModelError('Stop a running model to make room, then try again.')
        }
        if (!await this.downloaded(candidate)) {
          if (!candidate.pull) throw new ModelError('The downloaded file is no longer available. Open Model Manager to restore it.')
          await mkdir(join(this.home, 'models'), { recursive: true })
          const disk = await statfs(join(this.home, 'models'))
          if (disk.bavail * disk.bsize < candidate.size + GiB) throw new ModelError('Free up disk space, then start again.')
          await change('downloading')
          let last = 0, progressWrites = Promise.resolve()
          await must(['pull', candidate.pull], 'The download stopped. Start again to resume.', chunk => {
            const matches = [...chunk.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
            const percent = matches.length ? Number(matches.at(-1)![1]) : NaN
            if (Number.isFinite(percent) && percent >= 0 && percent <= 100 && Date.now() - last > 500) {
              last = Date.now(); operation.progress = percent / 100
              progressWrites = progressWrites.then(() => this.save(grid, operation)).catch(() => {})
            }
          })
          await progressWrites
          if (!await this.downloaded(candidate)) throw new ModelError('The download is incomplete. Start again to resume.')
        }
        await change('starting')
        // A grid that is down refuses a join outright ("The model could not start"), and `sync`
        // above restores its registration, not its process. Bring it up the way its own refusal
        // says to. A grid already running is left alone: `start` is only for one that is not.
        const status = await this.gridStatus(grid).catch(() => { throw new ModelError('Your grid could not be checked. Try again.') })
        if (DOWN.has(status)) await must(['--remote', 'start', grid], 'Your grid could not start. Try again.')
        const override = this.processEnv.LLAMA_SERVER
        const installed = override ? binaryOnPath(override, this.processEnv)
          : binaryOnPath(join(this.home, 'bin', 'llama-server'), this.processEnv) || binaryOnPath('llama-server', this.processEnv)
        if (!installed) {
          if (override) throw new ModelError('The local engine needs attention. Open Model Manager.')
          await must(['engine', 'install', 'llama.cpp'], 'The model engine could not start. Try again.')
        }
        await must(['--remote', 'join', grid, '--serve', candidate.file,
          '--max-concurrency', '1', '--ctx-size', String(candidate.context), '--reasoning-budget', '0',
          ...(candidate.aliases ?? []).flatMap(alias => ['--advertise-as', alias])],
        'The model could not start. Try again.')
      }
      await change('verifying')
      await this.verify(grid, instance?.aliases[0] || candidate.aliases?.[0] || candidate.file)
    }
    operation.phase = 'done'
    await this.save(grid, operation)
  }

  private async verify(grid: string, model: string): Promise<void> {
    const info = await this.run(['--remote', 'info', grid, '--env'])
    const exports: Record<string, string> = {}
    for (const match of info.stdout.matchAll(/^export\s+(OPENAI_BASE_URL|OPENAI_API_KEY)=(.*)$/gm)) exports[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
    if (!info.ok || !exports.OPENAI_BASE_URL || !exports.OPENAI_API_KEY) throw new ModelError('The model is starting, but could not be checked. Try again shortly.')
    const deadline = Date.now() + 180_000
    do {
      try {
        const response = await this.request(`${exports.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', headers: { authorization: `Bearer ${exports.OPENAI_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 8 }),
          signal: AbortSignal.timeout(30_000), redirect: 'error',
        })
        const body = response.ok ? obj(await response.json()) : {}
        if (/^\s*ok[.!]?\s*$/i.test(str(obj(rows(body.choices)[0]?.message).content))) return
      } catch { /* registration and first warmup take time; status remains verifying */ }
      await new Promise(resolve => setTimeout(resolve, 1500))
    } while (Date.now() < deadline)
    throw new ModelError('The model did not answer. Stop it, then start again.')
  }
}
class ModelError extends Error {}
