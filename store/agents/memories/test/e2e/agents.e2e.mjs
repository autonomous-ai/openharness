#!/usr/bin/env node
/**
 * About You, end to end, through the real agents: does a new Claude Code session and a new Codex session
 * actually start knowing what About You says?
 *
 *   node --disable-warning=ExperimentalWarning test/e2e/agents.e2e.mjs [--keep]
 *
 * It needs `claude` and `codex` signed in on this computer and makes four short model calls. Nothing it
 * does touches the person's own settings: everything happens in a throwaway home.
 *
 *   1. A throwaway home gets an About You holding one random fact (a made-up project name no model can
 *      guess), and `mem deliver on` writes the Claude Code hook and the Codex AGENTS.md block there.
 *   2. Harness's own hook installer (cli/src/engines/hooks.ts, the code the daemon runs at start) is run
 *      on that home afterwards: our hook must survive it, and its hook must survive ours.
 *   3. Claude Code (`claude -p`, the throwaway settings only) and Codex (`codex exec`, CODEX_HOME in the
 *      throwaway home with a copy of the sign-in) are asked for the project's name. Each must answer it.
 *   4. The same questions with delivery off are the control: neither may answer it.
 *   5. `mem deliver off` must leave the files as Harness alone would have them.
 *
 * The copied Codex sign-in is deleted with the throwaway home, also when a step fails.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deliver, status } from '../../lib/deliver.mjs'
import { writeAbout } from '../../lib/about.mjs'

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_CLI = join(PACKAGE, '..', '..', '..', 'cli')
const keep = process.argv.includes('--keep')
const root = mkdtempSync(join(tmpdir(), 'memories-e2e-'))
const home = join(root, 'home')
const work = join(root, 'work')
const env = { MEMORIES_HOME: join(home, '.harness', 'memory') }
const canary = `kestrel-${randomBytes(3).toString('hex')}`
const question = 'What is the code name of my test project? Answer with only the code name, or the word "unknown" if you do not know it. Do not run any tools.'
const report = { canary, steps: [] }
const step = (name, ok, detail = '') => { report.steps.push({ name, ok, detail }); console.log(`${ok === 'skip' ? 'SKIP' : ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, ...options })
  return { code: result.status, out: `${result.stdout ?? ''}`, err: `${result.stderr ?? ''}`.slice(-2000) }
}

/** Harness's real installer, the one the daemon runs at start, on the throwaway Claude Code home. */
function harnessInstalls() {
  const script = `import('./src/engines/hooks.ts').then(({ engineHooks }) => engineHooks.claude.installIn(18999, ${JSON.stringify(join(home, '.claude'))}))`
  return run('npx', ['tsx', '--eval', script], { cwd: REPO_CLI, env: { ...process.env, HOME: home, ADAPTER_DATA_DIR: join(root, 'harness-data'), CLAUDE_CONFIG_DIR: join(home, '.claude') } })
}

function askClaude(withDelivery) {
  // --no-session-persistence: the test's question must not land in the person's own history, where
  // `mem asks` would later read it as something they said.
  const args = ['-p', '--no-session-persistence', '--setting-sources', 'project', '--output-format', 'text']
  if (withDelivery) args.push('--settings', join(home, '.claude', 'settings.json'))
  args.push(question)
  return run('claude', args, { cwd: work })
}

/** What Codex would send its model for this question, without calling it: proof of what it reads. */
function codexInput(codexHome) {
  return run('codex', ['debug', 'prompt-input', question], { cwd: work, env: { ...process.env, CODEX_HOME: codexHome } })
}

/**
 * A real Codex answer: the signed-in account first; when that account is out of usage, the local
 * gpt-oss model through Ollama (`codex exec --oss`), which reads the same AGENTS.md.
 */
let codexLocal = false
function askCodex(codexHome) {
  const once = (extra) => {
    const out = join(root, `codex-${randomBytes(3).toString('hex')}.txt`)
    const result = run('codex', ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', ...extra, '-C', work, '-o', out, question], { cwd: work, env: { ...process.env, CODEX_HOME: codexHome } })
    return { ...result, answer: existsSync(out) ? readFileSync(out, 'utf8') : '' }
  }
  if (!codexLocal) {
    const hosted = once([])
    if (!/usage limit|rate limit|quota/i.test(hosted.err + hosted.out)) return { ...hosted, model: 'account' }
    codexLocal = true
  }
  return { ...once(['--oss', '--local-provider', 'ollama', '-m', 'gpt-oss:20b']), model: 'gpt-oss:20b (local)' }
}

// The copied Codex sign-in never outlives the run: not on a failure, not on Ctrl-C, not with --keep.
const forgetSignIn = () => { for (const dir of [join(home, '.codex'), join(root, 'codex-bare')]) rmSync(join(dir, 'auth.json'), { force: true }) }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { forgetSignIn(); if (!keep) rmSync(root, { recursive: true, force: true }); process.exit(130) })

