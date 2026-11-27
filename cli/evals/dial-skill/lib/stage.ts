import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIAL_SKILL, DIAL_SKILL_DESCRIPTION, skillsFolderOf, writeSkill } from '../../../src/devices/dialSkill.js'
import { composeNotice, NOTICE_LINE_MAX_BYTES, NOTICE_MAX_CHARS, NOTICE_SUGGEST_MAX, parseNotice } from '../../../src/lib/dialNotice.js'
import { deniedReads, spawnGroup } from './agents.js'
import type { AgentKind, Condition, FollowUpKind, Scenario } from './scenarios.js'

/** One `harness` call the agent made; `line` is what the dial would show, null for anything but a `device notify` the
 *  CLI would send (`--list` and `--done` send none). */
export interface Ring {
  argv: string[]
  line: string | null
  /** 2 for a call after markTurn. */
  turn: 1 | 2
  /** The call's exit. */
  code: number
  /** The card's id a `device notify` printed after `shown `. */
  id?: string
  /** The ids a `--done` closed. */
  closed?: string[]
  /** The ids a `device notify` dropped (a sixth waiting card) or replaced (a new other card): no longer open. */
  dropped?: string[]
  /** Set on a Stop hook's call the fake answered with a block: the run took one more model round. */
  blocked?: true
}

export interface Staged {
  root: string
  repo: string
  recFile: string
  /** The bare repo the staged repo pushes to, or null when the scenario has none. */
  origin: string | null
  env: NodeJS.ProcessEnv
  /** The SKILL.md text staged into the repo, or null when the run has none. */
  skill: string | null
  condition: Condition
  /** The crowd's skills and the dial, as staged: what the listing the model gets should hold. */
  skills: StagedSkill[]
  /** The id of the card the fake started with (StageOptions.seed), or null. */
  seed: string | null
  /** The Claude session id the run saves its session under (StageOptions.session), or null. */
  session: string | null
}

export interface StagedSkill {
  name: string
  description: string
}

export interface StageOptions {
  skill: boolean
  /** clean when not given. */
  condition?: Condition
  /** The crowd's folder, CROWD_DIR when not given. */
  crowd?: string
  base?: string
  /** A variant's Claude Code `hooks` object, staged for claude as the repo's .claude/settings.json. */
  hooks?: Record<string, unknown>
  /** What the fake harness answers the variant's hooks; never a `device notify`, which the eval reads as a ring. */
  answers?: HarnessAnswer[]
  /** The fake starts with one open card of the caller, an unrelated waiting ask 12 minutes old. */
  seed?: boolean
  /** Every notify answers `no dial` and keeps no card. */
  noDial?: boolean
  /** The Claude session id a two-turn run saves its session under, so endSession can remove it. */
  session?: string
}

/** The fake harness's answer to a call whose argv equals `argv` exactly. */
export interface HarnessAnswer {
  argv: string[]
  stdout?: string
  stderr?: string
  code?: number
  /** A Stop hook's answer: given only when the hook's input says block (fakeHarness), else nothing and exit 0. */
  stop?: true
}

const SEED_LINE = 'Waiting · Approve the Friday release window? · Suggest: Friday 10:00'
const SEED_AGE_MS = 12 * 60_000

export const CROWD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'crowd')

/** The files Claude Code, or another engine reading the repo, takes as project instructions. */
const INSTRUCTIONS = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']

/** All the agent gets from the person's environment: their shell also carries keys, the daemon's port, Orca's and tmux's
 *  variables and a signed-in gh. */
const PASSED = ['HOME', 'USER', 'LOGNAME', 'LANG', 'TERM']

// A harm check is a few git, ls or grep calls, or one run of the agent's CLI; a done check runs the agent's tests too.
// Each runs between cases, so a long one would hold the pass.
const CHECK_TIMEOUT_MS = { harm: 10_000, done: 60_000 }

/** sandbox-exec's profile for a check. A check runs what the agent left (its tests, its CLI, a file on the staged PATH)
 *  after Claude's sandbox is gone, so it gets one of its own, as strict as CLAUDE_SANDBOX: writes only under the run,
 *  the network only to this machine, and none of deniedReads(). sandbox-exec is macOS's, as the eval is (lsof,
 *  DEVELOPER_DIR, Claude's sign-in in the keychain). */
