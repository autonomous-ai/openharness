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

interface Running extends SwarmApiShare { server: Server; alias: string }

const keyOf = (s: Pick<SwarmApiShare, 'grid' | 'connectionId' | 'model'>) => `${s.grid}\0${s.connectionId}\0${s.model}`
const said = (r: GridResult) => (r.stderr.trim() || r.message || 'grid refused the request.').slice(0, 400)

export class SwarmApiShares {
  private readonly running = new Map<string, Running>()
  constructor(private readonly deps: SwarmApiSharesDeps) {}

  list(grid?: string): SwarmApiShare[] {
    return [...this.running.values()].filter(s => !grid || s.grid === grid)
      .map(({ grid: g, connectionId, model, name }) => ({ grid: g, connectionId, model, name }))
  }

  /** Puts [model] of the saved API [connectionId] on [grid]. Sharing what is already shared answers as done. */
  async share(grid: string, connectionId: string, model: string): Promise<{ ok: true } | { error: string }> {
    const key = keyOf({ grid, connectionId, model })
    if (this.running.has(key)) return { ok: true }
    let access: { connection: ApiConnection; apiKey: string }
    try { access = this.deps.access(connectionId) } catch (error) { return { error: error instanceof Error ? error.message : 'This API is not saved.' } }
    const token = randomBytes(18).toString('hex')
    const server = this.serve(token, access)
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    }).catch(() => null)
    if (port === null) return { error: 'This computer could not open a local endpoint for the API.' }
    const joined = await this.deps.exec(['--remote', 'join', grid, '--at', `http://127.0.0.1:${port}/${token}/v1`, '-m', model,
      '--advertise-as', model, '--max-concurrency', String(CONCURRENCY), '--name', access.connection.name]).catch(() => null)
    if (joined?.code !== 'OK') { server.close(); return { error: joined ? said(joined) : 'grid could not be run on this computer.' } }
    this.running.set(key, { grid, connectionId, model, name: access.connection.name, server, alias: model })
    await this.note()
    return { ok: true }
  }

  /** Takes [model] off [grid] and closes its endpoint. Stopping what is not shared answers as done. */
  async stop(grid: string, connectionId: string, model: string): Promise<{ ok: true } | { error: string }> {
    const running = this.running.get(keyOf({ grid, connectionId, model }))
    if (!running) return { ok: true }
    const left = await this.deps.exec(['--remote', 'leave', grid, '--engine', running.alias])
    if (left.code !== 'OK') return { error: said(left) }
    running.server.close()
    this.running.delete(keyOf(running))
    await this.note()
    return { ok: true }
  }

  /** Brings back the shares an earlier process noted: their endpoints died with it, so each is taken off its grid and
   *  shared again on a new one, reading the saved API afresh. One whose API is no longer saved, or that grid refuses,
   *  stays off: a person shares again from the Swarm's Local models. */
  async restore(): Promise<void> {
    if (!this.deps.stateFile) return
    const noted = await readFile(this.deps.stateFile, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => [])
    for (const row of Array.isArray(noted) ? noted : []) {
      const { grid, alias, connectionId } = (row && typeof row === 'object' ? row : {}) as { grid?: unknown; alias?: unknown; connectionId?: unknown }
      if (typeof grid !== 'string' || typeof alias !== 'string') continue
      await this.deps.exec(['--remote', 'leave', grid, '--engine', alias]).catch(() => {})
      if (typeof connectionId === 'string') await this.share(grid, connectionId, alias).catch(() => {})
    }
    await this.note()
  }

  private async note(): Promise<void> {
    if (!this.deps.stateFile) return
    await writeFile(this.deps.stateFile, JSON.stringify([...this.running.values()].map(({ grid, alias, connectionId }) => ({ grid, alias, connectionId }))), { mode: 0o600 }).catch(() => {})
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