try {
  for (const dir of [join(home, '.claude'), join(home, '.codex'), work]) mkdirSync(dir, { recursive: true })
  const auth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
  if (existsSync(auth)) copyFileSync(auth, join(home, '.codex', 'auth.json'))

  writeAbout(env.MEMORIES_HOME, `# About you\n\n## How you work\n- Calls their test project ${canary}. [asks:1]\n- Wants short answers. [asks:3]\n`)

  // 1–2. Harness installs its hook first (as at daemon start), then delivery, then Harness again.
  const first = harnessInstalls()
  step('Harness installs its own Claude Code hooks in the throwaway home', first.code === 0, first.code ? first.err : '')
  const on = deliver('on', { env, home })
  step('mem deliver on writes the Claude Code hook and the Codex block', on.results.every((r) => r.ok), on.results.map((r) => `${r.agent}:${r.changed ? 'added' : r.error ?? 'unchanged'}`).join(' '))
  const again = harnessInstalls()
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
  const starts = (settings.hooks?.SessionStart ?? []).map((block) => block.hooks?.[0]?.command ?? '')
  step('after Harness reinstalls, both hooks are there once each', again.code === 0 && starts.filter((c) => c.includes('notify.mjs')).length === 1 && starts.filter((c) => c.includes('harness-memories-about-you')).length === 1, `${starts.length} SessionStart blocks`)
  step('status: every copy current', status({ env, home }).agents.every((a) => a.delivered && a.current))

  // 3. The real agents.
  const claudeOn = askClaude(true)
  step('Claude Code knows it with delivery on', claudeOn.out.includes(canary), JSON.stringify(claudeOn.out.trim().slice(0, 160)) + (claudeOn.code ? ` exit ${claudeOn.code}: ${claudeOn.err}` : ''))
  const claudeOff = askClaude(false)
  step('Claude Code does not know it without (control)', claudeOff.code === 0 && !claudeOff.out.includes(canary), JSON.stringify(claudeOff.out.trim().slice(0, 160)))
  const bare = join(root, 'codex-bare')
  mkdirSync(bare, { recursive: true })
  if (existsSync(join(home, '.codex', 'auth.json'))) copyFileSync(join(home, '.codex', 'auth.json'), join(bare, 'auth.json'))
  const inputOn = codexInput(join(home, '.codex'))
  step('Codex puts it in the model\'s input with delivery on', inputOn.code === 0 && inputOn.out.includes(canary) && inputOn.out.includes('Harness Memories'), inputOn.code ? inputOn.err : `${inputOn.out.length} bytes of input`)
  const inputOff = codexInput(bare)
  step('Codex does not without (control)', inputOff.code === 0 && !inputOff.out.includes(canary))
  // A model that cannot be reached is not an answer either way: the step is skipped, with why.
  const unreachable = (result) => result.code !== 0 && !result.answer && /usage limit|rate limit|quota|error loading model|llama-server|connection refused|not found/i.test(result.err)
  const codexOn = askCodex(join(home, '.codex'))
  if (unreachable(codexOn)) step('Codex answers with delivery on', 'skip', `no model reachable: ${codexOn.err.trim().split('\n').filter((line) => /error/i.test(line)).pop()?.slice(0, 200)}`)
  else {
    step(`Codex knows it with delivery on (${codexOn.model})`, codexOn.answer.includes(canary), JSON.stringify(codexOn.answer.trim().slice(0, 160)) + (codexOn.code ? ` exit ${codexOn.code}: ${codexOn.err.slice(-300)}` : ''))
    const codexOff = askCodex(bare)
    step(`Codex does not know it without (control, ${codexOff.model})`, codexOff.code === 0 && !codexOff.answer.includes(canary), JSON.stringify(codexOff.answer.trim().slice(0, 160)))
  }

  // 5. Off.
  deliver('off', { env, home })
  const after = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
  const left = (after.hooks?.SessionStart ?? []).map((block) => block.hooks?.[0]?.command ?? '')
  step('mem deliver off removes ours and keeps Harness\'s', left.length === 1 && left[0].includes('notify.mjs') && !existsSync(join(home, '.codex', 'AGENTS.md')))
} catch (error) {
  step('the run itself', false, error instanceof Error ? error.stack : String(error))
} finally {
  forgetSignIn()
  if (keep) console.log(`kept ${root} (without the copied Codex sign-in)`)
  else rmSync(root, { recursive: true, force: true })
}
const failed = report.steps.filter((s) => !s.ok).length
const skipped = report.steps.filter((s) => s.ok === 'skip').length
console.log(`${report.steps.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`)
process.exitCode = failed ? 1 : 0
