/**
 * A Zellij pane (docs/plans/2026-11-19-dial-linux-design.md § 3.2): a tap focuses it by `zellij action focus-pane-id`,
 * then the terminal Zellij runs in comes forward as every app does, and the dial's words are typed into it by
 * `write-chars`, then `send-keys`. The daemon runs outside Zellij, so each command names the session. The session and
 * the pane came from a hook, so both are checked against their form before each command, which runs with no shell.
 * Zellij 0.44's `subscribe` reports no focus (testing/recordedZellij.ts), so the dial does not follow Zellij's focus.
 * Beside them, a lookup reads which client shows the agent's session, to place the agent on the page of the app that
 * holds it (createZellijOuter), as tmux's does. zellij is found as the core finds tmux (zellijFinder): the master's PATH
 * may hold none.
 */
import { dirname, join } from 'node:path'
import { binaryOnPath } from '../../lib/binaryOnPath.js'
import { binaryFinder, resolveViaLoginShell, tmuxInstallDirectories, type TmuxPathOutcome } from '../../lib/tmuxOnPath.js'
import type { HostAdapter, Pane, Place } from './adapter.js'
import { CONTROL, MAX_TEXT, RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { OuterLookup } from './outer.js'
import { parentChain, readPtyOwner, scannedApps, type ProcessName } from './scannedApp.js'
import { OUTER_EVERY_MS, PID } from './tmux.js'

// Zellij takes spaces and `:` in a session name too; this form keeps a name no argument parser reads as a flag, and
// lets `:` end the session in a pane id.
const SESSION = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'
const SESSION_NAME = new RegExp(`^${SESSION}$`)
const PANE_NUMBER = /^[0-9]{1,9}$/
// A pane that holds the agent's terminal but is not its own: words typed there land in whatever that pane shows.
const HELD = 'held:'
// `<session>:<pane>`. A session holds no `:`, so a held id never passes for an own one, even of a session named `held`.
const OWN_PANE = new RegExp(`^(${SESSION}):([0-9]{1,9})$`)
const ANY_PANE = new RegExp(`^(?:${HELD})?(${SESSION}):([0-9]{1,9})$`)
/** One row of `list-clients` under its header: a client's id first (RECORDED_ZELLIJ.listClients). */
const CLIENT_ROW = /^[0-9]+\s/

export interface ZellijDeps {
  run: OrcaDeps['run']
  /** Where zellij is (zellijFinder); it never rejects. */
  zellij(): Promise<TmuxPathOutcome>
  platform: NodeJS.Platform
}

/** A zellij in a folder the core looks in for tmux without a shell. */
const installed = (env: NodeJS.ProcessEnv): string | undefined =>
  tmuxInstallDirectories(env).map((dir) => join(dir, 'zellij')).find((path) => binaryOnPath(path, env))

/** zellij as the core finds tmux (tmuxOnPath.ts binaryFinder): on this process's PATH, else where the person's login shell
 *  finds it, else in a folder the core looks in. Under launchd or systemd the master's PATH holds no Homebrew or cargo
 *  folder, where zellij is installed. None found is asked again once a zellij is on the PATH or in one of those folders. */
export function zellijFinder(env: NodeJS.ProcessEnv = process.env): () => Promise<TmuxPathOutcome> {
  return binaryFinder(async () => {
    if (binaryOnPath('zellij', env)) return { state: 'present' }
    const path = (await resolveViaLoginShell('zellij')) ?? installed(env)
    return path ? { state: 'adopted', path, from: dirname(path) } : { state: 'absent', reason: 'zellij was not found' }
  }, () => binaryOnPath('zellij', env) || installed(env) !== undefined)
}

/** One `zellij --session <session> action …` where zellij was found; nothing when none was. */
async function action(deps: ZellijDeps, session: string, args: string[]): Promise<{ code: number | null; stdout: string } | undefined> {
  const found = await deps.zellij()
  if (found.state === 'absent') return undefined
  return deps.run(found.state === 'adopted' ? found.path : 'zellij', ['--session', session, 'action', ...args], RUN_TIMEOUT_MS)
}

/** The session and the pane the hints name, each in its form. macOS and Linux only for now: Zellij on Windows is turned
 *  on with the rest of the Windows dial. */
function hinted(platform: NodeJS.Platform, hints: Readonly<Record<string, string>>): { session: string; id: string } | undefined {
  if (platform === 'win32') return undefined
  const session = hints.ZELLIJ_SESSION_NAME
  const id = hints.ZELLIJ_PANE_ID
  return session && id && SESSION_NAME.test(session) && PANE_NUMBER.test(id) ? { session, id } : undefined
}

export function createZellijAdapter(deps: ZellijDeps): HostAdapter & Required<Pick<HostAdapter, 'type' | 'canType'>> {
  // Per pane, the words being typed: two sends at once would mix in its prompt. Busy queues nothing.
  const sending = new Set<string>()

  // `write-chars` and `send-keys` exit 0 for a pane that is gone and for a plugin's, whose ids are counted apart from
  // the terminals': only the listing tells that the pane is a terminal that is there. A pane whose program exited stays
  // open, held by Zellij, and Enter there runs that program again: only a pane whose program runs takes words.
  const isTerminal = async (session: string, id: string): Promise<boolean> => {
    const listing = await action(deps, session, ['list-panes', '--json'])
    if (listing?.code !== 0) return false
    try {
      const panes: unknown = JSON.parse(listing.stdout)
      return Array.isArray(panes) && panes.some((one) => one?.id === Number(id) && one?.is_plugin === false && one?.exited === false)
    } catch {
      return false
    }
  }

  return {
    id: 'zellij',
    tap: 'before',
    paneOf(place: Place): Pane | undefined {
      const at = hinted(deps.platform, place.hints)
      if (!at) return undefined
      // herdr, Rex, tmux, a terminal or an editor started in a Zellij pane keeps its variables, and that pane shows
      // whichever of their panes is in front, or a shell that runs what is typed: only a pane Zellij's server made the
      // agent's terminal for takes words. Any other only focuses.
      return { adapter: 'zellij', id: `${place.ptyOwner === 'zellij' ? '' : HELD}${at.session}:${at.id}` }
    },
    // An agent in a Zellij pane has a zellij on this machine: whether it is found is asked at the verb, and a tap that
    // finds none brings its app forward, as tmux's does.
    canFocus: () => true,
    async focus(pane) {
      const found = ANY_PANE.exec(pane.id)
      if (!found) return false
      const [, session, id] = found
      return (await action(deps, session, ['focus-pane-id', id]))?.code === 0
    },
    canType: (pane) => OWN_PANE.test(pane.id),
    async type(pane, text) {
      const found = OWN_PANE.exec(pane.id)
      if (text === '' || text.length > MAX_TEXT || !found || sending.has(pane.id)) return false
      const [, session, id] = found
      sending.add(pane.id)
      try {
        // `--` keeps words that start with a dash from being read as flags; Enter, sent on its own, submits them.
        return await isTerminal(session, id)
          && (await action(deps, session, ['write-chars', '--pane-id', id, '--', text.replace(CONTROL, ' ')]))?.code === 0
          && (await action(deps, session, ['send-keys', '--pane-id', id, 'Enter']))?.code === 0
      } finally {
        sending.delete(pane.id)
      }
    },
  }
}

/** A process of zellij's, its server's or a client's: Linux's `ps` names it, macOS's gives its path. */
const isZellij = (p: ProcessName): boolean => p.executable === 'zellij' || p.executable.endsWith('/zellij')

export interface ZellijOuterDeps extends ZellijDeps {
  /** The terminal one process runs on (scannedApp.ts readTtyName); it rejects when it could not be read. */
  tty(pid: number): Promise<string | undefined>
  /** The machine's processes, as the open scan reads them; it rejects when the table cannot be read. */
  processes(): Promise<readonly ProcessName[]>
  log(line: string): void
  now(): number
  roots: readonly string[]
  bundleId(bundle: string): Promise<string | undefined>
}

/** The app that holds the Zellij client showing an agent's session, and that client's process. */
interface ClientPlace { app?: string; pid?: number }
/** The step of a lookup that could not be read, as its line names it: no zellij found, the process table or a terminal
 *  of the caller's, the session's clients, the client's app. */
type NotRead = 'zellij' | 'processes' | 'clients' | 'app'

/**
 * Where the person sees an agent in a pane of their own Zellij, as tmux's lookup places one in tmux (createTmuxOuter):
 * in the app that holds the client showing its session. Zellij names no client's process or tty
 * (RECORDED_ZELLIJ.listClients), so the client is read from the process table, and only when the session's one client
 * is the machine's one zellij client: of two, which is the person's is a guess, and the agent stays where its hints
 * place it. Only for a caller on a terminal a Zellij server made, as a pane's process is: a terminal started from a pane
 * is under the server too, and keeps the pane's variables. Nothing at once when the hints name no Zellij pane in form or
 * the caller is no pid; else the client's place, `{}` when none is found. Never rejects.
 */
export function createZellijOuter(deps: ZellijOuterDeps): OuterLookup {
  // By session and caller, as tmux's: a lookup in flight is shared past its 5 s, so a zellij that hangs to its timeout
  // runs no second one.
  const asked = new Map<string, { at: number; answer: Promise<ClientPlace>; settled: boolean }>()

  /** `{}` when the caller is on no terminal a Zellij server made, or the session's one client is not the machine's one
   *  or in no listed app; the step that could not be read, when one could not. */
  async function placeOf(session: string, pid: number): Promise<ClientPlace | NotRead> {
    // One read of the table serves the caller's terminal, the clients and the client's walk.
    const rows = await deps.processes().catch(() => undefined)
    if (!rows) return 'processes'
    // The table holds no terminal: the caller's and its parents' are read (scannedApp.ts readTtyName).
    const owner = await readPtyOwner(pid, rows, deps.tty).catch(() => null)
    if (owner === null) return 'processes'
    if (owner !== 'zellij') return {}
    const listed = await action(deps, session, ['list-clients'])
    if (!listed) return 'zellij'
    if (listed.code !== 0) return 'clients'
    // A server is its panes' parent, a zellij run in a pane is under its server, and this process's own runs are its
    // children: none is a client.
    const byPid = new Map(rows.map((p) => [p.pid, p]))
    const parents = new Set(rows.map((p) => p.ppid))
    const clients = rows.filter((p) => isZellij(p) && !parents.has(p.pid) && p.ppid !== process.pid
      && !parentChain(p.ppid, byPid).some(isZellij))
    const sessionClients = listed.stdout.split('\n').filter((line) => CLIENT_ROW.test(line)).length
    if (sessionClients !== 1 || clients.length !== 1) return {}
    const client = clients[0].pid
    const apps = await scannedApps([client], { platform: deps.platform, roots: deps.roots, processes: async () => rows, bundleId: deps.bundleId })
    const app = apps.get(client)
    return app ? { app, pid: client } : {}
  }

  async function lookUp(session: string, pid: number): Promise<ClientPlace> {
    // Every other step answers its own word: what is left to throw is the app scan.
    const place = await placeOf(session, pid).catch((): NotRead => 'app')
    if (typeof place === 'string') {
      deps.log(`[device] zellij client · not read · ${place}`)
      return {}
    }
    deps.log(`[device] zellij client · ${place.app ? 'found' : 'none'}`)
    return place
  }

  return (hints, pid) => {
    const session = hinted(deps.platform, hints)?.session
    if (!session || !PID.test(String(pid))) return undefined
    const now = deps.now()
    // Only sessions asked in the last 5 s, or still in flight, are kept.
    for (const [key, ask] of asked) if (ask.settled && now - ask.at >= OUTER_EVERY_MS) asked.delete(key)
    const key = `${session}:${pid}`
    const last = asked.get(key)
    if (last) return last.answer
    const ask = { at: now, answer: lookUp(session, pid), settled: false }
    void ask.answer.then(() => { ask.settled = true })
    asked.set(key, ask)
    return ask.answer
  }
}
