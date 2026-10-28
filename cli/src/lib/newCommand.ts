import { randomUUID } from 'node:crypto'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path'
import { addressOf, atMachineRefusal, EXIT, machineOption, refusalNext, REFUSED_CODES, step, VIA_MCP_ENV } from '../agentClient/commands.js'
import { AgentClientError } from '../agentClient/daemon.js'
import { formatNext, type NextStep } from '../agentClient/next.js'
import { folderTrust } from '../engines/launchPrep.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { engineName } from '../messages/model.js'
import { cloudRequestRefusal, isCloudAgent } from './cloudAgents.js'
import { projectFolderSlug } from './agentNames.js'
import { permissionModeFlags } from './engineLaunch.js'
import { projectsRoot } from './projectFolder.js'
import { NOT_RUNNING, SANDBOXED, refused } from './unreachable.js'

/** Engine names, so an unknown word is judged rather than cast (the shape `registry.ts` uses). */
const ENGINE_NAMES: ReadonlySet<string> = new Set(ENGINES)

/**
 * `harness new` — make a harness from a shell, in the words the app's box uses:
 *
 *     harness new                          claude, here
 *     harness new codex                    codex, here
 *     harness new codex --machine mini ~/code/auth  codex, on mini, in that folder
 *     harness new codex my-game                     codex, in a new project ~/harnesses/my-game
 *     harness new --new                             a new project named after the agent and the time
 *
 * A new terminal tab asks nothing and opens where you were; so does this. With no folder named it
 * works in the directory it was run from, which is what `cd repo && harness new` means to anyone who
 * has typed `code .` — and the one thing the app's box cannot know. The order of the words is free:
 * `--machine` names the machine, a path looks like a path, the first other word is the agent and the
 * second names a new project.
 */
export interface NewArgs {
  agent: string
  /** A machine's label or id as given to `--machine`, or null for this one. */
  machine: string | null
  /** The folder to work in, absolute; null when a new project is asked for instead. */
  cwd: string | null
  /** A new project: its name, or '' to let the clock name it; null when `cwd` is given. */
  projectName: string | null
  mode: string
  /** True when `--mode`/`--plan` was typed by the person. The default `auto` is not a request: see
   *  [newAgentPayload]. */
  modeGiven: boolean
  prompt: string | null
  name: string | null
  /** A cloud coding agent's GitHub repository, `owner/name` or its address, as typed: the machine reads it. */
  repo: string | null
  /** Devin Cloud's ACU limit. */
  acuLimit: number | null
  /** The model to launch with, as the engine names it (`haiku`, `gpt-5.4-mini`); the machine checks it (lib/launchModel.ts). */
  model: string | null
  json: boolean
}

export class NewUsageError extends Error {}
/** `-h` / `--help`: not a mistake, so not exit code 2 and not on stderr. */
export class NewHelpRequested extends Error {}

export const NEW_USAGE = [
  'Usage: harness new [agent] [--machine <name>] [folder | project-name] [options]',
  '',
  '  agent          claude (default), codex, opencode, …, or a store harness like owner/name',
  '  --machine <m>  a machine\'s name or id; this one when left out',
  '  folder         a path (/abs, ~/x, ./x, .): work there. Left out: the current directory.',
  '                 With --machine, a path under THIS home is read as the same path under its home,',
  '                 because the shell has already turned ~/x into /Users/you/x by the time it gets here',
  '  project-name   any other second word: a new project ~/harnesses/<name> on that machine.',
  '                 For scratch or new work give one (harness new codex review -- …), not a folder',
  '                 of your own: Claude Code and Codex ask the person to trust a folder Harness did not make',
  '',
  '  --new [name]   a new project, named <name> or after the agent and the time',
  '  --mode <mode>  auto (default), ask, plan or full, where the agent has it',
  '  --plan         the same as --mode plan',
  '  --task <t>     the first message, sent as the harness starts (--prompt is the same)',
  '  -- <words…>    everything after -- is the first message, unquoted:',
  '                   harness new codex -- fix the flaky login test',
  '  --name <n>     the harness\'s name until the agent titles its session',
  '  --model <m>    the model it launches with, as the agent names it: haiku, opus, gpt-5.4-mini',
  '  --repo <r>    a cloud coding agent\'s GitHub repository: owner/name or https://github.com/owner/name',
  '                 (Cursor Cloud needs one; Devin Cloud works without)',
  '  --acu-limit <n>  the most ACUs Devin Cloud may spend (1-1000; 5 when left out)',
  '  --json         print the result as one JSON line',
  '',
  'An agent refused (its limits, or the person has not let agents start agents) exits 5: do not retry.',
].join('\n')

const MODES = new Set(['auto', 'ask', 'plan', 'full'])
/** On Windows also `C:\x`, `C:/x`, `\\server\share`, `.\x`, `..\x` and `~\x`: the paths PowerShell and cmd.exe hand over.
 *  Read as a project name, `harness new terminal C:\Users\me\proj` was refused ("a terminal … does not make a project")
 *  and `harness new codex C:\code\api` made ~\harnesses\<slug> instead (the Windows install job, B5.12, on the VM). */
