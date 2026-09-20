import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { projectFolderSlug } from './agentNames.js'

/**
 * `harness new` — make a harness from a shell, in the words the app's box uses:
 *
 *     harness new                          claude, here
 *     harness new codex                    codex, here
 *     harness new codex @mini ~/code/auth  codex, on mini, in that folder
 *     harness new codex my-game            codex, in a new project ~/harnesses/my-game
 *     harness new --new                    a new project named after the agent and the time
 *
 * A new terminal tab asks nothing and opens where you were; so does this. With no folder named it
 * works in the directory it was run from, which is what `cd repo && harness new` means to anyone who
 * has typed `code .` — and the one thing the app's box cannot know. The order of the words is free:
 * `@` marks the machine, a path looks like a path, the first other word is the agent and the second
 * names a new project.
 */
export interface NewArgs {
  agent: string
  /** A machine's label or id as typed after `@`, or null for this one. */
  machine: string | null
  /** The folder to work in, absolute; null when a new project is asked for instead. */
  cwd: string | null
  /** A new project: its name, or '' to let the clock name it; null when `cwd` is given. */
  projectName: string | null
  mode: string
  prompt: string | null
  name: string | null
  json: boolean
}

export class NewUsageError extends Error {}
/** `-h` / `--help`: not a mistake, so not exit code 2 and not on stderr. */
export class NewHelpRequested extends Error {}

export const NEW_USAGE = [
  'Usage: harness new [agent] [@machine] [folder | project-name] [options]',
  '',
  '  agent          claude (default), codex, opencode, …, or a store harness like owner/name',
  '  @machine       a machine\'s name or id; this one when left out',
  '  folder         a path (/abs, ~/x, ./x, .): work there. Left out: the current directory.',
  '                 With @machine, a path under THIS home is read as the same path under its home,',
  '                 because the shell has already turned ~/x into /Users/you/x by the time it gets here',
  '  project-name   any other second word: a new project ~/harnesses/<name> on that machine',
  '',
  '  --new [name]   a new project, named <name> or after the agent and the time',
  '  --mode <mode>  auto (default), ask, plan or full, where the agent has it',
  '  --plan         the same as --mode plan',
  '  --task <t>     the first message, sent as the harness starts (--prompt is the same)',
  '  -- <words…>    everything after -- is the first message, unquoted:',
  '                   harness new codex -- fix the flaky login test',
  '  --name <n>     the harness\'s name until the agent titles its session',
  '  --json         print the result as one JSON line',
].join('\n')

const MODES = new Set(['auto', 'ask', 'plan', 'full'])
const looksLikePath = (word: string): boolean =>
  word === '.' || word === '..' || word === '~' || /^(\/|~\/|\.\/|\.\.\/)/.test(word)

export function parseNewArgs(argv: string[], env: { cwd: string; home: string }): NewArgs {
  const words: string[] = []
  let machine: string | null = null
  let folder: string | null = null
  let projectName: string | null = null
  let mode = 'auto'
  let prompt: string | null = null
  let name: string | null = null
  let json = false
  const value = (flag: string, index: number): string => {
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new NewUsageError(`${flag} needs a value.`)
    return next
  }
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '-h' || word === '--help') throw new NewHelpRequested()
    if (word === '--') {
      // The rest is the task, as typed: no quoting to get wrong in a shell.
      const rest = argv.slice(i + 1).join(' ').trim()
      if (rest) prompt = rest
      break
    }
    if (word === '--json') json = true
    else if (word === '--plan') mode = 'plan'
    else if (word === '--mode') { mode = value(word, i); i++ }
    else if (word === '--prompt' || word === '--task') { prompt = value(word, i); i++ }
    else if (word === '--name') { name = value(word, i); i++ }
    else if (word === '--new') {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-') && !next.startsWith('@') && !looksLikePath(next)) { projectName = next; i++ }
      else projectName = ''
    }
    // Any dash: `-x` read as an agent called "-x" turns a typo into a confusing refusal from the machine.
    else if (word.startsWith('-')) throw new NewUsageError(`Unknown option ${word}.`)
    else if (word.startsWith('@')) {
      if (word.length === 1) throw new NewUsageError('Name a machine after @.')
      if (machine !== null) throw new NewUsageError('Name one machine.')
      machine = word.slice(1)
    }
    else if (looksLikePath(word)) {
      if (folder !== null) throw new NewUsageError('Name one folder.')
      folder = word
    }
    else words.push(word)
  }
  if (!MODES.has(mode)) throw new NewUsageError(`--mode is one of ${[...MODES].join(', ')}.`)
  if (words.length > 2) throw new NewUsageError(`Too many words: ${words.slice(2).join(' ')}.`)
  if (words[1] !== undefined) {
    if (projectName !== null && projectName !== '') throw new NewUsageError('Name the new project once.')
    projectName = words[1]
  }
  if (folder !== null && projectName !== null) throw new NewUsageError('Name a folder or a new project, not both.')
  if (projectName !== null && projectName !== '' && projectFolderSlug(projectName) === null) {
    throw new NewUsageError(`“${projectName}” leaves no usable folder name.`)
  }
  let cwd: string | null = null
  if (folder !== null) {
    // `~` is this machine's home only when this machine is the target; for another machine it is
    // resolved there (resolveRemoteHome), so it is kept as typed until then.
    cwd = folder === '~' || folder.startsWith('~/')
      ? (machine === null ? join(env.home, folder.slice(2)) : folder)
      // An unquoted ~/x reaches us as /Users/you/x: the shell expanded it against THIS machine. For
      // another machine that path means nothing, and what was typed was its home — so give it back.
      : machine !== null && (folder === env.home || folder.startsWith(`${env.home}/`)) ? `~${folder.slice(env.home.length)}`
      : isAbsolute(folder) ? folder
      : machine === null ? resolve(env.cwd, folder)
      : (() => { throw new NewUsageError('A folder on another machine is an absolute path or starts with ~/.') })()
  } else if (projectName === null) {
    // Nothing named: here, on this machine — and a new project on another, where "here" means nothing.
    if (machine === null) cwd = env.cwd
    else projectName = ''
  }
  return { agent: words[0] ?? 'claude', machine, cwd, projectName, mode, prompt, name, json }
}

