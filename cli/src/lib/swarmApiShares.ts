/**
 * A saved API shared with a Swarm (docs/plans/2026-10-23-swarm-local-models.md, owner 2026-10-23): Builders on any of the
 * Swarm's machines may run on one of its models, through the Swarm's grid, on the sharer's key and credits.
 *
 * Grid joins only engines it can reach as OpenAI-compatible endpoints, and its own `--api` kinds cover OpenAI alone, so
 * this computer answers for the API: a server on 127.0.0.1, under a path no other process knows, that forwards a model
 * list or a completion to the API with the saved key — the way an app's local engine is joined (`localModels.ts`). The key
 * stays in this process: never in argv, a record on disk, a log line or a reply.
 */
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ApiConnection } from './apiConnections.js'
import type { GridResult } from './gridExec.js'

/** What a request may do through a share: list models, or complete. Nothing else of the API is reachable. */
const ALLOWED = new Set(['GET /models', 'POST /chat/completions', 'POST /completions'])
/** A Claude Code turn sends its whole context; this is well above one and well below what would hurt the process. */
const MAX_BODY = 32 * 1024 * 1024
/** Several Builders may share one API model, unlike a local engine that answers one at a time. */
const CONCURRENCY = 4

export interface SwarmApiShare { grid: string; connectionId: string; model: string; name: string }

export interface SwarmApiSharesDeps {
  access: (connectionId: string) => { connection: ApiConnection; apiKey: string }
  exec: (args: readonly string[]) => Promise<GridResult>
  fetch?: typeof fetch
  /** Where the shares are noted, by grid, API and model, never the key: an endpoint dies with this process, and the next
   *  one shares them again ([restore]). */
  stateFile?: string
}

interface Running extends SwarmApiShare { server: Server; alias: string; port: number; token: string }
/** Where a share listens: kept across restarts, so its address on the grid stays the same. */
type Address = { port: number; token: string }

const keyOf = (s: Pick<SwarmApiShare, 'grid' | 'connectionId' | 'model'>) => `${s.grid}\0${s.connectionId}\0${s.model}`
const said = (r: GridResult) => (r.stderr.trim() || r.message || 'grid refused the request.').slice(0, 400)