const looksLikePath = (word: string, windows: boolean): boolean =>
  word === '.' || word === '..' || word === '~' || /^(\/|~\/|\.\/|\.\.\/)/.test(word)
  || (windows && /^([A-Za-z]:[\\/]|\\\\|~\\|\.\\|\.\.\\)/.test(word))

export function parseNewArgs(argv: string[], env: { cwd: string; home: string; platform?: NodeJS.Platform }): NewArgs {
  const windows = (env.platform ?? process.platform) === 'win32'
  const path = windows ? win32 : posix
  const words: string[] = []
  let machine: string | null = null
  let folder: string | null = null
  let projectName: string | null = null
  let mode = 'auto'
  let modeGiven = false
  let prompt: string | null = null
  let name: string | null = null
  let repo: string | null = null
  let acuLimit: number | null = null
  let model: string | null = null
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
    else if (word === '--plan') { mode = 'plan'; modeGiven = true }
    else if (word === '--mode') { mode = value(word, i); modeGiven = true; i++ }
    else if (word === '--prompt' || word === '--task') { prompt = value(word, i); i++ }
    else if (word === '--name') { name = value(word, i); i++ }
    // The app's New Harness box sends a model the same way; `harness new` had no word for it, so an agent asked to
    // get "another model's view" could start only the engine's default model.
    else if (word === '--model') {
      model = value(word, i).trim()
      if (!model) throw new NewUsageError('--model needs a value.')
      i++
    }
    else if (word === '--repo') {
      repo = value(word, i).trim()
      if (!repo) throw new NewUsageError('--repo needs a value.')
      i++
    }
    else if (word === '--acu-limit') {
      acuLimit = Number(value(word, i))
      if (!Number.isInteger(acuLimit) || acuLimit < 1 || acuLimit > 1000) throw new NewUsageError('--acu-limit takes a whole number from 1 to 1000.')
      i++
    }
    else if (word === '--machine') {
      if (machine !== null) throw new NewUsageError('Name one machine.')
      machine = value(word, i).trim()
      if (!machine) throw new NewUsageError('--machine needs a value.')
      i++
    }
    else if (word === '--new') {
      // `--new @office`: the old machine word is refused below, never taken for the project's name.
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-') && !next.startsWith('@') && !looksLikePath(next, windows)) { projectName = next; i++ }
      else projectName = ''
    }
    // Any dash: `-x` read as an agent called "-x" turns a typo into a confusing refusal from the machine.
    else if (word.startsWith('-')) throw new NewUsageError(`Unknown option ${word}.`)
    // `@office` named the machine until every command took `--machine`. Taken as a word now, it would quietly be a new
    // project called "@office" on this machine: refused, with what to type instead.
    else if (word.startsWith('@')) throw new NewUsageError(atMachineRefusal(word))
    else if (looksLikePath(word, windows)) {
      if (folder !== null) throw new NewUsageError('Name one folder.')
      folder = word
    }
    else words.push(word)
  }
  if ((repo !== null || acuLimit !== null) && !isCloudAgent(words[0])) {
    throw new NewUsageError(`${repo !== null ? '--repo' : '--acu-limit'} is for a cloud agent: harness new devin-cloud ${repo !== null ? '--repo owner/name' : '--acu-limit 10'} -- <task>`)
  }
  // What the cloud service would refuse, refused before anything is sent, in its words.
  const cloudRefusal = isCloudAgent(words[0]) ? cloudRequestRefusal(words[0], prompt ?? '', [repo]) : null
  if (cloudRefusal) throw new NewUsageError(cloudRefusal)
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
  // A terminal opens in a folder and never makes one (the machine's INVALID_PROJECT_SOURCE), so the project was left
  // out of what is sent: `harness new terminal my-game` opened a terminal in the home folder, with no ~/harnesses/my-game
  // and no word about it (CLI 0.3.76, 2026-10-12).
  if (words[0] === 'terminal' && model !== null) throw new NewUsageError('A terminal runs no model: --model is for an agent.')
  if (words[0] === 'terminal' && projectName !== null) {
    throw new NewUsageError('A terminal opens in a folder; it does not make a project. Name a folder (harness new terminal ~/code/x), or none to open it here.')
  }
  let cwd: string | null = null
  if (folder !== null) {
    // `~` is this machine's home only when this machine is the target; for another machine it is
    // resolved there (resolveRemoteHome), so it is kept as typed until then.
    // Another machine reads `~\x` typed on Windows as its own `~/x`: it may not be Windows, and the home is resolved there.
    const home = (rest: string) => `~${windows ? rest.replace(/\\/g, '/') : rest}`
    cwd = folder === '~' || folder.startsWith('~/') || (windows && folder.startsWith('~\\'))
      ? (machine === null ? path.join(env.home, folder.slice(2)) : home(folder.slice(1)))
      // An unquoted ~/x reaches us as /Users/you/x: the shell expanded it against THIS machine. For
      // another machine that path means nothing, and what was typed was its home — so give it back.
      : machine !== null && (folder === env.home || folder.startsWith(`${env.home}${path.sep}`) || folder.startsWith(`${env.home}/`)) ? home(folder.slice(env.home.length))
      : path.isAbsolute(folder) ? folder
      : machine === null ? path.resolve(env.cwd, folder)
      : (() => { throw new NewUsageError('A folder on another machine is an absolute path or starts with ~/.') })()
  } else if (projectName === null) {
    // Nothing named: here, on this machine — and a new project on another, where "here" means nothing.
    if (machine === null) cwd = env.cwd
    else projectName = ''
  }
  return { agent: words[0] ?? 'claude', machine, cwd, projectName, mode, modeGiven, prompt, name, repo, acuLimit, model, json }
}

