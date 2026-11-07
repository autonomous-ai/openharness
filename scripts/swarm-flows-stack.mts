/** The disposable stack Desktop's Swarm flow tests (desktop/test/swarm_flows/) drive: the real backend on a
 * throwaway MongoDB and Redis with a stub sign-in, and the real daemon from this checkout under a throwaway home,
 * signed in with a fixture token only the stub accepts, with fake Claude Code and Codex engines. Nothing here reads
 * or changes the person's own login, daemon or tmux server.
 *
 * Run from cli/: `node --import tsx ../scripts/swarm-flows-stack.mts` with HARNESS_E2E_SERVICES_DIR naming a folder
 * with mongodb-memory-server and redis-memory-server (scripts/swarm-flows.sh prepares it). Prints one JSON line,
 * {localPort, socketPath, machineId, owner, teammate, controlPort, logs}, and stops everything when its stdin closes.
 *
 * The control server (loopback only) lets a test act as someone other than the person at the app. Every request carries
 * the run's random token (`controlToken` in the ready line) in x-swarm-flows-token: another process or a web page on
 * this computer cannot use it.
 *   POST /api   {as: 'owner'|'teammate', path, method, body} — that account's backend call.
 *   POST /agent {tab, agent, args}  — `harness super-tab --tab TAB --agent AGENT …args` on the daemon, exactly what
 *                                     an agent runs, so its posts and statuses arrive as the agent's own.
 *   POST /engine {name, crashes}     — the fake engine `name` (claude or codex) exits at once when started (its version probe still
 *                                     answers), as a broken install does, or works again. */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { superTabCommand } from '../cli/src/superTabs/command.js'
import { account, signIn, startRealBackend } from '../cli/e2e/harness/realBackend.js'

const owner = account('owner')
const teammate = account('teammate')
const accounts = { owner, teammate }
const log = (line: string) => process.stderr.write(`swarm-flows-stack: ${line}\n`)

const backend = await startRealBackend([owner, teammate], log)
let stopping = false
async function stop(code: number) {
  if (stopping) return
  stopping = true
  await backend.stop().catch(error => log(`stop failed: ${String(error)}`))
  process.exit(code)
}
process.on('SIGTERM', () => { void stop(0) })
process.on('SIGINT', () => { void stop(0) })
process.on('uncaughtException', error => { log(String(error?.stack ?? error)); void stop(1) })
process.on('unhandledRejection', error => { log(String(error)); void stop(1) })
process.stdin.on('end', () => { void stop(0) })
process.stdin.resume()

const side = await signIn(backend, owner, { ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential' })
const me = async (a: typeof owner) => (await backend.api(a, '/api/auth/me')).body?.data?.user as { id: string; email: string }
const [ownerUser, teammateUser] = [await me(owner), await me(teammate)]

async function body(req: import('node:http').IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

const wrappers: Record<string, string> = {}
const token = randomBytes(32).toString('hex')
const ENGINES = new Set(['claude', 'codex'])
const authorized = (header: string | string[] | undefined) =>
  typeof header === 'string' && header.length === token.length && timingSafeEqual(Buffer.from(header), Buffer.from(token))
const control = createServer((req, res) => {
  void (async () => {
    res.setHeader('content-type', 'application/json')
    if (!authorized(req.headers['x-swarm-flows-token'])) { res.writeHead(403).end('{}'); return }
    const input = await body(req)
    if (req.url === '/api') {
      const who = accounts[input.as as keyof typeof accounts]
      if (!who) { res.writeHead(400).end(JSON.stringify({ error: 'as: owner or teammate' })); return }
      res.end(JSON.stringify(await backend.api(who, input.path, input.method ?? 'GET', input.body)))
      return
    }
    if (req.url === '/engine') {
      if (!ENGINES.has(input.name)) { res.writeHead(400).end(JSON.stringify({ error: 'name: claude or codex' })); return }
      const path = join(side.daemon.root, 'bin', String(input.name))
      wrappers[path] ??= readFileSync(path, 'utf8')
      writeFileSync(path, input.crashes ? `#!/bin/sh\ncase "$*" in *--version*) exec ${JSON.stringify(path)}.real "$@";; esac\necho "${input.name} crashed" >&2\nexit 1\n` : wrappers[path]!)
      if (input.crashes) writeFileSync(`${path}.real`, wrappers[path]!, { mode: 0o755 })
      res.end('{}')
      return
    }
    if (req.url === '/agent') {
      let out = ''
      const code = await superTabCommand(['--tab', input.tab, '--agent', input.agent, ...input.args], {
        where: () => ({ port: side.daemon.port, dataDir: side.daemon.dataDir, machineId: side.machineId }),
        print: text => { out = text },
      })
      res.end(JSON.stringify({ code, out }))
      return
    }
    res.writeHead(404).end('{}')
  })().catch(error => { res.writeHead(500).end(JSON.stringify({ error: String(error) })) })
})
control.listen(0, '127.0.0.1')
await once(control, 'listening')
console.log(JSON.stringify({
  localPort: side.daemon.port,
  machineId: side.machineId,
  socketPath: side.daemon.socketPath,
  owner: ownerUser,
  teammate: teammateUser,
  controlPort: (control.address() as { port: number }).port,
  controlToken: token,
  projectsDir: side.daemon.projectsDir,
  logs: backend.logPath,
}))