/** The `agent_create` payload for [args]: the same fields the app's box sends. [baseEngine] is the
 *  engine a store harness runs on, read from the machine's catalog; the machine refuses a pair that
 *  disagrees (`INVALID_DSH`). */
export function newAgentPayload(args: NewArgs, cwd: string | null, baseEngine = 'claude'): Record<string, unknown> {
  const harness = args.agent.includes('/') ? args.agent : null
  const terminal = args.agent === 'terminal'
  return {
    engine: harness ? baseEngine : args.agent,
    ...(harness ? { dsh: harness } : {}),
    ...(cwd !== null ? { cwd } : terminal ? {} : {
      projectSource: 'new',
      ...(args.projectName ? { projectName: projectFolderSlug(args.projectName) } : {}),
    }),
    bypassPermission: !terminal && (args.mode === 'auto' || args.mode === 'full'),
    ...(terminal ? {} : { permissionMode: args.mode }),
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.name ? { name: args.name } : {}),
    creationId: randomUUID(),
  }
}

export interface NewMachine { machineId: string; label: string; status: string; current: boolean }

/** The machine `@word` means: an exact id, else a label, case-blind; ambiguity is an error, not a guess. */
export function resolveNewMachine(word: string, machines: NewMachine[]): NewMachine {
  const byId = machines.find((machine) => machine.machineId === word)
  if (byId) return byId
  const wanted = word.toLowerCase()
  // The whole name, else its start, else a word in it: `@mini` is "Mac mini" to the person typing.
  const tiers = [
    (label: string) => label === wanted,
    (label: string) => label.startsWith(wanted),
    (label: string) => label.split(/[\s._-]+/).some((part) => part.startsWith(wanted)),
  ]
  let matches: NewMachine[] = []
  for (const tier of tiers) {
    matches = machines.filter((machine) => tier(machine.label.toLowerCase()))
    if (matches.length > 0) break
  }
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) {
    throw new NewUsageError(`No machine called “${word}”. Yours: ${machines.map((machine) => machine.label).join(', ') || 'none'}.`)
  }
  throw new NewUsageError(`“${word}” could be ${matches.map((machine) => machine.label).join(' or ')}. Type more of the name.`)
}

