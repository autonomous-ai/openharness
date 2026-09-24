import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { ApiConnectionError, ApiConnections } from './apiConnections.js'

export const apiUsage = `Saved APIs (Models → APIs):
  harness api list [--json]                 list connections, never keys
  harness api request <id> <path> [--method POST] [--data @file.json]
                                            call an API with its saved authentication
  harness api run <id> -- <command> [args]   give one tool its API key environment variable
                                            and HARNESS_API_BASE_URL; no engine login changes`

export async function apiCommand(argv: readonly string[], store: ApiConnections): Promise<number> {
  try {
    const [verb, connectionId, ...rest] = argv
    if (!verb || verb === 'help' || verb === '--help') { console.log(apiUsage); return 0 }
    if (verb === 'list') {
      const connections = store.list()
      console.log(argv.includes('--json') ? JSON.stringify(connections) : connections.length
        ? connections.map(row => `${row.id} · ${row.name} · ${row.baseUrl}`).join('\n')
        : 'No saved APIs. Add one in Models → APIs.')
      return 0
    }
    if (!connectionId) throw new ApiConnectionError(apiUsage)
    if (verb === 'run') {
      if (rest[0] !== '--' || !rest[1]) throw new ApiConnectionError(apiUsage)
      const environment = store.toolEnvironment(connectionId)
      return await new Promise<number>(resolve => {
        const child = spawn(rest[1], rest.slice(2), { stdio: 'inherit', env: { ...process.env, ...environment }, shell: false })
        child.once('error', () => { console.error('The API tool could not start. Check its command.'); resolve(1) })
        child.once('close', code => resolve(code ?? 1))
      })
    }
    if (verb === 'request') {
      const [path, ...flags] = rest
      if (path === undefined) throw new ApiConnectionError(apiUsage)
      let method = 'GET', body: string | undefined
      for (let at = 0; at < flags.length; at += 2) {
        const value = flags[at + 1]
        if (!value) throw new ApiConnectionError(apiUsage)
        if (flags[at] === '--method') method = value.toUpperCase()
        else if (flags[at] === '--data') body = value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value
        else throw new ApiConnectionError(apiUsage)
      }
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) || (body !== undefined && ['GET', 'HEAD'].includes(method))) {
        throw new ApiConnectionError('Choose an HTTP method that supports this request.')
      }
      const config = store.requestConfig(connectionId, path)
      const response = await fetch(config.url, {
        method, body, headers: { ...config.headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(120_000),
      })
      console.log(await response.text())
      if (!response.ok) console.error(`API request failed (HTTP ${response.status}).`)
      return response.ok ? 0 : 1
    }
    throw new ApiConnectionError(apiUsage)
  } catch (error) {
    console.error(error instanceof ApiConnectionError ? error.message : 'The API request could not finish. Check the connection and try again.')
    return 1
  }
}
