/**
 * Window names (`window_name`): a window of the apps named for the repo its harnesses work in and the
 * work they do — `Harness TUI LMStudio` — by a small model, in the background
 * (docs/plans/2026-10-07-002-window-auto-rename-daemon-plan.md). The pane names stay as they are; this is
 * the window's name alone, and an app asks for it only while its own Auto rename switch is on.
 *
 * An app sends the agent ids of one window's panes on this machine, in pane order. Only harnesses inside a
 * git repo with a title of their own count (not a shell, not a folder without git, not one still called
 * `Claude harness 10-7 14:02`), those of the repo most of them are in. A window
 * with none, or no model to ask, is answered `{ name: null }`: the app keeps the name it has. A name not
 * known yet is answered `pending` at once and asked of the model behind the request, one window at a time
 * — never in the request's line. Names are kept in `window-names.json` by the window's headings, so every
 * app asking for the same window gets the same name, and a window's titles changing asks again.
 *
 * The model is never named here: OpenCode's free models as `opencode models` lists them now, else the
 * window's own engines with their small model (Claude's `haiku`, Codex at low effort).
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { parseOpencodeModelsOutput } from '../engines/opencode/runtimeProfile.js'
import { isTerminalEngine } from '../engines/types.js'
import { isAutomaticName } from '../lib/agentNames.js'
import type { OneShotEngine } from '../lib/disposableOneShotPool.js'
import { opencodeBin } from '../lib/engineBin.js'
import { runRouterOneShot } from '../lib/oneshot.js'
import { describeScmProject } from '../scm/scmProjects.js'
import { internalOnThrow } from './requestErrors.js'

/** The requests the window names answer for the apps, declared in core/api.ts for the core to route. */
export { WINDOW_NAMES_REQUESTS } from '../core/api.js'

/** What the model is asked, the window's panes' headings after it (`title    repo ⎇ branch`). */
export const PROMPT = 'Name a terminal window in AT MOST 4 plain words so that someone reading it knows the work going on in it. '
  + 'Word 1: the repo name as one short word (autonomous-harness -> Harness). Then ONE keyword per piece of work (the product or part it '
  + 'touches, like TUI or LMStudio). No symbols, no punctuation, no "and", no quotes. Reply with ONLY the name.\n\n'
  + 'The window\'s panes, as their headings show them (title, then repo and branch):'

/** A window's key not named (no model answered a name) is asked again after this long. */
export const RETRY_MS = 10 * 60_000
/** What a model has to answer in; past it the next one is asked, whatever the model's own process does
 *  (a one-shot whose process has already exited waits out its own timeout: lib/oneshot.ts). */
export const BUDGET_MS = 45_000
/** The names kept (the oldest go first). */
export const KEEP = 400
/** The agents of one window read, at most (a window holds nine panes). */
const MAX_AGENTS = 16
/** OpenCode's free models tried for one window, at most. */
const MAX_FREE = 3

/** What a window's name is asked from: [key], its repo's harnesses' headings, and the engines they run. */
export interface WindowAsk { key: string; prompt: string; engines: string[] }
/** A small model to ask: an engine, and a model and effort where the engine needs one named. */
export interface Namer { engine: OneShotEngine; model?: string; effort?: 'low' }

type Project = { kind: string; name: string; root: string | null; remote: string | null; branch: string | null }

export interface WindowNamesDeps {
  /** What repo a folder is in (scm/scmProjects.ts). */
  describe?: (cwd: string | null | undefined) => Promise<Project | null>
  /** The small models to try for a window whose harnesses run [engines], in order. */
  namers?: (engines: string[]) => Promise<Namer[]>
  /** One model's answer to [prompt], in a scratch folder [cwd]; throws when it fails. */
  ask?: (namer: Namer, prompt: string, cwd: string) => Promise<string>
  now?: () => number
}

/**
 * The ask for a window whose panes run agents [ids] (pane order): its harnesses inside a git repo (not a
 * shell), each once, of the repo most of them are in (a tie: the first in pane order). Null when none is.
 * A repo is known by its remote, else its name — never its folder: a linked worktree has a root of its own
 * (`gentle-walrus` for an autonomous-harness branch), and is the same repo.
 */
