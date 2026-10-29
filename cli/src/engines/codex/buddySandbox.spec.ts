import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PERMISSION_MODES } from '../../lib/engineLaunch.js'

/**
 * A Codex Buddy launched with full permissions could push and open pull requests with its person's own GitHub login
 * (Lead, 10-29: Buddies were on in a Swarm that morning). It now launches in the sandbox its mode names, asking before
 * anything outside it. This runs commands in that sandbox with the real Codex (`codex sandbox`), without a model or an
 * approval: what it refuses is refused before anyone could be asked. A throwaway CODEX_HOME, never the person's.
 */
const hasCodex = (() => { try { execFileSync('codex', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()
const hasGh = (() => { try { execFileSync('gh', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

const buddyFlags = PERMISSION_MODES.codex!.readOnlyAsk ?? []
const sandboxMode = buddyFlags[buddyFlags.indexOf('--sandbox') + 1]

interface Run { status: number | null; output: string }
function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, output }))
  })
}

describe.skipIf(!hasCodex)('the sandbox a Codex Buddy launches in, with the real Codex', () => {
  let root: string, repo: string, remote: string, env: NodeJS.ProcessEnv, server: Server, url: string
  const received: string[] = []
  const sandboxed = (...command: string[]) =>
    run('codex', ['sandbox', '-c', `sandbox_mode=${JSON.stringify(sandboxMode)}`, '--', ...command], repo, env)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim()

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'buddy-sandbox-'))
    repo = join(root, 'repo'); remote = join(root, 'remote.git')
    mkdirSync(join(root, 'codex-home')); mkdirSync(join(root, 'gh-config')); mkdirSync(repo)
    env = { ...process.env, CODEX_HOME: join(root, 'codex-home'), GH_CONFIG_DIR: join(root, 'gh-config'), GH_TOKEN: 'not-a-token',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'notes.txt'), 'first\n')
    git('add', 'notes.txt'); git('commit', '-qm', 'first commit')
    execFileSync('git', ['init', '-q', '--bare', remote], { env })
    git('remote', 'add', 'origin', remote)
    server = createServer((request, response) => { received.push(`${request.method} ${request.url}`); response.end('ok') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/write`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  it('is the read-only sandbox', () => {
    expect(sandboxMode).toBe('read-only')
  })

  it('takes the mode\'s own config overrides (approvals to the person, never Codex\'s reviewer)', async () => {
    const overrides = buddyFlags.flatMap((flag, i) => buddyFlags[i - 1] === '-c' ? ['-c', flag] : [])
    expect(overrides).toEqual(['-c', 'approvals_reviewer="user"'])
    const taken = await run('codex', ['sandbox', ...overrides, '--', 'echo', 'ran'], repo, env)
    expect([taken.status, taken.output.trim()]).toEqual([0, 'ran'])
  })

  it('sends approvals to the person even when their config.toml picks Codex\'s own reviewer (security re-check of #2087)', async () => {
    // What the model is told about escalations, rendered by Codex itself: the person's config.toml says auto_review, and
    // the Buddy's launch overrides it. The mode's --ask-for-approval and --sandbox are the same settings as config keys.
    const home = join(root, 'auto-review-home')
    mkdirSync(home)
    writeFileSync(join(home, 'config.toml'), 'approvals_reviewer = "auto_review"\n')
    const launch = ['-c', `approval_policy="${buddyFlags[buddyFlags.indexOf('--ask-for-approval') + 1]}"`, '-c', `sandbox_mode="${sandboxMode}"`]
    const render = (...overrides: string[]) => run('codex', ['debug', 'prompt-input', ...launch, ...overrides], repo, { ...env, CODEX_HOME: home })
    const theirs = await render()
    expect(theirs.status).toBe(0)
    expect(theirs.output).toContain('`approvals_reviewer` is `auto_review`')
    const buddy = await render(...buddyFlags.flatMap((flag, i) => buddyFlags[i - 1] === '-c' ? ['-c', flag] : []))
    expect(buddy.status).toBe(0)
    expect(buddy.output).not.toContain('auto_review')
    expect(buddy.output).toContain('Commands are run outside the sandbox if they are approved by the user')
  })

  it('reads the code and its history', async () => {
    const log = await sandboxed('git', 'log', '--oneline')
    expect([log.status, log.output]).toEqual([0, expect.stringContaining('first commit')])
    const grep = await sandboxed('git', 'grep', '-n', 'first')
    expect([grep.status, grep.output]).toEqual([0, expect.stringContaining('notes.txt:1:first')])
  })

  it('cannot push', async () => {
    const push = await sandboxed('git', 'push', 'origin', 'HEAD:main')
    expect(push.status).not.toBe(0)
    expect(execFileSync('git', ['--git-dir', remote, 'for-each-ref'], { env, encoding: 'utf8' })).toBe('')
  })

  it.each([
    ['a shell redirect', ['sh', '-c', 'echo changed > notes.txt']],
    ['tee', ['sh', '-c', 'echo changed | tee notes.txt']],
    ['sed -i', process.platform === 'darwin' ? ['sed', '-i', '', 's/first/changed/', 'notes.txt'] : ['sed', '-i', 's/first/changed/', 'notes.txt']],
    ['a new file', ['sh', '-c', 'echo new > created.txt']],
  ])('cannot write a file with %s', async (_, command) => {
    const write = await sandboxed(...command)
    expect(write.status).not.toBe(0)
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('first\n')
    expect(() => readFileSync(join(repo, 'created.txt'))).toThrow()
  })

  it('cannot POST, even to this computer', async () => {
    // Outside the sandbox the same request lands, so a refusal inside it is the sandbox's.
    const outside = await run('curl', ['-sS', '-X', 'POST', '-d', 'x', url], repo, env)
    expect([outside.status, received]).toEqual([0, ['POST /write']])
    const inside = await sandboxed('curl', '-sS', '-X', 'POST', '-d', 'x', url)
    expect(inside.status).not.toBe(0)
    expect(received).toEqual(['POST /write'])
  })

  it.skipIf(!hasGh).each([
    ['gh pr create', ['gh', 'pr', 'create', '--repo', 'example/example', '--title', 't', '--body', 'b', '--head', 'main']],
    ['gh issue comment', ['gh', 'issue', 'comment', '1', '--repo', 'example/example', '--body', 'b']],
  ])('cannot reach GitHub for %s', async (_, command) => {
    const write = await sandboxed(...command)
    expect(write.status).not.toBe(0)
    expect(write.output).toMatch(/error connecting to api\.github\.com/)
  })
})
