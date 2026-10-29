import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PERMISSION_MODES } from './engineLaunch.js'
import { prepareSwarmSkill } from './swarmSkills.js'

/**
 * A Buddy's folder, as Harness prepares it, driven through the real Claude Code with the flags a Buddy launches with. A
 * local stand-in for the model API asks for each tool call in turn and reads back what Claude Code answered, so what is
 * allowed and what is refused is Claude Code's own doing with the guard, not the guard's alone (lib/buddyGuard.spec.ts).
 * In print mode a call that would wait for a prompt is refused instead, so this proves the decisions; dontAsk is what
 * keeps the interactive session from asking.
 *
 * The throwaway user settings allow pushing, gh, echo, sed, curl and editing and turn hooks off, as a person's own may:
 * the guard is what refuses, where dontAsk alone would honour those rules.
 *
 * Nothing of the person's: a throwaway HOME and CLAUDE_CONFIG_DIR, a made-up API key and stand-ins for gh and harness on
 * PATH that only record that they ran. It never signs anything in or out.
 */
// Found on this PATH before the run's own PATH replaces it.
const claudeBin = (() => { try { return execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim() || null } catch { return null } })()
const hasClaude = claudeBin !== null

interface Call { name: string; input: Record<string, unknown> }
interface Result { is_error?: boolean; content: string }

