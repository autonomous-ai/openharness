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
  /**
   * Each of [codex]'s plugins with its name and icon (a code in assets/web/icons), where there is more than one: ChatGPT connects each on its own, so the apps
   * offer each on its own, and one connected leaves the others to be.
   */
  parts?: Record<string, { name: string, icon: string }>
  /** What each way lets an agent do, in a few words; `harness` is Harness's own sign-in, absent when it has none. */
  scope: Partial<Record<Via | 'harness', string>> & Record<Via, string>
  /** The service's own page in claude.ai's connector directory: straight to it, not the directory to look for it in. */
  claudePage: string
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
    claude: 'Google Calendar', codex: ['google-calendar@openai-curated-remote'], claudePage: `${CLAUDE_CONNECTORS}/id/google-calendar-calendarmcp`,
    scope: { claude: 'See events. No editing.', codex: 'See and manage events.', harness: 'See, add, delete events.' },
  },
  google_drive: {
    claude: 'Google Drive', codex: ['google-drive@openai-curated-remote'], claudePage: `${CLAUDE_CONNECTORS}/id/google-drive-drivemcp`,
    scope: { claude: 'Search, read, manage files.', codex: 'Drive, Docs, Sheets, Slides.', harness: 'Only files it creates.' },
  },
  // No Harness sign-in: only Claude's connector or Codex's Outlook and SharePoint plugins.
  microsoft_365: {
    claude: 'Microsoft 365', claudePage: `${CLAUDE_CONNECTORS}/id/microsoft-365`,
    codex: ['outlook-email@openai-curated-remote', 'outlook-calendar@openai-curated-remote', 'sharepoint@openai-curated-remote'],
    parts: {
      'outlook-email@openai-curated-remote': { name: 'Outlook mail', icon: 'outlook_mail' },
      'outlook-calendar@openai-curated-remote': { name: 'Outlook calendar', icon: 'outlook_calendar' },
      'sharepoint@openai-curated-remote': { name: 'SharePoint', icon: 'sharepoint' },
    },
    scope: { claude: 'Outlook mail, calendar and files.', codex: 'Outlook mail, calendar, SharePoint.' },
    card: { name: 'Microsoft 365', description: 'Your Outlook mail, calendar and files, through Claude or Codex.' },
  },
}

/** What the routes say about themselves for the apps: the services with no Harness card. */
const OWN_CARDS = Object.entries(ROUTES).flatMap(([connector, route]) => (route.card ? [{ connector, ...route.card }] : []))

/** Where the person connects or disconnects [route] in [via]'s account. */
function signInPage(route: Route, via: Via): string {
  return via === 'claude' ? route.claudePage : CHATGPT_CONNECTORS
}

/** ChatGPT's list of plugins: where Codex's are signed in when one's own page is not known. */
const CHATGPT_CONNECTORS = 'https://chatgpt.com/#settings/Connectors'

/**
 * Each Codex plugin's own page on ChatGPT, by PLUGIN@MARKETPLACE, from `codex plugin list --json`'s `source.id`
 * (`plugin_connector_1p_…`): straight to Gmail's sign-in rather than the list to look for it in.
 */
export function codexPluginPages(listing: string): Map<string, string> {
  const pages = new Map<string, string>()
  let data: unknown
  try { data = JSON.parse(listing) } catch { return pages }
  for (const key of ['installed', 'available']) {
    const rows = (data as Record<string, unknown> | null)?.[key]
    if (!Array.isArray(rows)) continue
    for (const row of rows as { pluginId?: unknown, source?: { id?: unknown } }[]) {
      const id = row?.source?.id
      // Only an id that is plainly one: it becomes part of an address the person opens.
      if (typeof row?.pluginId === 'string' && typeof id === 'string' && /^[A-Za-z0-9_]+$/.test(id)) {
        pages.set(row.pluginId, `https://chatgpt.com/settings/plugins-settings/${id}`)
      }
    }
  }
  return pages
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
  /** Per service Codex splits, each of its plugins with its name and state, where this computer has Codex. */
  parts: Record<string, { plugin: string, name: string, icon: string, state: ViaState, page: string }[]>
  /**
   * Per service, its own page in each engine's account, where an account is added or its settings changed once it
   * is in: claude.ai's connector, or the Codex plugin's page on ChatGPT (its `source.id`); each one's list when not known.
   */
  pages: Record<string, Partial<Record<Via, string>>>
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
  /** How long an answer waits on an engine; its read goes on after that. */
  answerMs?: number
}

/** Within what the apps wait for an answer (the phone, 60 s). */
const ANSWER_MS = 45_000

/**
 * How long an engine's read may run. Codex just signed in fetches ChatGPT's plugin catalog in about a minute, once,
 * and saves it; every read after takes a second (the MSI, 2026-11-12). Killed at the answer's 45 s, it never saved
 * it, and Codex's plugins stayed missing until a read from a terminal ran to the end.
 */
const READ_MS = 5 * 60_000

/** The reads still running, by command line: pages asking at once share one, as do pages asking again while it runs. */
const reads = new Map<string, Promise<string>>()

function read(exec: Run, command: string, args: string[]): Promise<string> {
  const key = [command, ...args].join('\0')
  let reading = reads.get(key)
  if (!reading) {
    reading = exec(command, args, READ_MS).finally(() => reads.delete(key))
    reads.set(key, reading)
  }
  return reading
}

