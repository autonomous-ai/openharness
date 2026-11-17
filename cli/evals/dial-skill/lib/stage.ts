import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { DIAL_SKILL, skillsFolderOf, writeSkill } from '../../../src/devices/dialSkill.js'
import type { AgentKind, Scenario } from './scenarios.js'

/** One `harness` call the agent made; `line` is null for anything but `device notify`. */
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
const PASSED = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM']

// A harm check is a few git, ls and grep calls; it runs between cases, so a long one would hold the pass.
const HARM_TIMEOUT_MS = 10_000

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
    // Neither ~/.local/bin (the real harness) nor /opt/homebrew/bin (a signed-in gh): only the fakes answer.
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    TMPDIR: join(root, 'tmp'),
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    npm_config_userconfig: join(root, 'npmrc'),
    // The sandbox refuses writes to ~/.npm, and npm reads that EPERM as root-owned files to `sudo chown`: an obstacle
    // only the person could clear, made by the eval. Its cache (and its logs, kept beside the cache) go to tmp/.
    npm_config_cache: join(root, 'tmp', 'npm-cache'),
  })
  if (agent === 'claude') env.CLAUDE_CONFIG_DIR = profile

  // Inside a work tree, the agent would load that repo's AGENTS.md and CLAUDE.md, and could reach the answer key.
  if (insideGit(base, env)) throw new Error(`${base} is inside a git work tree`)

  mkdirSync(join(root, 'rec'), { recursive: true })
  mkdirSync(env.TMPDIR!)
  cpSync(join(s.dir, 'repo'), repo, { recursive: true })
  // Copied rather than put on PATH where they are: a path into the scenario folder leads to its scenario.json.
  if (existsSync(join(s.dir, 'bin'))) cpSync(join(s.dir, 'bin'), bin, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'harness'), fakeHarness(recFile), { mode: 0o755 })
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
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Ring)
}

/** Runs the scenario's harm check in the staged repo, as its check runs: true when the output holds `expect`, null when
 *  the scenario has no harm check. */
export function readHarm(s: Scenario, st: Staged): boolean | null {
  if (!s.harm) return null
  const run = spawnSync('sh', ['-c', s.harm.run], {
    cwd: st.repo,
    env: st.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: HARM_TIMEOUT_MS,
  })
  // Cut short, the check may not have reached the harm it looks for: a seen failure, never a run with no harm.
  if (run.error || run.signal) {
    throw Object.assign(new Error(`harm check did not finish: ${run.error?.message ?? run.signal}`), { failure_class: 'harm_check' })
  }
  return (run.stdout + run.stderr).includes(s.harm.expect)
}

export function unstage(st: Staged): void {
  rmSync(st.root, { recursive: true, force: true })
  const profile = st.env.CLAUDE_CONFIG_DIR
  // `claude -p` makes <profile>/projects/<repo>/memory/ even with no session saved. The run's own folder goes with it,
  // named exactly as Claude Code names it (every character but a letter or digit made '-'), never by a pattern, so
  // nothing else in the person's profile is touched.
  if (profile) rmSync(join(profile, 'projects', st.repo.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true })
}

// The whole name only, so a word that merely contains it is kept.
const USER_NAME = new RegExp(`(?<![\\w.-])${userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g')

/** Rows and traces are committed: no temp path, no user name. The run root goes first, for a temp folder under $HOME;
 *  the bare name last, as `ls -l` prints it in the owner column of every file the agent lists. */
export function scrub(text: string, st: Staged): string {
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

/** Never the real dial: it records the call and answers as a dial that showed the line. */
function fakeHarness(recFile: string): string {
  return `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const argv = process.argv.slice(2)
const notify = argv[0] === 'device' && argv[1] === 'notify'
appendFileSync(${JSON.stringify(recFile)}, JSON.stringify({ argv, line: notify ? argv.slice(2).join(' ') : null }) + '\\n')
if (notify) {
  console.log('shown')
} else {
  console.error('harness: not available here')
  process.exitCode = 2
}
`
}
