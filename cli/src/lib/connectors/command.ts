/** `harness connections`: connect services once, for every local agent. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { label, services } from './catalog.js'
import { sync } from './agents.js'
import { disconnect, finish, signInFor } from './connect.js'
import { call, CallFailure, OFFICIAL_HOSTS, type Output } from './call.js'
import * as gateway from './gateway.js'
import { forgetPage, PageServer, rememberPage, runningPage } from './page.js'
import { refresh, refreshDue } from './renew.js'
import { ConnectorError, locked, RENAMED, Store, validateCode } from './store.js'

export const connectionsUsage = `Connected services (Linear, Notion, GitHub, Google…), shared by every local agent:
  harness connections                  open the Connectors page in the browser
  harness connections connect <code>   sign in from the terminal instead
  harness connections list [--json]    this computer's connections (no secrets)
  harness connections info <code>
  harness connections disconnect <code>
  harness connections refresh [<code>] renew tokens that are due (or this one now)
  harness connections sync             give Claude Code, Codex and OpenCode their MCP entries again
  harness connections call <code> <METHOD> <https-url> [--query K=V] [--json BODY|-] [--data K=V]
                                       [--form K=V|K=@file] [--header K:V]
                                       one REST request with the account's token, which you never see`

/** Best-effort: the address is printed too. Harness OS opens it in its own browser. */
export function openInBrowser(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const harnessBrowser = ['/usr/bin/hn-browser'].find(existsSync)
  const command = harnessBrowser ?? (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open')
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32', env })
    child.on('error', () => { /* No browser here (headless, ssh): the printed address is the way. */ })
    child.unref()
    return true
  } catch { return false }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The page, reused while it runs, else started detached so this command returns at once. */
async function openPage(vault: Store, io: Output): Promise<number> {
  let url = await runningPage(vault)
  if (!url) {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'connections', 'serve', '--background'],
      { stdio: 'ignore', detached: true, env: process.env })
    child.unref()
    for (let tries = 0; tries < 40 && !url; tries++) { await sleep(100); url = await runningPage(vault) }
    if (!url) { io.err('Could not open Connections.'); return 1 }
  }
  openInBrowser(url)
  io.out('Connections opened in the browser.\n')
  return 0
}

async function serve(vault: Store, argv: string[], io: Output): Promise<number> {
  const at = argv.indexOf('--port')
  const page = new PageServer(vault)
  const port = await page.listen(at >= 0 ? Number(argv[at + 1]) || 0 : 0)
  locked(vault.root, () => rememberPage(vault, port, page.key))
  if (!argv.includes('--background')) io.out(`${page.origin}/#${page.key}\n`)
  try { await page.serveUntilIdle() } finally { try { forgetPage(vault, port, page.key) } catch { /* Gone already. */ } }
  return 0
}

async function connectHere(vault: Store, raw: string, io: Output): Promise<number> {
  const code = RENAMED[validateCode(raw)] ?? raw
  const items = services(await gateway.available())
  const signIn = signInFor(vault, code, items)
  const url = await signIn.prepare()
  if (url) {
    io.out(`Opening the sign-in page. If it does not open, visit:\n${url}\n`)
    openInBrowser(url)
  }
  finish(vault, code, await signIn.wait())
  io.out(`${items[code].label} connected. Agents can use it now.\n`)
  return 0
}

function list(vault: Store, json: boolean, io: Output): number {
  const records = Object.entries(vault.tokens()).sort(([a], [b]) => a.localeCompare(b)).map(([code, token]) => vault.status(code, label(code), token))
  if (json) { io.out(JSON.stringify(records) + '\n'); return 0 }
  if (!records.length) io.out('no connectors linked\n')
  for (const record of records) {
    const how = record.tools ? 'MCP tools' : 'harness connections call'
    io.out(`${record.connector}: ${record.state} (${[record.account, how].filter(Boolean).join(', ')})\n`)
  }
  return 0
}

function info(vault: Store, code: string, io: Output): number {
  const token = vault.token(code)
  if (!token) throw new CallFailure(3, `${code}: not connected`)
  const record = vault.status(code, label(code), token)
  const when = (seconds?: number) => seconds ? new Date(seconds * 1000).toString() : 'not reported'
  io.out(JSON.stringify({
    connector: code, state: record.state, account: record.account,
    signed_in_through: token.source === 'gateway' ? 'Harness account' : 'this computer',
    scopes: record.scopes, agent_tools: record.tools, rest_call: code in OFFICIAL_HOSTS && token.source === 'gateway',
    auto_refresh: record.auto_refresh, expires: when(token.expires_at), obtained: when(token.obtained_at),
  }, null, 2) + '\n')
  return 0
}

export async function connectionsCommand(argv: string[], io: Output = { out: text => process.stdout.write(text), err: text => process.stderr.write(text + '\n') },
  vault = new Store()): Promise<number> {
  const [verb, ...rest] = argv
  try {
    if (!verb || verb === 'open') return await openPage(vault, io)
    if (verb === 'serve') return await serve(vault, rest, io)
    if (verb === 'connect' && rest.length === 1) return await connectHere(vault, rest[0], io)
    if (verb === 'list' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--json'))) return list(vault, rest[0] === '--json', io)
    if (verb === 'info' && rest.length === 1) return info(vault, validateCode(rest[0]), io)
    if (verb === 'disconnect' && rest.length === 1) {
      await disconnect(vault, validateCode(rest[0]))
      io.out('Disconnected on this computer. Revoke access at the provider to remove it elsewhere.\n')
      return 0
    }
    if (verb === 'sync' && rest.length === 0) {
      const changed = sync(vault)
      io.out(`Agents updated: ${Object.keys(changed).sort().join(', ') || 'none installed'}\n`)
      return 0
    }
    if (verb === 'refresh' && rest.length <= 1) {
      if (rest.length) { await refresh(vault, validateCode(rest[0]), true); return 0 }
      const failed = await refreshDue(vault)
      for (const [code, error] of Object.entries(failed)) io.err(`${code}: ${error}`)
      return Object.keys(failed).length ? 3 : 0
    }
    if (verb === 'call' && rest.length >= 3) return await call(vault, validateCode(rest[0]), rest[1], rest[2], rest.slice(3), io)
    io.err(connectionsUsage)
    return 2
  } catch (error) {
    if (error instanceof CallFailure) { io.err(error.message); return error.code }
    if (error instanceof ConnectorError) { io.err(error.message); return verb === 'call' ? 3 : 1 }
    // Never let a stack trace echo request details.
    io.err(`connections failed: ${(error as Error).name}`)
    return 1
  }
}