export async function windowAsk(core: Pick<CoreApi, 'agents'>, ids: readonly string[], describe: NonNullable<WindowNamesDeps['describe']>): Promise<WindowAsk | null> {
  const panes: Array<{ repo: string; name: string; line: string; engine: string }> = []
  for (const id of new Set(ids)) {
    const session = core.agents.byAgent(id)
    if (!session || isTerminalEngine(session.engine)) continue
    // A harness with no title yet (`OpenCode harness 10-7 16:45`, `harness-3`) says nothing of its work:
    // shown one, a model named an xiaozhi-esp32 window "Harness TUI Autoname" from the prompt's example.
    // Pi's own title before it has one, `π - autonomous-harness`, is the folder alone: no title either.
    const title = core.agents.displayName(session).trim()
    if (!title || isAutomaticName(title) || (session.cwd && title === `π - ${basename(session.cwd)}`)) continue
    const project = await describe(session.cwd).catch(() => null)
    if (!project || project.kind !== 'git' || !project.branch) continue
    panes.push({ repo: project.remote ?? project.name, name: project.name, line: `${title}    ${project.name} ⎇ ${project.branch}`, engine: session.engine })
  }
  const counts = new Map<string, number>()
  for (const pane of panes) counts.set(pane.repo, (counts.get(pane.repo) ?? 0) + 1)
  let repo: string | null = null
  for (const [candidate, n] of counts) if (repo === null || n > counts.get(repo)!) repo = candidate
  if (repo === null) return null
  const mine = panes.filter((pane) => pane.repo === repo)
  const key = [mine[0].name, ...mine.map((pane) => pane.line).sort()].join('\n')
  const prompt = `${PROMPT}\n${mine.map((pane) => `- ${pane.line}`).join('\n')}`
  return { key, prompt, engines: [...new Set(mine.map((pane) => pane.engine))] }
}

/**
 * A model's answer as a window name: its last line (a banner and blank lines left out), one to four words
 * of letters and digits. Null for anything else, and the window keeps its name.
 */
export function cleanName(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('>'))
  const line = lines.at(-1)
  if (!line) return null
  const name = line.replace(/^["'`.*]+|["'`.*]+$/g, '').trim()
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 4 || [...name].length > 40) return null
  if (!/^[\p{L}\p{N}\s]+$/u.test(name)) return null
  return words.join(' ')
}

const run = promisify(execFile)

/**
 * The small models for a window whose harnesses run [engines]: OpenCode's free models as it lists them now
 * (none named here; OpenCode not installed, none), then each of the window's engines that can answer once,
 * with its small model — Claude's `haiku`, Codex at low effort, the others as they are set.
 */
export async function defaultNamers(engines: readonly string[], list: () => Promise<string> = async () => (await run(opencodeBin(), ['models'], { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout): Promise<Namer[]> {
  const free = await list().then((out) => parseOpencodeModelsOutput(out).map((m) => m.id).filter((id) => /-free$/.test(id)), () => [])
  const own: Namer[] = engines.flatMap((engine): Namer[] => engine === 'claude' ? [{ engine: 'claude', model: 'haiku', effort: 'low' }]
    : engine === 'codex' ? [{ engine: 'codex', effort: 'low' }]
    : engine === 'opencode' || engine === 'pi' || engine === 'cursor' || engine === 'commandcode' || engine === 'kilo' ? [{ engine }]
    : [])
  return [...free.slice(0, MAX_FREE).map((model): Namer => ({ engine: 'opencode', model })), ...own]
}

/** One model's answer, cold: a window is named once, so no worker is kept warm for it. */
async function askOnce(namer: Namer, prompt: string, cwd: string): Promise<string> {
  const { text } = await runRouterOneShot(namer.engine, { prompt, cwd, model: namer.model, effort: namer.effort, timeoutMs: BUDGET_MS })
  return text
}

export function startWindowNames(core: CoreApi, deps: WindowNamesDeps = {}): ServiceRequests {
  const describe = deps.describe ?? describeScmProject
  const namers = deps.namers ?? ((engines: string[]) => defaultNamers(engines))
  const ask = deps.ask ?? askOnce
  const now = deps.now ?? Date.now
  const file = join(core.dataDir, 'window-names.json')
  const scratch = join(core.dataDir, 'window-names-scratch')
  const names = new Map<string, string>()
  const failed = new Map<string, number>()
  let naming: string | null = null

  try {
    const rows: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(rows)) for (const row of rows) if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string') names.set(row[0], row[1])
  } catch { /* none kept yet */ }

  const keep = (key: string, name: string): void => {
    names.delete(key)
    names.set(key, name)
    for (const old of names.keys()) { if (names.size <= KEEP) break; names.delete(old) }
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify([...names]))
      renameSync(`${file}.tmp`, file)
    } catch (error) { console.error('[window-names] could not keep the names:', String(error)) }
  }

  /** The first valid name a small model gives the window; null when none does. */
  const nameOf = async (window: WindowAsk): Promise<string | null> => {
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    for (const namer of await namers(window.engines)) {
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer in time')), BUDGET_MS) })
      const name = await Promise.race([ask(namer, window.prompt, scratch), late]).then(cleanName, () => null).finally(() => clearTimeout(timer))
      if (name) return name
    }
    return null
  }

  return {
    window_name: internalOnThrow('window_name', async (payload) => {
      const ids = Array.isArray(payload.agentIds) ? payload.agentIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_AGENTS) : []
      const window = await windowAsk(core, ids, describe)
      if (!window) return { name: null }
      const known = names.get(window.key)
      if (known) return { name: known }
      if (naming !== null) return { name: null, pending: true }
      const at = failed.get(window.key)
      if (at !== undefined && now() - at < RETRY_MS) return { name: null }
      naming = window.key
      void nameOf(window).then((name) => {
        if (name) keep(window.key, name)
        else failed.set(window.key, now())
      }, () => { failed.set(window.key, now()) }).finally(() => { naming = null })
      return { name: null, pending: true }
    }),
  }
}
