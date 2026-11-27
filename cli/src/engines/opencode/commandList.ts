/**
 * The `/` commands OpenCode 2 offers: its own (`/init`, `/review`, `/goal`) and those its plugins add
 * (`/notion:make-this-a-notion-page`), each with its line — `opencode api GET /api/command`, from the background server
 * every OpenCode 2 talks to. Its screen's own commands (`/models`, `/effort`) are not in it; the phone's Model sheet
 * stands for those. An OpenCode before 2 has no `api`, and lists none.
 *
 * One answer per folder, kept for [CACHE_MS]; one read in flight per folder.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { opencodeBinAsync } from '../../lib/engineBin.js'

const execFileAsync = promisify(execFile)
const CACHE_MS = 5 * 60_000
const MAX_COMMANDS = 200

export interface OpencodeListedCommand { name: string; description: string; argumentHint: string }

export interface OpencodeCommandListOptions {
  run?: (cwd: string | undefined) => Promise<string>
  now?: () => number
}

const cached = new Map<string, { at: number; commands: OpencodeListedCommand[] }>()
const reading = new Map<string, Promise<OpencodeListedCommand[] | null>>()

/** Asked for the agent's folder (`location[directory]`): a project's own commands are its, and OpenCode answers for its
 *  home otherwise, wherever it is run from (MSI, 2026-11-17). */
const runApi = async (cwd: string | undefined): Promise<string> => {
  const where = cwd ? `?location%5Bdirectory%5D=${encodeURIComponent(cwd)}` : ''
  // Run from where the daemon is: a program started in a folder that is gone never runs.
  return (await execFileAsync(await opencodeBinAsync(), ['api', 'GET', `/api/command${where}`], {
    env: process.env, timeout: 10_000, maxBuffer: 1024 * 1024,
  })).stdout
}

export function listOpencodeCommands(session: { cwd?: string | null }, options: OpencodeCommandListOptions = {}): Promise<OpencodeListedCommand[] | null> {
  const key = session.cwd ?? ''
  const now = options.now ?? Date.now
  const hit = cached.get(key)
  if (hit && now() - hit.at < CACHE_MS) return Promise.resolve(hit.commands)
  const running = reading.get(key)
  if (running) return running
  const read = (options.run ?? runApi)(session.cwd ?? undefined)
    .then((out) => parseOpencodeCommandList(out), () => null)
    .then((commands) => {
      if (commands) cached.set(key, { at: now(), commands })
      return commands
    })
    .finally(() => reading.delete(key))
  reading.set(key, read)
  return read
}

/** Test seam. */
export function resetOpencodeCommandListCache(): void {
  cached.clear()
  reading.clear()
}

/**
 * The few of its screen's own commands a chat can use, first: those the phone answers with its own Model sheet
 * (`/models`, `/effort`) and those whose effect the chat then shows. Chosen from the 50 its menu lists in OpenCode
 * 2.2.6 (MSI, 2026-11-17): the rest open a menu or a page on its screen, which waits for keys a
 * chat never sends (`/sessions`, `/themes`), or show something there alone (`/status`, `/stats`). Its own answer has
 * none of them, only the commands its config and plugins add.
 */
const SCREEN_COMMANDS: readonly OpencodeListedCommand[] = [
  { name: 'models', description: 'Switch model', argumentHint: '' },
  { name: 'effort', description: 'Switch the model\'s variant', argumentHint: '' },
  { name: 'compact', description: 'Compact the session', argumentHint: '' },
  { name: 'new', description: 'New session', argumentHint: '' },
]

/** OpenCode's rows, after [SCREEN_COMMANDS], kept to what a `/` list shows; a name nobody could type is dropped. */
export function parseOpencodeCommandList(output: string): OpencodeListedCommand[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(output) } catch { return null }
  const data = (parsed as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const commands: OpencodeListedCommand[] = [...SCREEN_COMMANDS]
  const seen = new Set(SCREEN_COMMANDS.map((c) => c.name))
  for (const row of data) {
    const { name, description } = (row ?? {}) as Record<string, unknown>
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(name) || seen.has(name)) continue
    seen.add(name)
    const line = typeof description === 'string' ? description.trim().split('\n', 1)[0]!.trim() : ''
    commands.push({ name, description: line.length <= 160 ? line : `${line.slice(0, 159).trimEnd()}…`, argumentHint: '' })
    if (commands.length >= MAX_COMMANDS) break
  }
  return commands
}
