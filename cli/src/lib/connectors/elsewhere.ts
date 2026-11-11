/**
 * Gmail, Google Calendar, Google Drive and Microsoft 365 connected through an agent's own account instead of Harness's: claude.ai's
 * connector, which Claude Code on this computer picks up from the account it signed in with, or the ChatGPT plugin
 * Codex installs. Harness holds no token for either: it only says whether this computer has the engine, what the
 * engine reports, and where the person signs in. Claude's reads and searches mail, which Harness's grant cannot.
 *
 * - Claude: `claude mcp list` lists the claude.ai connectors with their state ("claude.ai Gmail: … - ✔ Connected").
 * - Codex: `codex plugin list --json` says whether the plugin is installed; the Google grant lives in ChatGPT and
 *   is asked for the first time Codex uses it, so "installed" is all this computer can know.
 */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { resolveBinaryOnPath } from '../binaryOnPath.js'
import { loginShellEnvironment } from '../loginShellEnv.js'
import { ConnectorError } from './store.js'

export type Via = 'claude' | 'codex'

interface Route {
  /** The connector's name on claude.ai, as `claude mcp list` prints it after "claude.ai ". */
  claude: string
  /** The Codex plugins, PLUGIN@MARKETPLACE: Codex splits some services in several (Microsoft 365). */
  codex: string[]
  /** What each way lets an agent do, in a few words; `harness` is Harness's own sign-in, absent when it has none. */
  scope: Partial<Record<Via | 'harness', string>> & Record<Via, string>
  /** The service's own page in claude.ai's connector directory, where one is known; else the directory. */
  claudePage?: string
  /** A service Harness's catalog has no card for (only an engine connects it): the card the apps draw. */
  card?: { name: string, description: string }
}

/** claude.ai's connector directory: Settings ▸ Customize ▸ Connectors (2026-11; Settings ▸ Connectors only points here now). */
// `/new/`, not `/new`: the Claude Android app claims `claude.ai/new` (its intent filters), and a phone hands that address
// to the app, which opens at a chat; `/new/` it does not claim, and the web sends it on to `/new`, at the connector.
const CLAUDE_CONNECTORS = 'https://claude.ai/new/#customize/connectors'

/**
 * The marketplace every plugin below comes from. Listing only it takes a second; listing every marketplace waited on
 * all of them and took over a minute on a Mac, past what the apps wait for an answer.
 */
const CODEX_MARKETPLACE = 'openai-curated-remote'

export const ROUTES: Record<string, Route> = {
  gmail: {
    claude: 'Gmail', codex: ['gmail@openai-curated-remote'], claudePage: `${CLAUDE_CONNECTORS}/id/gmail-gmailmcp`,
    scope: { claude: 'Read, search, draft, send.', codex: 'Read, search, manage.', harness: 'Send only.' },
  },
  google_calendar: {
    claude: 'Google Calendar', codex: ['google-calendar@openai-curated-remote'],
    scope: { claude: 'See events. No editing.', codex: 'See and manage events.', harness: 'See, add, delete events.' },
  },
  google_drive: {
    claude: 'Google Drive', codex: ['google-drive@openai-curated-remote'],
    scope: { claude: 'Search, read, manage files.', codex: 'Drive, Docs, Sheets, Slides.', harness: 'Only files it creates.' },
  },
  // No Harness sign-in: only Claude's connector or Codex's Outlook and SharePoint plugins.
  microsoft_365: {
    claude: 'Microsoft 365',
    codex: ['outlook-email@openai-curated-remote', 'outlook-calendar@openai-curated-remote', 'sharepoint@openai-curated-remote'],
    scope: { claude: 'Outlook mail, calendar and files.', codex: 'Outlook mail, calendar, SharePoint.' },
    card: { name: 'Microsoft 365', description: 'Your Outlook mail, calendar and files, through Claude or Codex.' },
  },
}

/** What the routes say about themselves for the apps: the services with no Harness card. */
const OWN_CARDS = Object.entries(ROUTES).flatMap(([connector, route]) => (route.card ? [{ connector, ...route.card }] : []))

/** Where the person connects or disconnects [route] in [via]'s account. */
function signInPage(route: Route, via: Via): string {
  return via === 'claude' ? route.claudePage ?? CLAUDE_CONNECTORS : 'https://chatgpt.com/#settings/Connectors'
}

/** `connected`, `reconnect` (claude.ai holds it but it needs signing in again), `installed` (Codex), or `not_connected`. */
export type ViaState = 'connected' | 'reconnect' | 'installed' | 'not_connected'

export interface Elsewhere {
  /** Which engines this computer has: only those are offered. */
  engines: Record<Via, boolean>
  /** Per service, its state in each engine this computer has. */
  connections: Record<string, Partial<Record<Via, ViaState>>>
  /** Per service, what each way lets an agent do; no `harness` where Harness has no way in. */
  scopes: Record<string, Record<string, string>>
  /** Services only an engine connects, which the Harness list has no card for: the apps add these. */
  services: { connector: string, name: string, description: string }[]
}

export type Run = (command: string, args: string[], timeoutMs: number) => Promise<string>