/** Answers Claude Code's requests in the Messages API's streaming shape: each tool call in turn, then "done". */
function fakeModel(calls: Call[]) {
  const results = new Map<string, Result>()
  let step = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":1}'); return
      }
      const json = JSON.parse(body || '{}')
      const last = json.messages?.at(-1)
      for (const block of Array.isArray(last?.content) ? last.content : []) {
        if (block.type !== 'tool_result') continue
        const content = typeof block.content === 'string' ? block.content
          : (block.content as { text?: string }[]).map((part) => part.text ?? '').join('')
        results.set(block.tool_use_id, { is_error: block.is_error, content })
      }
      // Only the conversation itself has tools; Claude Code's own side requests (a title, a summary) get plain text.
      const main = Array.isArray(json.tools) && json.tools.length > 0
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message: { id: `msg_${step}`, type: 'message', role: 'assistant', model: json.model,
        content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
      if (main && step < calls.length) {
        const call = calls[step++]
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${step}`, name: call.name, input: {} } })
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } })
      } else {
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      }
      send('message_stop', { type: 'message_stop' })
      response.end()
    })
  })
  return { server, results, id: (call: Call) => `toolu_${calls.indexOf(call) + 1}` }
}

describe.skipIf(!hasClaude)('a Buddy\'s folder with the real Claude Code', () => {
  let root: string, folder: string, remote: string, bin: string, ran: string, posts: string[], sinkPath: string
  let api: ReturnType<typeof fakeModel>, sink: Server, stdout = ''
  const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()
  const bash = (command: string): Call => ({ name: 'Bash', input: { command, description: 'step' } })

  const allowed = {
    gitLog: bash('git log --oneline'),
    gitGrep: bash('git grep -n first'),
    ghIssueView: bash('gh issue view 7 --comments'),
    post: bash("harness super-tab --tab t post chat 'hello; nothing > here' op-1"),
    read: { name: 'Read', input: { file_path: '' } } as Call,
  }
  const refused = {
    gitPush: bash('git push origin HEAD:main'),
    ghPrCreate: bash('gh pr create --title t --body b'),
    ghIssueComment: bash('gh issue comment 7 --body b'),
    redirect: bash('echo changed > notes.txt'),
    tee: bash('echo changed | tee notes.txt'),
    sedInPlace: bash(process.platform === 'darwin' ? "sed -i '' s/first/changed/ notes.txt" : 'sed -i s/first/changed/ notes.txt'),
    curlPost: bash(''),
    joined: bash('git log && git push origin HEAD:main'),
    harnessNew: bash('harness new codex'),
    write: { name: 'Write', input: { file_path: '', content: 'x' } } as Call,
    edit: { name: 'Edit', input: { file_path: '', old_string: 'first', new_string: 'changed' } } as Call,
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'buddy-claude-'))
    folder = join(root, 'buddy'); remote = join(root, 'remote.git'); bin = join(root, 'bin'); ran = join(root, 'ran')
    for (const dir of [folder, bin, ran, join(root, 'home'), join(root, 'config')]) mkdirSync(dir)
    git('init', '-q', '-b', 'main')
    writeFileSync(join(folder, 'notes.txt'), 'first\n')
    git('add', 'notes.txt'); git('commit', '-qm', 'first commit')
    execFileSync('git', ['init', '-q', '--bare', remote])
    git('remote', 'add', 'origin', remote)
    // Stand-ins that only say they ran, with what.
    for (const name of ['gh', 'harness']) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(ran, name)}'\necho ${name}-ran\n`)
      chmodSync(join(bin, name), 0o755)
    }
    // The person's own settings may allow what a Buddy must not run, and turn hooks off: the folder's outrank them.
    writeFileSync(join(root, 'config', 'settings.json'), JSON.stringify({ disableAllHooks: true, permissions: {
      allow: ['Bash(git push:*)', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(echo:*)', 'Bash(sed:*)', 'Bash(curl:*)', 'Bash(harness:*)', 'Edit', 'Write'] } }))
    prepareSwarmSkill(folder, { role: 'buddy', key: 'session' })
    allowed.read.input.file_path = join(folder, 'notes.txt')
    refused.write.input.file_path = join(folder, 'created.txt')
    refused.edit.input.file_path = join(folder, 'notes.txt')

    posts = []
    sink = createServer((request, response) => { posts.push(`${request.method} ${request.url}`); response.end('ok') })
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
    // A path of this run's own: a request from an earlier run's Claude Code, outliving it, once reached a port reused here.
    sinkPath = `/write-${randomUUID()}`
    refused.curlPost.input.command = `curl -sS -X POST -d x http://127.0.0.1:${(sink.address() as AddressInfo).port}${sinkPath}`

    api = fakeModel([...Object.values(allowed), ...Object.values(refused)])
    await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`, HOME: join(root, 'home'), SHELL: '/bin/bash',
      CLAUDE_CONFIG_DIR: join(root, 'config'), ANTHROPIC_API_KEY: 'sk-ant-not-a-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`,
      GIT_CONFIG_GLOBAL: '/dev/null', DISABLE_AUTOUPDATER: '1', TMPDIR: root,
    }
    const claude = spawn(claudeBin!, ['-p', 'go', ...PERMISSION_MODES.claude!.dontAsk, '--model', 'claude-sonnet-4-5', '--output-format', 'json'],
      { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] })
    claude.stdout.on('data', (chunk) => { stdout += chunk })
    await new Promise<void>((resolve, reject) => { claude.on('error', reject); claude.on('close', () => resolve()) })
  }, 180_000)
  afterAll(async () => {
    await new Promise<void>((resolve) => api?.server.close(() => resolve()))
    await new Promise<void>((resolve) => sink?.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  it('finished the conversation, every call answered', () => {
    expect(JSON.parse(stdout).result).toBe('done')
    expect(api.results.size).toBe(Object.keys(allowed).length + Object.keys(refused).length)
  })

  it('runs git log, git grep, gh issue view, its Super Tab post and Read', () => {
    expect(api.results.get(api.id(allowed.gitLog))).toEqual({ is_error: false, content: expect.stringContaining('first commit') })
    expect(api.results.get(api.id(allowed.gitGrep))).toEqual({ is_error: false, content: expect.stringContaining('notes.txt:1:first') })
    expect(api.results.get(api.id(allowed.ghIssueView))).toEqual({ is_error: false, content: expect.stringContaining('gh-ran') })
    expect(api.results.get(api.id(allowed.post))).toEqual({ is_error: false, content: expect.stringContaining('harness-ran') })
    expect(api.results.get(api.id(allowed.read))?.content).toContain('first')
    expect(readFileSync(join(ran, 'gh'), 'utf8')).toBe('issue view 7 --comments\n')
    expect(readFileSync(join(ran, 'harness'), 'utf8')).toBe('super-tab --tab t post chat hello; nothing > here op-1\n')
  })

  it.each(Object.keys(refused))('refuses %s, and it never ran', (name) => {
    const result = api.results.get(api.id(refused[name as keyof typeof refused]))
    expect(result?.is_error).toBe(true)
  })

  it('pushed nothing', () => {
    expect(execFileSync('git', ['--git-dir', remote, 'for-each-ref'], { encoding: 'utf8' })).toBe('')
  })
  it('opened no pull request, wrote no comment and started no agent', () => {
    expect(readFileSync(join(ran, 'gh'), 'utf8')).not.toMatch(/^(pr create|issue comment)/m)
    expect(readFileSync(join(ran, 'harness'), 'utf8')).not.toContain('new codex')
  })
  it('wrote no file', () => {
    expect(readFileSync(join(folder, 'notes.txt'), 'utf8')).toBe('first\n')
    expect(existsSync(join(folder, 'created.txt'))).toBe(false)
    expect(readdirSync(folder).sort()).toEqual(['.claude', '.git', '.harness', 'notes.txt'])
  })
  it('POSTed nothing', () => {
    expect(posts.filter((post) => post.includes(sinkPath))).toEqual([])
  })

  it('tells the agent why a Bash call was refused', () => {
    expect(api.results.get(api.id(refused.gitPush))?.content).toContain('A Buddy only reads')
  })
})