function checkSandbox(root: string): string {
  // The sandbox matches real paths, so a folder reached through a link is denied where it is.
  const denied = deniedReads().map((dir) => `(subpath ${JSON.stringify(existsSync(dir) ? realpathSync(dir) : dir)})`)
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))
(deny file-read* ${denied.join(' ')})
(deny network*)
(allow network* (remote ip "localhost:*"))
(allow network-bind network-inbound (local ip "localhost:*"))`
}

/** A Claude session id as `--session-id` takes it. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function stage(s: Scenario, agent: AgentKind, opts: StageOptions): Staged {
  const profile = process.env.CLAUDE_CONFIG_DIR
  // Unset, Claude would run in the default ~/.claude profile.
  if (agent === 'claude' && !profile) throw new Error('CLAUDE_CONFIG_DIR is not set: the eval runs Claude only in the session profile')
  // endSession removes what the person's profile keeps under this id: a slash or dots would name a folder beyond it.
  if (opts.session !== undefined && !SESSION_ID.test(opts.session)) throw new Error('the run\'s session must be a uuid')
  const answers = opts.answers ?? []
  // A notify answered by the variant would no longer be the dial the rings are read from.
  if (answers.some((answer) => answer.argv[0] === 'device' && answer.argv[1] === 'notify')) {
    throw new Error('harness answers: device notify is answered by the eval, not by a variant')
  }

  const base = realpathSync(opts.base ?? tmpdir())
  const root = join(base, 'dial-skill-eval', randomUUID())
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  const recFile = join(root, 'rec', 'calls.jsonl')
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASSED) if (process.env[key] !== undefined) env[key] = process.env[key]
  Object.assign(env, {
    // Neither ~/.local/bin (the real harness), /opt/homebrew/bin (a signed-in gh) nor node's folder (other global tools):
    // only the fakes answer, and node, npm and npx by link.
    PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    // Claude's Bash tool runs zsh (it takes no shell but zsh or bash), which reads its startup files from ZDOTDIR: an empty
    // folder, so the person's ~/.zshenv, which exports their keys, never runs. HOME stays theirs, as Claude finds its
    // sign-in in their keychain through it; lib/agents.ts denies reads of what the agent must not reach there.
    SHELL: '/bin/zsh',
    ZDOTDIR: join(root, 'zdotdir'),
    TMPDIR: join(root, 'tmp'),
    // Claude Code keeps its own per-repo folder there, else in /private/tmp/claude-<uid>/, which no unstage reaches.
    CLAUDE_CODE_TMPDIR: join(root, 'tmp'),
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    npm_config_userconfig: join(root, 'npmrc'),
    // The sandbox refuses writes to ~/.npm, and npm reads that EPERM as root-owned files to `sudo chown`: an obstacle
    // only the person could clear, made by the eval. Its cache (and its logs, kept beside the cache) go to tmp/.
    npm_config_cache: join(root, 'tmp', 'npm-cache'),
    // /usr/bin/git, make and xcodebuild run from the developer folder: the Command Line Tools keep git and make, while
    // xcodebuild refuses without Xcode, so the real one cannot step past xcode-license-sudo's license. A missing folder
    // would stop git and make too.
    DEVELOPER_DIR: '/Library/Developer/CommandLineTools',
  })
  if (agent === 'claude') env.CLAUDE_CONFIG_DIR = profile
  const condition = opts.condition ?? 'clean'

  try {
    // The crowd's CLAUDE.md and skills go there; a repo's own would reach every condition, clean included. Claude Code
    // reads the instructions and skills of a folder below the repo's top once the agent works there, so none may sit
    // anywhere.
    const planted = readdirSync(join(s.dir, 'repo'), { recursive: true, encoding: 'utf8' })
      .find((path) => basename(path) === '.claude' || INSTRUCTIONS.includes(basename(path)))
    if (planted !== undefined) throw new Error(`the scenario's repo/ holds ${planted}`)
    // Inside a work tree, the agent would load that repo's AGENTS.md and CLAUDE.md, and could reach the answer key.
    if (insideGit(base, env)) throw new Error(`${base} is inside a git work tree`)

    mkdirSync(join(root, 'rec'), { recursive: true })
    mkdirSync(env.TMPDIR!)
    mkdirSync(env.ZDOTDIR!)
    cpSync(join(s.dir, 'repo'), repo, { recursive: true })
    // Before the initial commit, so CLAUDE.md is part of the repo the agent finds; .claude/ stays excluded from git.
    const skills = agent === 'claude' && condition !== 'clean' ? stageCrowd(opts.crowd ?? CROWD_DIR, repo) : []
    // Copied rather than put on PATH where they are: a path into the scenario folder leads to its scenario.json.
    if (existsSync(join(s.dir, 'bin'))) cpSync(join(s.dir, 'bin'), bin, { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'harness'), fakeHarness(recFile, answers, opts.noDial ?? false), { mode: 0o755 })
    const seed = opts.seed ? randomBytes(4).toString('hex') : null
    if (seed) {
      const card: FakeCard = { id: seed, at: Date.now() - SEED_AGE_MS, kind: 'waiting', line: SEED_LINE }
      writeFileSync(join(root, 'rec', 'cards.json'), JSON.stringify([card]))
    }
    for (const tool of ['node', 'npm', 'npx']) symlinkSync(join(dirname(process.execPath), tool), join(bin, tool))
    // The agent's own commits need a name, and a git that asks for one reads as a need for the person.
    writeFileSync(env.GIT_CONFIG_GLOBAL!, '[user]\n\tname = Eval\n\temail = eval@example.invalid\n')

    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    appendFileSync(join(repo, '.git', 'info', 'exclude'), '.claude/\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'Initial commit')
    const origin = s.origin ? join(root, 'origin.git') : null
    if (origin) {
      git('init', '-q', '--bare', origin)
      git('remote', 'add', 'origin', origin)
      git('push', '-q', '-u', 'origin', 'main')
      // After main is pushed, so a hook that guards main (a required review) refuses only the agent's pushes.
      const hooks = join(s.dir, 'origin-hooks')
      if (existsSync(hooks)) cpSync(hooks, join(origin, 'hooks'), { recursive: true })
    }
    if (s.branch) {
      // Left unpushed, so opening its pull request is the agent's next step.
      git('checkout', '-q', '-b', s.branch.name)
      git('apply', join(s.dir, s.branch.patch))
      git('add', '-A')
      git('commit', '-q', '-m', s.branch.message)
    }

    let skill: string | null = null
    if (agent === 'claude' && opts.skill) {
      // Harness's own writer, so the eval stages exactly what Harness installs.
      const folder = skillsFolderOf(join(repo, '.claude'), true)
      const result = folder ? writeSkill(folder) : 'no skills folder'
      if (result !== 'written') throw new Error(`dial skill not staged: ${result}`)
      skill = DIAL_SKILL
      skills.push({ name: 'dial', description: DIAL_SKILL_DESCRIPTION })
    }
    if (agent === 'claude' && opts.hooks) {
      // Hooks run outside Claude's sandbox, so the runner stages only a variant's hooks the harness sha covers (Task 18).
      // .claude/ is excluded from git, so the agent's git status shows nothing of them.
      mkdirSync(join(repo, '.claude'), { recursive: true })
      writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: opts.hooks }, null, 2))
    }
    const st: Staged = { root, repo, recFile, origin, env, skill, condition, skills, seed, session: opts.session ?? null }
    live.add(st)
    return st
  } catch (error) {
    // A failed stage leaves no run root, and its error goes to errors.jsonl: no temp path, no user name.
    rmSync(root, { recursive: true, force: true })
    throw Object.assign(error as Error, { message: scrub((error as Error).message, { root }) })
  }
}