/** The `agent_create` payload for [args]: the same fields the app's box sends. [baseEngine] is the
 *  engine a store harness runs on, read from the machine's catalog; the machine refuses a pair that
 *  disagrees (`INVALID_DSH`). */
export function newAgentPayload(args: NewArgs, cwd: string | null, baseEngine = 'claude'): Record<string, unknown> {
  const harness = args.agent.includes('/') ? args.agent : null
  const terminal = args.agent === 'terminal'
  const engine = harness ? baseEngine : args.agent
  // A mode is only an engine's to take. The usage says `--mode` applies "where the agent has it", but
  // the default `auto` went to every engine, and the daemon refuses a mode an engine has no
  // `PERMISSION_MODES` row for (`INVALID_PERMISSION_MODE` in backendSocket.ts) — so the ten engines
  // without a row (hermes, pi, amp, muse, kilo, grok, devin, commandcode, agy, copilot) could not be
  // created from the CLI at all, and neither could a store harness running on one of them.
  // An unasked-for default is therefore left out: the engine opens in its own default mode. A mode the
  // person typed is still sent, so the daemon's refusal — "refused rather than quietly launched in
  // some other mode" — stays the answer where a choice was actually made.
  const hasMode = ENGINE_NAMES.has(engine) && permissionModeFlags(engine as AgentEngine, args.mode) !== null
  const mode = args.modeGiven || hasMode ? args.mode : null
  // A row that keeps claiming Auto while running without the flag is the more expensive lie, so the
  // bypass is only claimed where the engine really has the mode it was asked for.
  const approves = mode !== null && (mode === 'auto' || mode === 'full') && hasMode
  return {
    engine,
    ...(harness ? { dsh: harness } : {}),
    ...(cwd !== null ? { cwd } : terminal ? {} : {
      projectSource: 'new',
      ...(args.projectName ? { projectName: projectFolderSlug(args.projectName) } : {}),
    }),
    bypassPermission: !terminal && approves,
    ...(terminal || mode === null ? {} : { permissionMode: mode }),
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.name ? { name: args.name } : {}),
    ...(args.repo ? { repositoryUrl: args.repo } : {}),
    ...(args.acuLimit !== null ? { acuLimit: args.acuLimit } : {}),
    ...(args.model !== null ? { model: args.model } : {}),
    creationId: randomUUID(),
  }
}

export interface NewMachine {
  machineId: string; label: string; status: string; current: boolean
  /** Another account's machine shared with this one: whose it is. */
  sharedBy?: string
  /** Shared with everyone at the account's domain and not added yet: named only to say how to add it. */
  toAdd?: true
}

/** One row of `GET /api/machines`, as far as `--machine` reads it; a shared one carries its `share`. */
export interface MachineRow {
  machineId: string
  name?: string | null
  hostname?: string | null
  status?: string | null
  share?: { ownerName?: string | null; added?: boolean | null } | null
}

/** The machines `--machine` resolves among: the account's own, then those other accounts share with it that it
 *  may use — named in the share, or added from one at its domain (`share.added`, as the backend decides). A domain
 *  share not added yet is listed as `toAdd`: its machine refuses this account until it is added
 *  (backend lib/machineAccess.ts `sharedMachineAccess`), so it is never chosen, only named. */
export function machineChoices(data: { machines?: MachineRow[]; sharedMachines?: MachineRow[] }, currentId: string | null): NewMachine[] {
  const label = (machine: MachineRow): string => machine.name?.trim() || machine.hostname?.trim() || '(unnamed)'
  const choice = (machine: MachineRow): NewMachine => ({
    machineId: machine.machineId, label: label(machine), status: machine.status || 'unknown', current: machine.machineId === currentId,
  })
  return [
    ...(data.machines ?? []).map(choice),
    ...(data.sharedMachines ?? []).map((machine) => ({
      ...choice(machine), current: false, sharedBy: machine.share?.ownerName?.trim() || 'another account',
      ...(machine.share?.added === true ? {} : { toAdd: true as const }),
    })),
  ]
}