export class SwarmApiShares {
  private readonly running = new Map<string, Running>()
  /** Every join and leave, one at a time: grid restarts its one engine process for a grid on each, and two at once killed
   *  each other's process before either registered (2026-10-24: the restore and a heal right after a restart left the
   *  grid with nothing; grid's log said another process held the engine's lock). */
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly deps: SwarmApiSharesDeps) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }

  list(grid?: string): SwarmApiShare[] {
    return [...this.running.values()].filter(s => !grid || s.grid === grid)
      .map(({ grid: g, connectionId, model, name }) => ({ grid: g, connectionId, model, name }))
  }

  /** Puts [model] of the saved API [connectionId] on [grid]. Sharing what is already shared answers as done. */
  share(grid: string, connectionId: string, model: string): Promise<{ ok: true } | { error: string }> {
    return this.serial(() => this.shareNow(grid, connectionId, model))
  }

  /** Shares [model] at [at] when an earlier process noted one and it is free, else at a new address. Grid keys a joined
   *  engine by its address (`_spec_key`): a new one each restart left the old, dead one in grid's engine record beside it,
   *  and grid's engine process did not come up while it named one (2026-10-24). */
  private async shareNow(grid: string, connectionId: string, model: string, at?: Address): Promise<{ ok: true } | { error: string }> {
    const key = keyOf({ grid, connectionId, model })
    if (this.running.has(key)) return { ok: true }
    let access: { connection: ApiConnection; apiKey: string }
    try { access = this.deps.access(connectionId) } catch (error) { return { error: error instanceof Error ? error.message : 'This API is not saved.' } }
    const listen = async (token: string, port: number) => {
      const server = this.serve(token, access)
      const bound = await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
      }).catch(() => null)
      return bound === null ? null : { server, port: bound, token }
    }
    const opened = (at ? await listen(at.token, at.port) : null) ?? await listen(randomBytes(18).toString('hex'), 0)
    if (!opened) return { error: 'This computer could not open a local endpoint for the API.' }
    // A noted share that could not keep its address: its old one goes first, or grid would keep naming it.
    if (at && (opened.port !== at.port || opened.token !== at.token)) {
      await this.deps.exec(['--remote', 'leave', grid, '--engine', model]).catch(() => {})
    }
    const joined = await this.join(grid, model, opened)
    if (joined?.code !== 'OK') { opened.server.close(); return { error: joined ? said(joined) : 'grid could not be run on this computer.' } }
    this.running.set(key, { grid, connectionId, model, name: access.connection.name, server: opened.server, alias: model, port: opened.port, token: opened.token })
    await this.note()
    return { ok: true }
  }

  private join(grid: string, model: string, at: Address): Promise<GridResult | null> {
    return this.deps.exec(['--remote', 'join', grid, '--at', `http://127.0.0.1:${at.port}/${at.token}/v1`, '-m', model,
      // No `--name`: on a remote grid it names this computer's node, not the engine, and an API's name there read as if
      // OpenRouter were the machine serving every model on it (2026-10-23).
      '--advertise-as', model, '--max-concurrency', String(CONCURRENCY)]).catch(() => null)
  }

  /** Takes [model] off [grid] and closes its endpoint. Stopping what is not shared answers as done. */
  stop(grid: string, connectionId: string, model: string): Promise<{ ok: true } | { error: string }> {
    return this.serial(() => this.stopNow(grid, connectionId, model))
  }

  private async stopNow(grid: string, connectionId: string, model: string): Promise<{ ok: true } | { error: string }> {
    const running = this.running.get(keyOf({ grid, connectionId, model }))
    if (!running) return { ok: true }
    const left = await this.deps.exec(['--remote', 'leave', grid, '--engine', running.alias])
    if (left.code !== 'OK') return { error: said(left) }
    running.server.close()
    this.running.delete(keyOf(running))
    await this.note()
    return { ok: true }
  }

  /** Joins [model] to [grid] again at the address it already has: grid merges it into what it serves and restarts its
   *  engine process for the grid with every model this computer joined there (`swarmHeal.ts`). Never a leave first: a
   *  remote leave stops every engine process of the grid, the one it just restarted too (grid `shared/orphan_sweep.py`),
   *  and a leave-then-join left the grid with nothing (2026-10-24). */
  rejoin(grid: string, connectionId: string, model: string): Promise<{ ok: true } | { error: string }> {
    return this.serial(async () => {
      const running = this.running.get(keyOf({ grid, connectionId, model }))
      if (!running) return this.shareNow(grid, connectionId, model)
      const joined = await this.join(grid, model, running)
      return joined?.code === 'OK' ? { ok: true as const } : { error: joined ? said(joined) : 'grid could not be run on this computer.' }
    })
  }

  /** Brings back the shares an earlier process noted: their endpoints died with it, so each listens again at the address
   *  it had and joins again, reading the saved API afresh. A note from before addresses were kept is taken off its grid
   *  and shared at a new one. One whose API is no longer saved, or that grid refuses, stays off: a person shares again
   *  from the Swarm's Your models. */
  restore(): Promise<void> {
    return this.serial(() => this.restoreNow())
  }

  private async restoreNow(): Promise<void> {
    if (!this.deps.stateFile) return
    const noted = await readFile(this.deps.stateFile, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => [])
    for (const row of Array.isArray(noted) ? noted : []) {
      const { grid, alias, connectionId, port, token } = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
      if (typeof grid !== 'string' || typeof alias !== 'string') continue
      const at = typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 && typeof token === 'string' && /^[0-9a-f]{36}$/.test(token)
        ? { port, token } : undefined
      if (!at) await this.deps.exec(['--remote', 'leave', grid, '--engine', alias]).catch(() => {})
      if (typeof connectionId === 'string') await this.shareNow(grid, connectionId, alias, at).catch(() => {})
    }
    await this.note()
  }

  private async note(): Promise<void> {
    if (!this.deps.stateFile) return
    // The path token is noted (the file is the person's alone, 0600) so the address survives a restart; the key never is.
    await writeFile(this.deps.stateFile, JSON.stringify([...this.running.values()].map(({ grid, alias, connectionId, port, token }) => ({ grid, alias, connectionId, port, token }))), { mode: 0o600 }).catch(() => {})
  }

  /** Every share of the saved API [connectionId] off its grid, its endpoint closed whether or not grid answers: the API
   *  is being deleted, and a share holds its key in this process, so it would serve on a key the person removed. */
  stopConnection(connectionId: string): Promise<void> {
    return this.serial(async () => {
      const gone = [...this.running.values()].filter(share => share.connectionId === connectionId)
      for (const share of gone) {
        await this.deps.exec(['--remote', 'leave', share.grid, '--engine', share.alias]).catch(() => {})
        share.server.close()
        this.running.delete(keyOf(share))
      }
      if (gone.length) await this.note()
    })
  }

  /** Every share off its grid, as the process ends: an endpoint that is gone serves nothing. */
  async stopAll(): Promise<void> {
    for (const share of [...this.running.values()]) await this.stop(share.grid, share.connectionId, share.model).catch(() => {})
  }

  private serve(token: string, { connection, apiKey }: { connection: ApiConnection; apiKey: string }): Server {
    const prefix = `/${token}/v1`
    return createServer((req, res) => { void this.forward(req, res, prefix, connection, apiKey) })
  }

  private async forward(req: IncomingMessage, res: ServerResponse, prefix: string, connection: ApiConnection, apiKey: string): Promise<void> {
    const url = req.url ?? ''
    const path = url.startsWith(`${prefix}/`) ? url.slice(prefix.length).split('?')[0]! : null
    if (path === null || !ALLOWED.has(`${req.method} ${path}`)) { res.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) { res.writeHead(413).end(); return }
      chunks.push(chunk as Buffer)
    }
    try {
      const answer = await (this.deps.fetch ?? fetch)(`${connection.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: req.method,
        headers: { authorization: `Bearer ${apiKey}`, ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
          ...(req.headers.accept ? { accept: req.headers.accept } : {}) },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      })
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' })
      if (answer.body) Readable.fromWeb(answer.body as never).pipe(res)
      else res.end()
    } catch {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    }
  }
}