/** The engine's program, on the login shell's PATH (where a launch finds it), then the daemon's own. */
export function engineBinary(name: Via, env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveBinaryOnPath(name, { PATH: loginShellEnvironment().PATH }) ?? resolveBinaryOnPath(name, env)
}

const run: Run = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  const env = { ...process.env, ...loginShellEnvironment(), NO_COLOR: '1' }
  // From the home folder: `claude mcp list` also checks the servers of the folder it runs in.
  execFile(command, args, { cwd: homedir(), env, timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout) => {
    if (error) reject(error)
    else resolve(String(stdout))
  })
})

/** The claude.ai connectors `claude mcp list` printed, by name. */
export function claudeConnectors(listing: string): Record<string, ViaState> {
  const found: Record<string, ViaState> = {}
  for (const line of listing.split('\n')) {
    const match = /^claude\.ai (.+?): .* - (.+)$/.exec(line.trim())
    if (!match) continue
    found[match[1]] = /connected/i.test(match[2]) && !/not connected/i.test(match[2]) ? 'connected' : 'reconnect'
  }
  return found
}

/** The Codex plugins `codex plugin list --json` says are installed, as PLUGIN@MARKETPLACE. */
export function codexPlugins(listing: string): Set<string> {
  const installed = new Set<string>()
  let data: unknown
  try { data = JSON.parse(listing) } catch { return installed }
  const rows = (data as { installed?: unknown } | null)?.installed
  if (!Array.isArray(rows)) return installed
  for (const row of rows as { pluginId?: unknown, installed?: unknown }[]) {
    if (typeof row?.pluginId === 'string' && row.installed !== false) installed.add(row.pluginId)
  }
  return installed
}

export interface ElsewhereDeps {
  binary?: (name: Via) => string | null
  run?: Run
}

/** What this computer's Claude Code and Codex hold of the three services. An engine that cannot answer reads as not connected. */
export async function elsewhere(deps: ElsewhereDeps = {}): Promise<Elsewhere> {
  const binary = deps.binary ?? engineBinary
  const exec = deps.run ?? run
  const claude = binary('claude')
  const codex = binary('codex')
  const [claudeSaid, codexSaid] = await Promise.all([
    claude ? exec(claude, ['mcp', 'list'], 45_000).then(claudeConnectors, () => ({} as Record<string, ViaState>)) : null,
    codex ? exec(codex, ['plugin', 'list', '--json', '--marketplace', CODEX_MARKETPLACE], 45_000).then(codexPlugins, () => new Set<string>()) : null,
  ])
  const result: Elsewhere = {
    engines: { claude: claude !== null, codex: codex !== null }, connections: {}, scopes: {}, services: OWN_CARDS,
  }
  for (const [code, route] of Object.entries(ROUTES)) {
    const states: Partial<Record<Via, ViaState>> = {}
    if (claudeSaid) states.claude = claudeSaid[route.claude] ?? 'not_connected'
    // One of a service's plugins is enough for Codex to reach it.
    if (codexSaid) states.codex = route.codex.some((plugin) => codexSaid.has(plugin)) ? 'installed' : 'not_connected'
    result.connections[code] = states
    result.scopes[code] = route.scope
  }
  return result
}

function routeOf(code: unknown, via: unknown): { route: Route, via: Via } {
  const route = typeof code === 'string' ? ROUTES[code] : undefined
  if (!route) throw new ConnectorError('Only Gmail, Google Calendar, Google Drive and Microsoft 365 connect through Claude or Codex.')
  if (via !== 'claude' && via !== 'codex') throw new ConnectorError('Choose Claude or Codex.')
  return { route, via }
}

/**
 * Start connecting [code] through [via]: for Codex the plugin is installed first. Answers the page the person signs
 * in on, in that engine's account.
 */
export async function connectVia(code: unknown, viaName: unknown, deps: ElsewhereDeps = {}): Promise<{ url: string }> {
  const { route, via } = routeOf(code, viaName)
  if (via === 'codex') {
    const codex = (deps.binary ?? engineBinary)('codex')
    if (!codex) throw new ConnectorError('Codex is not installed on this computer.')
    try { for (const plugin of route.codex) await (deps.run ?? run)(codex, ['plugin', 'add', plugin], 120_000) } catch {
      throw new ConnectorError('Codex could not install its plugin. Sign in to Codex with ChatGPT, then try again.')
    }
  } else if (!(deps.binary ?? engineBinary)('claude')) {
    throw new ConnectorError('Claude Code is not installed on this computer.')
  }
  return { url: signInPage(route, via) }
}

/** Stop [via] using [code]: Codex's plugin is removed here; the grant itself is ended in that engine's account. */
export async function disconnectVia(code: unknown, viaName: unknown, deps: ElsewhereDeps = {}): Promise<{ url: string }> {
  const { route, via } = routeOf(code, viaName)
  const codex = via === 'codex' ? (deps.binary ?? engineBinary)('codex') : null
  if (codex) {
    try { for (const plugin of route.codex) await (deps.run ?? run)(codex, ['plugin', 'remove', plugin], 60_000) } catch {
      throw new ConnectorError('Codex could not remove its plugin. Try again.')
    }
  }
  return { url: signInPage(route, via) }
}