/** The machine `--machine <word>` means: an exact id, else a label, case-blind; ambiguity is an error, not a guess.
 *  A machine shared with the account answers its name too, but the account's own wins a name both have. */
export function resolveNewMachine(word: string, choices: NewMachine[]): NewMachine {
  const machines = choices.filter((machine) => !machine.toAdd)
  const byId = machines.find((machine) => machine.machineId === word)
  if (byId) return byId
  const wanted = word.toLowerCase()
  // The whole name, else its start, else a word in it: `--machine mini` is "Mac mini" to the person typing.
  const tiers = [
    (label: string) => label === wanted,
    (label: string) => label.startsWith(wanted),
    (label: string) => label.split(/[\s._-]+/).some((part) => part.startsWith(wanted)),
  ]
  let matches: NewMachine[] = []
  for (const tier of tiers) {
    matches = machines.filter((machine) => tier(machine.label.toLowerCase()))
    const own = matches.filter((machine) => machine.sharedBy === undefined)
    if (own.length > 0) matches = own
    if (matches.length > 0) break
  }
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) {
    // Seen 2026-10-16: Mac Auto, shared with everyone at autonomous.ai and not added, read as no machine at all.
    const team = choices.find((machine) => machine.toAdd && (machine.machineId === word || machine.label.toLowerCase() === word.toLowerCase()))
    if (team) {
      throw new NewUsageError(`${team.sharedBy} shared “${team.label}” with everyone at your company. Add it first: Machines › Shared with your team, in the app or hn.`)
    }
    const labels = (shared: boolean) => machines.filter((machine) => (machine.sharedBy !== undefined) === shared).map((machine) => machine.label)
    const shared = labels(true)
    throw new NewUsageError(`No machine called “${word}”. Yours: ${labels(false).join(', ') || 'none'}.`
      + (shared.length ? ` Shared with you: ${shared.join(', ')}.` : ''))
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
  /** What to say when the daemon cannot be reached: stopped, or kept out by a sandbox (lib/unreachable.ts). */
  unreachable?: () => string
  listMachines: () => Promise<NewMachine[]>
  connect: (url: string) => NewSocket
  output: (line: string) => void
  error: (line: string) => void
  timeoutMs?: number
  /** Who is starting it, when an agent runs this from its pane (agentClient/commands.ts `agentOrigin`). */
  origin?: () => Promise<NewOrigin | null>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** The caller's environment: whether `harness mcp` runs this, and where its engines keep their folder trust.
   *  This process's when left out. */
  env?: NodeJS.ProcessEnv
}

/** A harness the caller already has by the name it asks for again (`NewOrigin.existing`). */
export interface ExistingHarness { name: string; machineId: string; state: 'starting' | 'running'; agentId?: string; note: string }

/** An agent starting a harness (docs/design/2026-10-11-agent-client.md): its limits, the header its task carries,
 *  and the record of who started what. */
export interface NewOrigin {
  /** Rejects when the caller may not start another harness now. */
  check(): Promise<void>
  /** The first message as the new harness reads it. */
  prompt(text: string, machineId: string): string
  /** Records it; a warning to print when the record could not be kept everywhere. */
  created(machineId: string, agent: Record<string, unknown>, creationId?: string): Promise<string | null>
  /** The caller's harness by [name] for the same agent on the same machine, already running or still on its way, said
   *  instead of starting a second; else null. */
  existing?(name: string | null, asking: { machineId: string; engine: string }): Promise<ExistingHarness | null>
  /** Records a harness asked for that has not started yet, so the caller follows it by name once this has answered. */
  pending?(machineId: string, creation: { creationId: string; name: string; engine: string }): void
  /** What the start changed, and what to run next: wait for it, then read it. */
  answer(agent: Record<string, unknown>, at: { local: boolean; machine: string | null }): { effect: string; next: NextStep[] }
  /** The caller's own harness, by agent id, when it is one on this computer: a harness started here records it, and the
   *  windows open it beside the caller's pane. Absent for an agent outside Harness. */
  parentAgentId?: string
}

/** How long `harness new` takes at most to answer an agent: within Codex's one-minute MCP tool timeout, with room. */
export const AGENT_ANSWER_MS = 40_000

const ERRORS: Record<string, string> = {
  INVALID_CWD: 'That folder does not exist on the machine.',
  INVALID_ENGINE: 'That agent is not one this machine knows.',
  INVALID_DSH: 'That harness is not in the machine\'s catalog, or does not run on that engine.',
  PROJECT_EXISTS: 'A project with that name already exists. Choose another name, or name its folder to start in it.',
  PROMPT_UNSUPPORTED: 'That agent cannot be started with a first message. Run it again without --task.',
  PROMPT_TOO_LONG: 'A first message holds at most 2,000 characters. Put the rest in a file and name the file in it.',
  SPAWN_FAILED: 'The agent could not be started.',
  // Recorded as a refusal only where a launch cannot be held (a new project's folder): its detail says what it waited for.
  NATIVE_LAUNCH_HELD: 'The agent\'s engine was not ready to start.',
}