/** The least of a WebSocket this needs, so a test can hand in a fake. */
export interface NewSocket {
  send(data: string): void
  close(): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: { toString(): string }) => void): unknown
  on(event: 'close', listener: (code: number, reason: { toString(): string }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface NewCommandDeps {
  argv: string[]
  cwd: string
  home: string
  port: number
  localMachineId: string | null
  daemonRunning: () => boolean | Promise<boolean>
  listMachines: () => Promise<NewMachine[]>
  connect: (url: string) => NewSocket
  output: (line: string) => void
  error: (line: string) => void
  timeoutMs?: number
}

const ERRORS: Record<string, string> = {
  INVALID_CWD: 'That folder does not exist on the machine.',
  INVALID_ENGINE: 'That agent is not one this machine knows.',
  INVALID_DSH: 'That harness is not in the machine\'s catalog, or does not run on that engine.',
  PROJECT_EXISTS: 'A project with that name already exists. Name its folder instead.',
  PROMPT_UNSUPPORTED: 'That agent cannot be started with a first message.',
  SPAWN_FAILED: 'The agent could not be started.',
}

/** One loopback session with the daemon: select the machine, then ask, one request at a time. */
function daemonSession(deps: NewCommandDeps, machineId: string): Promise<{
  request: (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  close: () => void
}> {
  return new Promise((resolveSession, rejectSession) => {
    const socket = deps.connect(`ws://127.0.0.1:${deps.port}/api/local-ws`)
    const waiting = new Map<string, { done: (payload: Record<string, unknown>) => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>()
    let ready = false
    const failAll = (error: Error): void => {
      for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.fail(error) }
      waiting.clear()
      if (!ready) rejectSession(error)
    }
    socket.on('open', () => socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } })))
    socket.on('error', (error) => failAll(error))
    socket.on('close', (code, reason) => failAll(new Error(
      code === 4404 ? 'That machine is not linked to this one yet. Run `harness link` first.'
        : `The connection to Harness closed (${code}${reason.toString() ? `: ${reason.toString()}` : ''}).`)))
    socket.on('message', (data) => {
      let frame: { type?: string; payload?: Record<string, unknown> }
      try { frame = JSON.parse(data.toString()) } catch { return }
      if (!ready && frame.type === 'connected') {
        ready = true
        resolveSession({
          close: () => socket.close(),
          request: (type, payload) => new Promise((done, fail) => {
            const requestId = randomUUID()
            const timer = setTimeout(() => { waiting.delete(requestId); fail(new Error(`Harness did not answer ${type} in time.`)) }, deps.timeoutMs ?? 90_000)
            waiting.set(requestId, { done, fail, timer })
            socket.send(JSON.stringify({ type, payload: { ...payload, requestId } }))
          }),
        })
        return
      }
      const requestId = frame.payload?.requestId
      const entry = typeof requestId === 'string' ? waiting.get(requestId) : undefined
      if (!entry || !frame.payload) return
      waiting.delete(requestId as string)
      clearTimeout(entry.timer)
      if (frame.payload.error != null) {
        const code = String(frame.payload.error)
        const detail = typeof frame.payload.detail === 'string' && frame.payload.detail ? ` (${frame.payload.detail})` : ''
        entry.fail(new Error(`${ERRORS[code] ?? code}${detail}`))
      } else entry.done(frame.payload)
    })
  })
}

export async function newCommand(deps: NewCommandDeps): Promise<number> {
  let args: NewArgs
  try { args = parseNewArgs(deps.argv, { cwd: deps.cwd, home: deps.home }) }
  catch (error) {
    if (error instanceof NewHelpRequested) { deps.output(NEW_USAGE); return 0 }
    if (!(error instanceof NewUsageError)) throw error
    deps.error(error.message)
    deps.error('')
    deps.error(NEW_USAGE)
    return 2
  }
  if (!(await deps.daemonRunning())) {
    deps.error('Harness is not running on this computer. Start it with `harness start`.')
    return 1
  }
  try {
    let machineId = deps.localMachineId
    let machineLabel = 'this computer'
    if (args.machine !== null) {
      const machine = resolveNewMachine(args.machine, await deps.listMachines())
      machineId = machine.machineId
      machineLabel = machine.current ? 'this computer' : machine.label
    }
    if (!machineId) {
      deps.error('This computer is not signed in to Harness. Run `harness login`.')
      return 1
    }
    const session = await daemonSession(deps, machineId)
    try {
      let cwd = args.cwd
      if (cwd !== null && (cwd === '~' || cwd.startsWith('~/'))) {
        // Another machine's home: ask it. `fs_list_dir` with no path answers with the home it listed.
        const home = (await session.request('fs_list_dir', {})).path
        if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('That machine did not say where its home folder is.')
        cwd = join(home, cwd.slice(2))
      }
      let baseEngine = 'claude'
      if (args.agent.includes('/')) {
        // A store harness: the machine's catalog says what it runs on and whether it is there yet.
        const catalog = (await session.request('dsh_list', {})).dsh
        const entry = Array.isArray(catalog)
          ? catalog.find((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && (row as Record<string, unknown>).id === args.agent)
          : undefined
        if (!entry) throw new Error(`No harness called “${args.agent}” in that machine's catalog. See \`harness dsh list\`.`)
        if (entry.installed === false) throw new Error(`Install it first: harness dsh install ${args.agent}`)
        if (typeof entry.engine === 'string' && entry.engine) baseEngine = entry.engine
      }
      const result = await session.request('agent_create', newAgentPayload(args, cwd, baseEngine))
      const agent = (result.agent ?? {}) as Record<string, unknown>
      if (args.json) deps.output(JSON.stringify({ ok: true, machineId, agent }))
      else {
        const where = typeof agent.cwd === 'string' ? ` in ${agent.cwd}` : cwd ? ` in ${cwd}` : ''
        deps.output(`Created ${String(agent.name ?? agent.id ?? 'a harness')} on ${machineLabel}${where}.`)
        deps.output('Open it in Harness with ⌘O.')
      }
      return 0
    } finally { session.close() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (args.json) deps.output(JSON.stringify({ ok: false, error: message }))
    else deps.error(message)
    return error instanceof NewUsageError ? 2 : 1
  }
}