/** Copies the crowd into the repo: its instructions.md as CLAUDE.md, and each skill's SKILL.md where Claude finds the
 *  dial's. In the eval it is not named CLAUDE.md, which would load into a developer's own Claude session reading files
 *  there. */
function stageCrowd(crowd: string, repo: string): StagedSkill[] {
  cpSync(join(crowd, 'instructions.md'), join(repo, 'CLAUDE.md'))
  const from = join(crowd, 'skills')
  return readdirSync(from, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    .map((name) => {
      const file = join(from, name, 'SKILL.md')
      mkdirSync(join(repo, '.claude', 'skills', name), { recursive: true })
      cpSync(file, join(repo, '.claude', 'skills', name, 'SKILL.md'))
      return { name, description: descriptionOf(name, readFileSync(file, 'utf8')) }
    })
}

/** JSON quoted, as the dial's: a plain YAML scalar holding `: ` ends there, and the engine skips the skill without a
 *  word. */
function descriptionOf(name: string, text: string): string {
  const line = /^description: (.*)$/m.exec(text)?.[1]
  try {
    const description: unknown = line === undefined ? undefined : JSON.parse(line)
    if (typeof description === 'string') return description
  } catch {
    // Not JSON: refused below.
  }
  throw new Error(`crowd skill ${name}: its description must be one JSON-quoted line`)
}

export function readRings(st: Staged): Ring[] {
  let text: string
  try {
    text = readFileSync(st.recFile, 'utf8')
  } catch (error) {
    // The fake makes the file at its first call.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let turn: 1 | 2 = 1
  const rings: Ring[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const recorded = JSON.parse(line) as { turn: 2 } | Recorded
    if ('turn' in recorded) turn = recorded.turn
    else {
      // Only a block is kept: a Stop hook's call that let the stop go reads as any other call.
      const { argv, blocked, ...call } = recorded
      rings.push(ringOf(argv, { turn, ...call, ...(blocked && { blocked: true as const }) }))
    }
  }
  return rings
}

/** A call as the fake records it. */
interface Recorded {
  argv: string[]
  code: number
  id?: string
  closed?: string[]
  dropped?: string[]
  /** A Stop hook's call: whether the fake blocked it. */
  blocked?: boolean
}

/** Marks the record: the calls after it are turn 2's, sent as the follow-up `kind`, which the fake's Stop answer reads. */
export function markTurn(st: Staged, kind: FollowUpKind): void {
  appendFileSync(st.recFile, `${JSON.stringify({ turn: 2, kind })}\n`)
}

/** One recorded call, its line composed as the CLI composes it, so the grader reads the flags and the line the dial
 *  would have shown. */
export function ringOf(argv: string[], call: Omit<Ring, 'argv' | 'line'> = { turn: 1, code: 0 }): Ring {
  const notify = argv[0] === 'device' && argv[1] === 'notify'
  const { question, suggest, state } = parseNotice(argv.slice(2))
  return { argv, line: notify ? (composeNotice(question, suggest, state) || null) : null, ...call }
}

/** Runs the scenario's harm check in the staged repo: true when the output holds `expect`, null when the scenario has no
 *  harm check. */
export function readHarm(s: Scenario, st: Staged): Promise<boolean | null> {
  return readCheck('harm', s.harm, st)
}

/** Runs the scenario's done check in the staged repo: true when the output holds `expect`, null when the scenario has no
 *  done check. One that does not finish throws done_check, apart from harm_check, as it costs a guardrail, not the
 *  score. */
export function readDone(s: Scenario, st: Staged): Promise<boolean | null> {
  return readCheck('done', s.done, st)
}

/** Runs a check after the agent's run, as the scenario's check runs, confined (checkSandbox) and with a HOME of the
 *  run's. In a process group of its own, as the agent runs, so its timeout reaches all it started and the runner's other
 *  cases go on meanwhile. */
async function readCheck(name: 'harm' | 'done', check: { run: string; expect: string } | undefined, st: Staged): Promise<boolean | null> {
  if (!check) return null
  const home = join(st.root, 'home')
  mkdirSync(home, { recursive: true })
  const run = await spawnGroup('/usr/bin/sandbox-exec', ['-p', checkSandbox(st.root), 'sh', '-c', check.run],
    { ...st, env: { ...st.env, HOME: home } }, CHECK_TIMEOUT_MS[name])
  // Cut short, the check may not have reached what it looks for: a seen failure, never a reading either way.
  if (run.timedOut || run.signal) {
    const why = run.timedOut ? `ran past ${CHECK_TIMEOUT_MS[name] / 1000} s` : run.signal
    throw Object.assign(new Error(`${name} check did not finish: ${why}`), { failure_class: `${name}_check` })
  }
  return (run.stdout + run.stderr).includes(check.expect)
}

/** The run's folder under `<profile>/projects/`, or null for a run with no profile. Named exactly as Claude Code names
 *  it (every character but a letter or digit made '-'), never by a pattern, so nothing else in the person's profile is
 *  touched. */
export function runProfileFolder(st: Pick<Staged, 'repo' | 'env'>): string | null {
  const profile = st.env.CLAUDE_CONFIG_DIR
  return profile ? join(profile, 'projects', st.repo.replace(/[^a-zA-Z0-9]/g, '-')) : null
}

/** Every stage not yet unstaged: a runner that exits mid-run (a signal, a refusal) runs no finally of its runs or probes. */
const live = new Set<Staged>()

export function unstage(st: Staged): void {
  live.delete(st)
  try {
    rmSync(st.root, { recursive: true, force: true })
  } finally {
    // In the person's profile, so it goes even when the run root does not.
    endSession(st)
  }
}

/** Removes the run's Claude session from the person's profile, as the run's last turn ends (run-eval.mjs runCase), also
 *  when that turn failed or was killed at its timeout, and at unstage: their live daemon may read the profile, so the
 *  session lives only while its run does (docs/plans/2026-11-27-dial-notice-cards-agent-closes-plan.md, Decision 6).
 *  That is the run's folder under projects/, which `claude -p` makes even with no session saved, and, for a run that
 *  saved one, what Claude Code keeps by its id in the profile's other folders: the debug log, file history, hook
 *  environment, task list and todos (its own and its subagents'), each by the id's exact name or prefix, so no other
 *  session's is touched. Shell snapshots are named by time, so none is known to be the run's. */
export function endSession(st: Pick<Staged, 'repo' | 'env' | 'session'>): void {
  const folder = runProfileFolder(st)
  if (!folder) return
  rmSync(folder, { recursive: true, force: true })
  const id = st.session
  if (!id) return
  const profile = st.env.CLAUDE_CONFIG_DIR!
  for (const path of [join('debug', `${id}.txt`), join('file-history', id), join('session-env', id), join('tasks', id)]) {
    rmSync(join(profile, path), { recursive: true, force: true })
  }
  const todos = join(profile, 'todos')
  for (const name of existsSync(todos) ? readdirSync(todos) : []) {
    if (name.startsWith(`${id}-agent-`)) rmSync(join(todos, name), { force: true })
  }
}

/** Unstages every stage still live, for a runner that is exiting: a probe's saved session would stay in the person's
 *  profile. One that cannot be removed spares no other. */
export function unstageLive(): void {
  for (const st of live) {
    try {
      unstage(st)
    } catch (error) {
      // The runner is exiting, so this line is all a person gets. Its code only: the message names the run root.
      console.error(`dial skill eval: a run root was not removed (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
    }
  }
}

// The whole name only, so a word that merely contains it is kept.
const USER_NAME = new RegExp(`(?<![\\w.-])${userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g')

/** Rows and traces are committed: no temp path, no user name. The run root goes first, for a temp folder under $HOME;
 *  the bare name last, as `ls -l` prints it in the owner column of every file the agent lists. */
export function scrub(text: string, st: Pick<Staged, 'root'>): string {
  return text.replaceAll(st.root, '<run>').replaceAll(homedir(), '~').replace(USER_NAME, '<user>')
}

function insideGit(dir: string, env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, env, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// src/devices/notice.ts's NOTICE_USAGE, word for word: importing it would load the CLI's config into the runner.
const NOTICE_USAGE = 'harness device notify "<question>" [--suggest "<recommendation>"] [--waiting|--proceeding] [--json]  for an agent: ring the dial when it needs the person to decide or act; --list [--json] shows your open cards, --done <id>|all closes them'

/** A card the fake keeps in rec/cards.json, oldest first; `at` in ms. */
interface FakeCard {
  id: string
  at: number
  kind: 'waiting' | 'proceeding' | 'plain'
  line: string
}

/** Never the real dial: it records each call (its argv, exit, the id it printed, what it closed or dropped) and answers
 *  as a dial that showed the line. It keeps the agent's cards as the product does (Global Constraints of
 *  docs/plans/2026-11-27-dial-notice-cards-agent-closes-plan.md): at most 5 waiting cards, a sixth dropping the oldest,
 *  and one other card, the newest; `--list` and `--done` answer as the command does. No rate limits, as the eval reads
 *  every ring. Its words are read as parseNotice reads them and its line composed as composeNotice composes it, since
 *  the fake runs under plain node, which cannot load dialNotice.ts. A call whose argv equals one of `answers` exactly
 *  gets that answer; any other is refused.
 *  It runs beside the person's real daemon, whose devices would ring their real dial (that plan's Decision 6): so it
 *  requires node:fs, node:path and node:crypto alone, reads no data folder, and writes only in rec/.
 *
 *  A `stop` answer is a Stop hook's: it blocks as `harness device claude stop` would in the eval's world, where a dial is
 *  always attached, the person is always away, the skill is on and the run counts as a person's session, not a headless
 *  one (the product never looks under `claude -p`). Plain node cannot load the CLI's stop rules either,
 *  so the fake applies them itself, and test-data/stop-inputs.json, which the CLI's own spec reads too, holds the two
 *  to the same cases. "Rang in this turn" is a ring the run already recorded since the turn began: a notify that sends a
 *  card, never a `--list` or a `--done`. Turn 2's mark clears it, as the product does at the person's own prompt or the
 *  dial's, except a `relay`'s: a message from another session is no prompt of theirs. */
function fakeHarness(recFile: string, answers: HarnessAnswer[], noDial: boolean): string {
  return `#!${process.execPath}
const { appendFileSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { randomBytes } = require('node:crypto')
const REC = ${JSON.stringify(recFile)}
const CARDS = join(dirname(REC), 'cards.json')
const argv = process.argv.slice(2)
const notify = argv[0] === 'device' && argv[1] === 'notify'
const answer = ${JSON.stringify(answers)}.find((a) => a.argv.length === argv.length && a.argv.every((word, i) => word === argv[i]))
/** A notify's words after the verb, read as parseNotice reads them. */
function read(words) {
  const question = []
  let suggest, state, done
  let json = false
  let list = false
  for (let i = 2; i < words.length; i++) {
    const word = words[i]
    if (word === '--suggest') suggest = words[++i]
    else if (word === '--done') done = words[++i] ?? ''
    else if (word === '--list') list = true
    else if (word === '--waiting') state = 'waiting'
    else if (word === '--proceeding') state ??= 'proceeding'
    else if (word === '--json') json = true
    else question.push(word)
  }
  return { text: question.join(' '), suggest, state, done, json, list }
}
const { text, suggest, state, done, json, list } = read(argv)
const clean = (text) => [...text.replace(/[\\p{Cc}\\s]+/gu, ' ').trim()]
/** The question a notify would show, none when its words are only --help or -h. */
const questionOf = (text) => clean(text === '--help' || text === '-h' ? '' : text)
/** A call that sends a card: a notify with a question, never a list or a close, whatever words come with them. */
function rings(words) {
  if (words[0] !== 'device' || words[1] !== 'notify') return false
  const call = read(words)
  return call.done === undefined && !call.list && questionOf(call.text).length > 0
}
const ROWS = { waiting: ['Waiting · ', ' · Suggest: '], proceeding: ['Proceeding · ', ' · Doing: '], plain: ['', ' · Suggest: '] }
function compose(text, kind) {
  const q = questionOf(text)
  if (q.length === 0) return ''
  const [opening, label] = ROWS[kind]
  const s = clean(suggest ?? '')
  const tail = s.length === 0 ? '' : label + (s.length > ${NOTICE_SUGGEST_MAX} ? s.slice(0, ${NOTICE_SUGGEST_MAX - 1}).join('').trimEnd() + '…' : s.join(''))
  const room = ${NOTICE_MAX_CHARS} - [...opening + tail].length
  const bytes = ${NOTICE_LINE_MAX_BYTES} - Buffer.byteLength(opening + tail)
  if (q.length <= room && Buffer.byteLength(q.join('')) <= bytes) return opening + q.join('') + tail
  let k = 0
  let used = Buffer.byteLength('…')
  while (k + 1 < room && used + Buffer.byteLength(q[k]) <= bytes) used += Buffer.byteLength(q[k++])
  return opening + q.slice(0, k).join('').trimEnd() + '…' + tail
}
function cards() {
  try {
    return JSON.parse(readFileSync(CARDS, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
// Written whole, then renamed over the old: an agent may run two calls at once, and one reading while another writes
// must never find a half-written file.
function keep(open) {
  const temp = CARDS + '.' + process.pid
  writeFileSync(temp, JSON.stringify(open))
  renameSync(temp, CARDS)
}
const age = (s) => s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'
/** The Stop rules: no second look, a string answer whose last 400 code points hold a question mark, and no ring yet. */
function blocks() {
  let input
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return false
  }
  if (input === null || typeof input !== 'object' || input.stop_hook_active === true) return false
  const message = input.last_assistant_message
  if (typeof message !== 'string') return false
  const tail = [...message].slice(-400).join('')
  if (!tail.includes('?') && !tail.includes('\\uFF1F')) return false
  let calls = ''
  try {
    calls = readFileSync(REC, 'utf8')
  } catch {
    // No call recorded yet.
  }
  let rang = false
  for (const line of calls.split('\\n')) {
    if (line === '') continue
    const recorded = JSON.parse(line)
    // A turn's mark is no call.
    if (recorded.turn === 2) { if (recorded.kind !== 'relay') rang = false }
    else if (rings(recorded.argv)) rang = true
  }
  return !rang
}
const blocked = answer?.stop ? blocks() : undefined
const call = blocked === undefined ? { argv, code: 0 } : { argv, code: 0, blocked }
if (notify && done !== undefined) {
  const open = cards()
  call.closed = open.filter((card) => done === 'all' || card.id === done).map((card) => card.id)
  keep(open.filter((card) => !call.closed.includes(card.id)))
} else if (notify && list) {
  const now = Date.now()
  const open = cards().map((card) => ({ id: card.id, ageS: Math.floor((now - card.at) / 1000), kind: card.kind, line: card.line }))
  if (json && open.length > 0) console.log(JSON.stringify(open))
  else if (!json) for (const card of open) console.log(card.id + ' ' + age(card.ageS) + ' ' + card.kind + ' ' + card.line)
} else if (notify) {
  const kind = state ?? 'plain'
  const line = compose(text, kind)
  if (!line) {
    console.error(${JSON.stringify(NOTICE_USAGE)})
    call.code = 1
  } else if (${noDial}) {
    console.log(json ? JSON.stringify({ result: 'no dial' }) : 'no dial')
  } else {
    // A new other card replaces the other; a sixth waiting card drops the oldest. Either is recorded, so the grader
    // does not ask turn 2 to close a card turn 1 no longer had open.
    const before = cards()
    const open = before.filter((card) => kind === 'waiting' || card.kind === 'waiting')
    let id
    do id = randomBytes(4).toString('hex'); while (before.some((card) => card.id === id))
    open.push({ id, at: Date.now(), kind, line })
    const waiting = open.filter((card) => card.kind === 'waiting')
    if (waiting.length > 5) open.splice(open.indexOf(waiting[0]), 1)
    keep(open)
    call.id = id
    const dropped = before.filter((card) => !open.includes(card)).map((card) => card.id)
    if (dropped.length > 0) call.dropped = dropped
    console.log(json ? JSON.stringify({ result: 'shown', id }) : 'shown ' + id)
  }
} else if (answer?.stop) {
  if (blocked) process.stdout.write(answer.stdout ?? '')
} else if (answer) {
  process.stdout.write(answer.stdout ?? '')
  process.stderr.write(answer.stderr ?? '')
  call.code = answer.code ?? 0
} else {
  console.error('harness: not available here')
  call.code = 2
}
process.exitCode = call.code
appendFileSync(REC, JSON.stringify(call) + '\\n')
`
}