/** What a held launch waits for, in the daemon's words (`held.detail` of a pending creation), or ''. */
function holdReason(result: Record<string, unknown>): string {
  const held = result.held as { detail?: unknown } | undefined
  return typeof held?.detail === 'string' ? held.detail.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500) : ''
}

/**
 * The other folders an engine may hold [real]'s trust under: the root of the git repository it is in, and a worktree's
 * main repository. Codex keys a folder in a repository by that root, and a worktree by its main repository; read by the
 * folder alone, every worktree of a repository Codex trusts would be said to be one it asks about.
 */
async function repositoryRoots(real: string): Promise<string[]> {
  for (let dir = real; ; dir = dirname(dir)) {
    // A directory is a repository's own `.git`; a file is a worktree's, naming its main repository's.
    const dotGit = await readFile(join(dir, '.git'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'EISDIR' ? '' : null)
    if (dotGit !== null) {
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(dotGit)?.[1]
      const main = gitdir ? /^(.+)\/\.git\/worktrees\/[^/]+\/?$/.exec(resolve(dir, gitdir))?.[1] : undefined
      return main ? [dir, main] : [dir]
    }
    if (dirname(dir) === dir) return []
  }
}

/**
 * Whether [engine] will stop on its "Do you trust this folder?" question before it starts in [cwd] on this computer:
 * 'empty' for an empty folder, 'content' for one with something in it. Null when it will not ask (it trusts the folder,
 * asks no such question, or Harness answers it as the engine starts) and when the folder cannot be read, which the
 * machine then says.
 *
 * Harness answers the question only for a folder it made empty, directly inside its projects root (core/agents/
 * launches.ts): never for a folder anyone merely named, since Claude Code's trust is inherited downward and an empty
 * `~/code` trusted once would cover every repository cloned under it later (OH-14). So an agent that made a scratch
 * folder of its own (`mktemp -d`) started Claude Code on a question only the person could answer, and could only
 * report that it was waiting (a clean VM, CLI 0.3.75, 2026-10-11).
 */
export async function trustAsked(engine: string, cwd: string, home: string, environment: NodeJS.ProcessEnv): Promise<'empty' | 'content' | null> {
  const trust = ENGINE_NAMES.has(engine) ? folderTrust(engine as AgentEngine, null, environment) : null
  if (!trust) return null
  let real: string
  let names: string[]
  try { real = await realpath(cwd); names = await readdir(real) } catch { return null }
  // By the path it is sent, as the daemon judges it.
  if (names.length === 0 && dirname(cwd) === projectsRoot(home)) return null
  // Typed or resolved: on macOS /tmp is /private/tmp, and an engine may hold either.
  const keys = new Set([cwd, real, ...await repositoryRoots(real)])
  if ([...keys].some((key) => trust.trusts(key))) return null
  return names.length === 0 ? 'empty' : 'content'
}

/** [path] under [home] as `~/…`. */
const tildeOf = (path: string, home: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

/** How the caller starts [args] in a new project [project] instead: the shell's words, or the tool `harness mcp` offers. */
function projectStep(args: NewArgs, project: string, env: NodeJS.ProcessEnv): string {
  if (env[VIA_MCP_ENV] === '1') return `harness_start (project: "${project}", …)`
  const name = args.name === null ? '' : ` --name ${/^[\w.-]+$/.test(args.name) ? args.name : JSON.stringify(args.name)}`
  return `harness new ${args.agent} ${project}${name} -- …`
}

/** How the caller starts [args] in the existing [folder] instead: the shell's words, or the tool `harness mcp` offers. */
function folderStep(args: NewArgs, folder: string, env: NodeJS.ProcessEnv): string {
  if (env[VIA_MCP_ENV] === '1') return `harness_start (folder: "${folder}"${args.machine === null ? '' : `, machine: "${args.machine}"`}, …)`
  const name = args.name === null ? '' : ` --name ${/^[\w.-]+$/.test(args.name) ? args.name : JSON.stringify(args.name)}`
  const machine = args.machine === null ? '' : ` ${machineOption(args.machine)}`
  // Quoted, `~/` still means the home: parseNewArgs reads it, not the shell.
  return `harness new ${args.agent}${machine} ${/^[\w./~-]+$/.test(folder) ? folder : JSON.stringify(folder)}${name}${args.prompt ? ' -- …' : ''}`
}

/**
 * What `harness new` says when the new project it was to make is already there. A name the person chose is never quietly
 * changed (lib/projectFolder.ts), so the ways on are that folder or another name. "Name its folder instead", followed by
 * the app's "Select that folder from your projects", left out where the folder was and how to name one (PROJECT_EXISTS
 * was 4 of 7 failed starts on Oct 18). The machine names the folder when it is one to start in (`existingFolder`).
 */
function projectExists(args: NewArgs, folder: string | null, at: { local: boolean; machine: string; home: string }, env: NodeJS.ProcessEnv): string {
  const slug = args.projectName ? projectFolderSlug(args.projectName) : null
  const called = slug ? `“${slug}”` : 'A project with that name'
  if (!folder) return `${called} already exists on ${at.machine}. Choose another name for the new project.`
  const shown = at.local ? tildeOf(folder, at.home) : folder
  return `${called} already exists on ${at.machine}: ${shown}. Choose another name for the new project, or start in that folder: `
    + folderStep(args, shown, env)
}

/** One loopback session with the daemon: select the machine, then ask, one request at a time. */
export function daemonSession(deps: Pick<NewCommandDeps, 'port' | 'connect' | 'timeoutMs'>, machineId: string): Promise<{
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
    // A tool, not a window: a window's registration turns on the question watcher and counts as someone looking.
    socket.on('open', () => socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, tool: true } })))
    // `daemonRunning` saw the daemon's process, so a connect refused on the way is a sandbox's: Linux's lets the signal
    // through and refuses the connect (lib/unreachable.ts).
    socket.on('error', (error) => failAll(refused(error) ? new Error(SANDBOXED) : error))
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
    deps.error(deps.unreachable?.() ?? NOT_RUNNING)
    return 1
  }
  const env = deps.env ?? process.env
  const clock = deps.now ?? Date.now
  const began = clock()
  try {
    const origin = (await deps.origin?.()) ?? null
    // A terminal is the person's: `ps`, `show`, `wait` and `close` never list one (agentClient/model.ts `isAgent`). An
    // agent that started one was told "Read it: harness show vt1", then "No harness named vt1", could not close it, and
    // had it count toward its eight for as long as it stayed open; its task would be typed into a shell, header and all
    // (the released CLI 0.3.76 on a Mac, 2026-10-12).
    if (origin && args.agent === 'terminal') {
      throw new Error('An agent cannot start a terminal: it could not read it, wait for it or close it afterwards. '
        + 'Run the command in your own shell, or start an agent for the work (harness new codex <project> -- <task>). Nothing was started.')
    }
    // Full mode turns off the new agent's own permission checks and sandbox (`--dangerously-skip-permissions`,
    // `--dangerously-bypass-approvals-and-sandbox`). Harness's agent commands run without the person being asked
    // (engines/facets/hooks.ts HarnessAllowance), so a sandboxed agent could have started one with any task and no one
    // asked: the review of #1232. Auto, the default, keeps each engine's own checks. The person still chooses full.
    if (origin && args.mode === 'full') {
      throw new Error('An agent cannot start a harness in full mode: it would run with its permission checks and sandbox off, '
        + 'and no one was asked. Start it without --mode (auto, where its own checks run), or ask the person to start it in full mode. '
        + 'Nothing was started.')
    }
    let machineId = deps.localMachineId
    let machineLabel = 'this computer'
    let local = true
    if (args.machine !== null) {
      const machine = resolveNewMachine(args.machine, await deps.listMachines())
      machineId = machine.machineId
      machineLabel = machine.current ? 'this computer' : machine.label
      local = machine.current
    }
    // A start left pending on another machine is looked for there: `harness ps` alone lists this one, which is how
    // the lamp lost its harness on office (review of #1333).
    const psThere = local || args.machine === null ? 'harness ps' : `harness ps ${machineOption(args.machine)}`
    if (!machineId) {
      deps.error('This computer is not signed in to Harness. Run `harness login`.')
      return 1
    }
    // An agent asking again for a harness it already has, by its name, for the same agent on the same machine: answered
    // with that one, never a second. The person at a terminal has no origin and is never stopped here.
    const already = await origin?.existing?.(args.name, { machineId, engine: args.agent })
    if (already) {
      const { note, ...harness } = already
      deps.output(args.json ? JSON.stringify({ ok: true, existing: true, ...harness, note }) : note)
      return 0
    }
    await origin?.check()
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
      // An agent naming a folder Harness did not make: its engine may stop on a question only the person can answer.
      // Read here, where the engine's settings are; another machine's are not, and the person at a terminal is there
      // to answer it.
      let trustNote: string | null = null
      if (origin && local && cwd !== null) {
        const store = args.agent.includes('/')
        const engine = store ? baseEngine : args.agent
        const asks = await trustAsked(engine, cwd, deps.home, env)
        const project = projectFolderSlug(args.name ?? '') ?? 'review'
        const instead = projectStep(args, project, env)
        // Empty, it holds nothing the new harness needs: a project of its own does the same with no one asked. A store
        // harness lays its template into an empty folder, and the folder is then trusted as it starts.
        if (asks === 'empty' && !store) {
          throw new Error(`${engineName(engine)} would ask the person to trust ${cwd} before it starts, and it is empty: `
            + `for scratch or new work give a project name instead — ${instead}  (Harness makes `
            + `${tildeOf(join(projectsRoot(deps.home), project), deps.home)}, which needs no approval). Nothing was started.`)
        }
        // With content it may be just what the work needs, so it starts; the agent is told it will wait for the person.
        if (asks === 'content') {
          trustNote = `${engineName(engine)} will ask the person to trust ${cwd} before it starts, so it waits for them until `
            + `they answer (${env[VIA_MCP_ENV] === '1' ? 'harness_wait says it needs the person' : 'harness wait exits 3'}). `
            + `For new work, a project name avoids this: ${instead}`
        }
      }
      const asked = origin && args.prompt ? { ...args, prompt: origin.prompt(args.prompt, machineId) } : args
      // Started by an agent: the machine records it, and the pull requests it opens say so (lib/agentAttribution.ts).
      // Started by a harness on this computer: which one, so the windows open it beside that harness.
      const parent = origin && local ? origin.parentAgentId ?? null : null
      const payload: Record<string, unknown> = {
        ...newAgentPayload(asked, cwd, baseEngine), ...(origin ? { startedBy: 'agent' } : {}), ...(parent ? { parentAgentId: parent } : {}),
      }
      let result = await session.request('agent_create', payload)
      const creationId = String(payload.creationId)
      // Recorded before any waiting: an agent's call that is cut off (a tool's timeout) leaves a harness that may still
      // start, and it is then the agent's, by name, for `ps`, `wait` and the check above.
      if (origin && (result.state === 'pending' || result.state === 'unconfirmed')) {
        origin.pending?.(machineId, { creationId, name: args.name ?? '', engine: String(payload.engine) })
      }
      // A launch the daemon holds (a native launch waiting its turn) is still on its way: asked after until it is not,
      // for a minute. Given up on at once, it could start later with an agent's task and no record of who started it
      // (the review of #1180). What it waits for is said as it changes: the daemon's own words, which used to stay in
      // the daemon while this said only "could not confirm" (OpenCode and Codex held for good in clean VMs, 2026-10-11).
      // An engine Harness is installing for this launch (a hold under `install`) is waited for up to five minutes,
      // and the launch then gets its minute: a minute in all ended a Codex install as it finished (a fresh Ubuntu VM,
      // 2026-10-12, where it took about that).
      const installing = (status: Record<string, unknown>) => (status.held as { service?: unknown } | undefined)?.service === 'install'
      // An agent is answered within AGENT_ANSWER_MS, install or not: MCP clients end a tool call at a minute (Codex's
      // default `tool_timeout_sec`), and shell tools have limits of their own. A call cut off left the agent with nothing,
      // and one that asked again got a second harness.
      // At least ten seconds of asking, however long the setup took: a slow line to another machine left none.
      const answerBy = Math.max(began + AGENT_ANSWER_MS, clock() + 10_000)
      let said = '', polls = 30
      for (let i = 0; i < polls && (result.state === 'pending' || result.state === 'unconfirmed') && (!origin || clock() < answerBy); i++) {
        if (installing(result)) polls = Math.min(180, Math.max(polls, i + 30))
        const reason = holdReason(result)
        // Not under `harness mcp`: an MCP client sees only the whole answer, which says it, after the result.
        if (reason && reason !== said && !args.json && env[VIA_MCP_ENV] !== '1') deps.error(reason)
        said = reason || said
        await (deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms))))(2_000)
        result = await session.request('agent_create_status', { creationId: payload.creationId })
      }
      // Still held after a minute: cancelled, so it never starts later, task and all, with nobody waiting for it.
      // The daemon takes a cancel only before the launch is claimed (lib/agentCreationReceipt.ts `cancelIntent`) and
      // otherwise answers what became of it, which is then the answer here.
      // An agent's harness still installing its engine is left to start by itself, and the agent told how to follow it:
      // cancelled, the install would be wasted and the agent would only ask again.
      if (origin && result.state === 'pending' && installing(result)) {
        const name = args.name?.trim() ?? ''
        // Under MCP the tools take no machine: harness_wait finds the caller's own by its record.
        // One name as the shell takes it: quoted when it has a space (the MCP tool call quotes it once, `step`).
        const word = /^[\w.:-]+$/.test(name) ? name : `"${name.replace(/(["\\$`])/g, '\\$1')}"`
        const at = local || args.machine === null || env[VIA_MCP_ENV] === '1' ? word : `${machineOption(args.machine)} ${word}`
        const next: NextStep[] = name ? [{ run: step(env, 'wait', at), when: 'until it has started and answered' }] : [{ run: step(env, 'ps'), when: 'to follow it' }]
        const note = `${name || 'The harness'} on ${machineLabel}: installing ${engineName(String(payload.engine))}. It starts by itself once installed; do not start it again.`
        deps.output(args.json ? JSON.stringify({ ok: true, pending: true, machineId, creationId, name, note, next }) : `${note}\n${formatNext(next)}`)
        return 0
      }
      if (result.state === 'pending') {
        const reason = holdReason(result) || said
        const install = installing(result)
        const why = install ? `Harness is still installing ${engineName(String(payload.engine))}.`
          : `Harness did not start the harness ${polls > 30 || origin ? 'in time' : 'within a minute'}${reason ? `: ${reason}` : '.'}`
        const cancelled = await session.request('agent_create_cancel', { creationId: payload.creationId }).catch(() => null)
        if (cancelled?.state === 'cancelled') {
          throw new Error(`${why} ${install ? 'Run the same command again in a minute; this request is cancelled' : 'The request is cancelled'}, `
            + 'so it will not start later.')
        }
        // No answer (a daemon that predates the cancel): the request is still saved, and may start later.
        if (typeof cancelled?.state !== 'string' || cancelled.state === 'pending') {
          throw new Error(`${why} It is still saved and may start later by itself: check with \`${psThere}\` before starting another.`)
        }
        // Too late to cancel: what became of it (created, refused, or claimed and starting now) is the answer.
        result = cancelled
      }
      // With a creation id the daemon answers what became of the launch: only `created` made a harness. A refusal
      // it recorded (`failed`) and an outcome it could not confirm used to print "Created" all the same.
      if (result.state !== undefined && result.state !== 'created') {
        const failure = (result.failure ?? {}) as Record<string, unknown>
        const code = typeof failure.code === 'string' ? failure.code : ''
        const detail = typeof failure.detail === 'string' && failure.detail ? failure.detail : ''
        const existing = typeof failure.existingFolder === 'string' && failure.existingFolder ? failure.existingFolder : null
        throw new Error(result.state === 'failed'
          ? code === 'PROJECT_EXISTS' ? projectExists(args, existing, { local, machine: machineLabel, home: deps.home }, env)
          // A code this has no words for is shown by the daemon's own detail, which names the engine and why.
          : ERRORS[code] ? `${ERRORS[code]}${detail ? ` (${detail})` : ''}` : detail || code || 'The harness could not be started.'
          : `Harness could not confirm the harness started (${String(result.state)}). Check with \`${psThere}\` before starting another.`)
      }
      const agent = (result.agent ?? {}) as Record<string, unknown>
      const warning = await origin?.created(machineId, agent, creationId)
      if (warning) deps.error(warning)
      // An agent is told it is starting (never that its task is done), what changed, and what to run next.
      const told = origin?.answer(agent, { local, machine: args.machine })
      if (args.json) deps.output(JSON.stringify({ ok: true, machineId, agent, ...(trustNote ? { note: trustNote } : {}), ...(told ? { effect: told.effect, next: told.next } : {}) }))
      else if (origin && told) {
        const project = (agent.project ?? {}) as Record<string, unknown>
        const folder = typeof project.cwd === 'string' ? project.cwd : cwd
        const name = String(agent.name ?? agent.id ?? 'The harness')
        deps.output(`${name} on ${machineLabel}: starting. ${engineName(String(agent.engine ?? payload.engine ?? ''))}${folder ? `, in ${folder}` : ''}.`)
        if (told.effect) deps.output(told.effect)
        if (trustNote) deps.output(trustNote)
        const next = formatNext(told.next)
        if (next) deps.output(next)
      } else {
        const project = (agent.project ?? {}) as Record<string, unknown>
        const where = typeof project.cwd === 'string' ? ` in ${project.cwd}` : cwd ? ` in ${cwd}` : ''
        const name = String(agent.name ?? agent.id ?? 'a harness')
        deps.output(`Created ${name} on ${machineLabel}${where}.`)
        if (trustNote) deps.output(trustNote)
        deps.output('Open it in Harness with ⌘O.')
        // Started on another machine by a person or a program, it is read and waited for through that machine, named as
        // it was here. The lamp (lamp-4ace, 2026-10-14 21:36), a program outside Harness, started `lamp-first-task` on
        // office this way and was told only ⌘O, which it has not got.
        if (!origin && !local && args.machine !== null) {
          const at = `${machineOption(args.machine)} ${addressOf({ machineId: '', agentId: String(agent.id ?? ''), name: String(agent.name ?? ''), engine: '' })}`
          deps.output(`Read it: ${step(env, 'show', at)} · wait for it: ${step(env, 'wait', at)}`)
        }
      }
      return 0
    } finally { session.close() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Refused (a limit, the person's setting, a pane whose harness is gone): not a failure to retry.
    const refused = error instanceof AgentClientError && REFUSED_CODES.has(error.code) ? error : null
    if (args.json) {
      deps.output(JSON.stringify({ ok: false, error: message,
        ...(refused ? { code: refused.code, ...(refused.reason ? { reason: refused.reason } : {}), next: refusalNext(env, refused) } : {}) }))
    } else deps.error(message)
    return refused ? EXIT.refused : error instanceof NewUsageError ? 2 : 1
  }
}
