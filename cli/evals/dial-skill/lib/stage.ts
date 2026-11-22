import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { DIAL_SKILL, skillsFolderOf, writeSkill } from '../../../src/devices/dialSkill.js'
import { composeNotice, parseNotice } from '../../../src/lib/dialNotice.js'
import { deniedReads, spawnGroup } from './agents.js'
import type { AgentKind, Scenario } from './scenarios.js'

/** One `harness` call the agent made; `line` is what the dial would show, null for anything but a `device notify` the
 *  CLI would send. */
export interface Ring {
  argv: string[]
  line: string | null
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
}

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

export function stage(s: Scenario, agent: AgentKind, opts: { skill: boolean; base?: string }): Staged {
  const profile = process.env.CLAUDE_CONFIG_DIR
  // Unset, Claude would run in the default ~/.claude profile.
  if (agent === 'claude' && !profile) throw new Error('CLAUDE_CONFIG_DIR is not set: the eval runs Claude only in the session profile')

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

  try {
    // Inside a work tree, the agent would load that repo's AGENTS.md and CLAUDE.md, and could reach the answer key.
    if (insideGit(base, env)) throw new Error(`${base} is inside a git work tree`)

    mkdirSync(join(root, 'rec'), { recursive: true })
    mkdirSync(env.TMPDIR!)
    mkdirSync(env.ZDOTDIR!)
    cpSync(join(s.dir, 'repo'), repo, { recursive: true })
    // Copied rather than put on PATH where they are: a path into the scenario folder leads to its scenario.json.
    if (existsSync(join(s.dir, 'bin'))) cpSync(join(s.dir, 'bin'), bin, { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'harness'), fakeHarness(recFile), { mode: 0o755 })
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
      const skills = skillsFolderOf(join(repo, '.claude'), true)
      const result = skills ? writeSkill(skills) : 'no skills folder'
      if (result !== 'written') throw new Error(`dial skill not staged: ${result}`)
      skill = DIAL_SKILL
    }
    return { root, repo, recFile, origin, env, skill }
  } catch (error) {
    // A failed stage leaves no run root, and its error goes to errors.jsonl: no temp path, no user name.
    rmSync(root, { recursive: true, force: true })
    throw Object.assign(error as Error, { message: scrub((error as Error).message, { root }) })
  }
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
  return text.split('\n').filter((line) => line !== '').map((line) => ringOf((JSON.parse(line) as { argv: string[] }).argv))
}

/** One recorded call, its line composed as the CLI composes it, so the grader reads the flags and the line the dial
 *  would have shown. */
export function ringOf(argv: string[]): Ring {
  const notify = argv[0] === 'device' && argv[1] === 'notify'
  const { question, suggest, state } = parseNotice(argv.slice(2))
  return { argv, line: notify ? (composeNotice(question, suggest, state) || null) : null }
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

export function unstage(st: Staged): void {
  try {
    rmSync(st.root, { recursive: true, force: true })
  } finally {
    // In the person's profile, so it goes even when the run root does not.
    const profile = st.env.CLAUDE_CONFIG_DIR
    // `claude -p` makes <profile>/projects/<repo>/memory/ even with no session saved. The run's own folder goes with it,
    // named exactly as Claude Code names it (every character but a letter or digit made '-'), never by a pattern, so
    // nothing else in the person's profile is touched.
    if (profile) rmSync(join(profile, 'projects', st.repo.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true })
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
const NOTICE_USAGE = 'harness device notify "<question>" [--suggest "<recommendation>"] [--waiting|--proceeding] [--json]  for an agent: ring the dial when it needs the person to decide or act'

/** Never the real dial: it records the call and answers as a dial that showed the line. A notify with no question
 *  answers as the CLI does: parseNotice's words left after the flags, none when they are only `--help` or `-h`, cleaned
 *  as composeNotice cleans them (the fake runs under plain node, which cannot load dialNotice.ts). */
function fakeHarness(recFile: string): string {
  return `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const argv = process.argv.slice(2)
const notify = argv[0] === 'device' && argv[1] === 'notify'
appendFileSync(${JSON.stringify(recFile)}, JSON.stringify({ argv }) + '\\n')
const question = []
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--suggest') i++
  else if (!['--waiting', '--proceeding', '--json'].includes(argv[i])) question.push(argv[i])
}
const text = question.join(' ')
if (notify && (text === '--help' || text === '-h' || text.replace(/[\\p{Cc}\\s]+/gu, ' ').trim() === '')) {
  console.error(${JSON.stringify(NOTICE_USAGE)})
  process.exitCode = 1
} else if (notify) {
  console.log('shown')
} else {
  console.error('harness: not available here')
  process.exitCode = 2
}
`
}