/** [engine]'s read, parsed, or null when it failed or is still running at [answerMs]: said once in the log, either way. */
async function answer<T>(engine: Via, reading: Promise<string>, parse: (listing: string) => T, answerMs: number): Promise<T | null> {
  const LATE = Symbol('late')
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<typeof LATE>((resolve) => { timer = setTimeout(() => resolve(LATE), answerMs) })
  try {
    const said = await Promise.race([reading, late])
    if (said !== LATE) return parse(said)
    console.warn(`[connections] ${engine} has not answered in ${Math.round(answerMs / 1000)}s; its read goes on, and the next look has it`)
  } catch (error) {
    console.warn(`[connections] ${engine} could not say what it holds: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
  return null
}

/** What this computer's Claude Code and Codex hold of the three services. An engine that cannot answer reads as not connected. */
export async function elsewhere(deps: ElsewhereDeps = {}): Promise<Elsewhere> {
  const binary = deps.binary ?? engineBinary
  const exec = deps.run ?? run
  const answerMs = deps.answerMs ?? ANSWER_MS
  const claude = binary('claude')
  const codex = binary('codex')
  // Codex's listing as it printed it: what is installed, and each plugin's page.
  const [claudeSaid, codexListing] = await Promise.all([
    claude ? answer('claude', read(exec, claude, ['mcp', 'list']), claudeConnectors, answerMs).then((said) => said ?? {}) : null,
    codex ? answer('codex', read(exec, codex, ['plugin', 'list', '--json', '--marketplace', CODEX_MARKETPLACE]), (listing) => listing, answerMs)
      .then((said) => said ?? '') : null,
  ])
  const codexSaid = codexListing === null ? null : codexPlugins(codexListing)
  const codexPages = codexPluginPages(codexListing ?? '')
  const codexPage = (plugin: string) => codexPages.get(plugin) ?? CHATGPT_CONNECTORS
  const result: Elsewhere = {
    engines: { claude: claude !== null, codex: codex !== null }, connections: {}, scopes: {}, services: OWN_CARDS, parts: {}, pages: {},
  }
  for (const [code, route] of Object.entries(ROUTES)) {
    const states: Partial<Record<Via, ViaState>> = {}
    const pages: Partial<Record<Via, string>> = {}
    if (claudeSaid) {
      states.claude = claudeSaid[route.claude] ?? 'not_connected'
      pages.claude = signInPage(route, 'claude')
    }
    // One of a service's plugins is enough for Codex to reach it.
    if (codexSaid) {
      states.codex = route.codex.some((plugin) => codexSaid.has(plugin)) ? 'installed' : 'not_connected'
      pages.codex = codexPage(route.codex[0])
    }
    result.connections[code] = states
    result.scopes[code] = route.scope
    result.pages[code] = pages
    if (codexSaid && route.parts) {
      result.parts[code] = Object.entries(route.parts).map(([plugin, { name, icon }]) => ({
        plugin, name, icon, state: codexSaid.has(plugin) ? 'installed' as const : 'not_connected' as const, page: codexPage(plugin),
      }))
    }
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
export async function connectVia(code: unknown, viaName: unknown, deps: ElsewhereDeps = {}, part?: unknown): Promise<{ url: string }> {
  const { route, via } = routeOf(code, viaName)
  if (via === 'codex') {
    const codex = (deps.binary ?? engineBinary)('codex')
    if (!codex) throw new ConnectorError('Codex is not installed on this computer.')
    const plugins = pluginsOf(route, part)
    try { for (const plugin of plugins) await (deps.run ?? run)(codex, ['plugin', 'add', plugin], 120_000) } catch {
      throw new ConnectorError('Codex could not install its plugin. Sign in to Codex with ChatGPT, then try again.')
    }
    return { url: await pluginPage(codex, plugins[0], deps) }
  }
  if (!(deps.binary ?? engineBinary)('claude')) throw new ConnectorError('Claude Code is not installed on this computer.')
  return { url: signInPage(route, via) }
}

/** Stop [via] using [code]: Codex's plugin is removed here, with no page to open; Claude's connector is claude.ai's, whose page it answers. */
export async function disconnectVia(code: unknown, viaName: unknown, deps: ElsewhereDeps = {}, part?: unknown): Promise<{ url?: string }> {
  const { route, via } = routeOf(code, viaName)
  // Claude's connector is claude.ai's to remove: its page is all there is to open.
  if (via === 'claude') return { url: signInPage(route, via) }
  // Codex's plugin is removed here, and that is all Remove is: no page to open. Codex gone since: nothing to remove.
  const codex = (deps.binary ?? engineBinary)('codex')
  if (!codex) return {}
  try { for (const plugin of pluginsOf(route, part)) await (deps.run ?? run)(codex, ['plugin', 'remove', plugin], 60_000) } catch {
    throw new ConnectorError('Codex could not remove its plugin. Try again.')
  }
  return {}
}

/** The one of [route]'s plugins [part] names, or all of them when it names none (an app from before parts). */
function pluginsOf(route: Route, part: unknown): string[] {
  if (part === undefined || part === null) return route.codex
  if (typeof part !== 'string' || !route.codex.includes(part)) throw new ConnectorError('Choose one of this service\'s plugins.')
  return [part]
}

/** [plugin]'s own page on ChatGPT, or ChatGPT's list when Codex does not say which it is. */
async function pluginPage(codex: string, plugin: string, deps: ElsewhereDeps): Promise<string> {
  try {
    const listing = await (deps.run ?? run)(codex, ['plugin', 'list', '--json', '--marketplace', CODEX_MARKETPLACE], 45_000)
    return codexPluginPages(listing).get(plugin) ?? CHATGPT_CONNECTORS
  } catch {
    return CHATGPT_CONNECTORS
  }
}
