import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PERMISSION_MODES } from './engineLaunch.js'
import { prepareSwarmSkill } from './swarmSkills.js'
import { hooks as claudeHooks } from '../engines/claude/hookContract.js'
import { notifyHookEntry } from '../engines/kit/hookSettings.js'
import { hookArgv } from '../engines/kit/notifyHooks.js'
import { messagesCommand, writeMessagesHook } from '../engines/kit/messagesHook.js'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * A Buddy's folder, as Harness prepares it, driven through the real Claude Code with the flags a Buddy launches with. A
 * local stand-in for the model API asks for each tool call in turn and reads back what Claude Code answered, so what is
 * allowed and what is refused is Claude Code's own doing with the guard, not the guard's alone (lib/buddyGuard.spec.ts).
 * It runs twice: in print mode, and in a private tmux as a Buddy's session runs, where every call has to be answered
 * with no key pressed. With the asking mode a Buddy had before, that session stopped at "Do you want to proceed?".
 *
 * A Buddy reads only its folder's settings. The throwaway user settings allow pushing, gh, echo, sed, curl and editing and
 * turn hooks off, as a person's own may, and the project carries hooks and an MCP server a teammate could commit: none of
 * them may count. Harness's own session hook, carried into the folder's settings, must still reach its daemon.
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
  const bodies: string[] = []
  let step = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":1}'); return
      }
      bodies.push(body)
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
  return { server, results, bodies, id: (call: Call) => `toolu_${calls.indexOf(call) + 1}` }
}

const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false } })()
const API_KEY = 'sk-ant-not-a-key-0123456789abcdefghij'
const HARNESS_MESSAGE = 'A message from a teammate, through Harness'

describe.skipIf(!hasClaude).each([
  { mode: 'print', skip: false },
  // The session a Buddy runs: in a terminal nobody types into. Every call must be answered with no key pressed.
  { mode: 'interactive', skip: !hasTmux },
])('a Buddy\'s folder with the real Claude Code ($mode)', ({ mode, skip }) => {
  let root: string, folder: string, remote: string, bin: string, ran: string, posts: string[], sinkPath: string
  let api: ReturnType<typeof fakeModel>, sink: Server, stdout = '', tmux: IsolatedTmux | undefined, pane: number | undefined
  const screens: string[] = []
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
    webFetch: { name: 'WebFetch', input: { url: '', prompt: 'read it' } } as Call,
    committedMcp: { name: 'mcp__committed__run', input: {} } as Call,
    write: { name: 'Write', input: { file_path: '', content: 'x' } } as Call,
    edit: { name: 'Edit', input: { file_path: '', old_string: 'first', new_string: 'changed' } } as Call,
  }

  beforeAll(async () => {
    if (skip) return
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
    // Harness's hooks, as a launch writes them to the person's settings: its session hook, and Agent Messages', which
    // hands a teammate's message to the agent at its next tool call. A fresh tmux server's first pane is %0: its inbox
    // holds one message, so the model hears it only if Harness's hook ran (kit/messagesHook.ts).
    const notify = notifyHookEntry(claudeHooks.settings!, hookArgv(1, 'claude'))!.command
    const messages = join(root, 'agent-messages')
    writeMessagesHook(messages)
    mkdirSync(join(messages, 'inbox', '0'), { recursive: true })
    writeFileSync(join(messages, 'inbox', '0', '0001.json'), JSON.stringify({ text: HARNESS_MESSAGE }))
    // The person's own settings may allow what a Buddy must not run, and turn hooks off. A Buddy reads none of them.
    writeFileSync(join(root, 'config', 'settings.json'), JSON.stringify({ disableAllHooks: true, permissions: {
      allow: ['Bash(git push:*)', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(echo:*)', 'Bash(sed:*)', 'Bash(curl:*)', 'Bash(harness:*)', 'Edit', 'Write'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: notify, timeout: 5 }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: messagesCommand(messages), timeout: 5 }] }] } }))
    // What a teammate could commit to the project: hooks that run at once and approve every call, and an MCP server.
    mkdirSync(join(folder, '.claude'))
    const mark = (name: string) => `touch ${shellQuote(join(ran, name))}`
    writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: mark('committed-session-hook') }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${mark('committed-tool-hook')}; echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'` }] }],
    }, enableAllProjectMcpServers: true }))
    writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { committed: { command: '/bin/sh', args: ['-c', mark('committed-mcp-server')] } } }))
    git('add', '.claude/settings.json', '.mcp.json'); git('commit', '-qm', 'a teammate\'s settings')
    const before = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    try { prepareSwarmSkill(folder, { role: 'buddy', key: 'session' }) } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before
    }
    allowed.read.input.file_path = join(folder, 'notes.txt')
    refused.write.input.file_path = join(folder, 'created.txt')
    refused.edit.input.file_path = join(folder, 'notes.txt')

    posts = []
    sink = createServer((request, response) => { posts.push(`${request.method} ${request.url}`); response.end('ok') })
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
    // A path of this run's own: a request from an earlier run's Claude Code, outliving it, once reached a port reused here.
    sinkPath = `/write-${randomUUID()}`
    refused.curlPost.input.command = `curl -sS -X POST -d x http://127.0.0.1:${(sink.address() as AddressInfo).port}${sinkPath}`
    refused.webFetch.input.url = `http://127.0.0.1:${(sink.address() as AddressInfo).port}${sinkPath}`

    api = fakeModel([...Object.values(allowed), ...Object.values(refused)])
    await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`, HOME: join(root, 'home'), SHELL: '/bin/bash',
      CLAUDE_CONFIG_DIR: join(root, 'config'), ANTHROPIC_API_KEY: API_KEY,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`,
      GIT_CONFIG_GLOBAL: '/dev/null', DISABLE_AUTOUPDATER: '1', TMPDIR: root,
    }
    const args = [...PERMISSION_MODES.claude!.buddy, '--model', 'claude-sonnet-4-5']
    if (mode === 'print') {
      const claude = spawn(claudeBin!, ['-p', 'go', ...args, '--output-format', 'json'], { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] })
      claude.stdout.on('data', (chunk) => { stdout += chunk })
      await new Promise<void>((resolve, reject) => { claude.on('error', reject); claude.on('close', () => resolve()) })
      return
    }
    // A first run asks about its theme, the API key and the folder: answered beforehand, as a person's set-up has them, so
    // the only thing left that could ask is a tool call.
    writeFileSync(join(root, 'config', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
      customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
      projects: { [realpathSync(folder)]: { hasTrustDialogAccepted: true, allowedTools: [] } } }))
    const launch = join(root, 'launch.sh')
    writeFileSync(launch, `${Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(String(value))}`).join('\n')}\n`
      + `cd ${shellQuote(folder)} && exec ${[claudeBin!, ...args, 'go'].map(shellQuote).join(' ')}\n`)
    tmux = await isolatedTmux()
    await tmux.run('new-session', '-d', '-x', '160', '-y', '45', '/bin/bash', launch)
    // The pane's process is Claude Code (launch.sh execs it): waited for at the end, as it writes its config while it goes.
    pane = Number(await tmux.run('display-message', '-p', '#{pane_pid}'))
    const total = Object.keys(allowed).length + Object.keys(refused).length
    for (const started = Date.now(); api.results.size < total && Date.now() - started < 90_000;) {
      screens.push(await tmux.run('capture-pane', '-p').catch(() => ''))
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    screens.push(await tmux.run('capture-pane', '-p').catch(() => ''))
  }, 180_000)
  afterAll(async () => {
    if (skip) return
    await tmux?.close()
    // kill-server returns before the pane's process has gone; it kept writing its plugin cache under the removal (ENOTEMPTY).
    const alive = () => { try { process.kill(pane!, 0); return true } catch { return false } }
    for (const started = Date.now(); pane && alive() && Date.now() - started < 15_000;) await new Promise((resolve) => setTimeout(resolve, 100))
    await new Promise<void>((resolve) => api?.server.close(() => resolve()))
    await new Promise<void>((resolve) => sink?.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(skip)('answered every call, and asked nobody', () => {
    expect(api.results.size, screens.at(-1)).toBe(Object.keys(allowed).length + Object.keys(refused).length)
    if (mode === 'print') expect(JSON.parse(stdout).result).toBe('done')
    // What Claude Code's asking mode showed for these calls before (the baseline in the pull request).
    else expect(screens.filter((screen) => /Do you want to proceed\?/.test(screen))).toEqual([])
  })

  it.skipIf(skip)('runs git log, git grep, gh issue view, its Super Tab post and Read', () => {
    expect(api.results.get(api.id(allowed.gitLog))).toEqual({ is_error: false, content: expect.stringContaining('first commit') })
    expect(api.results.get(api.id(allowed.gitGrep))).toEqual({ is_error: false, content: expect.stringContaining('notes.txt:1:first') })
    expect(api.results.get(api.id(allowed.ghIssueView))).toEqual({ is_error: false, content: expect.stringContaining('gh-ran') })
    expect(api.results.get(api.id(allowed.post))).toEqual({ is_error: false, content: expect.stringContaining('harness-ran') })
    expect(api.results.get(api.id(allowed.read))?.content).toContain('first')
    // Interactive Claude Code also runs gh itself as it starts (its own issue list): not a tool call, so not the guard's.
    expect(readFileSync(join(ran, 'gh'), 'utf8').split('\n')).toContain('issue view 7 --comments')
    expect(readFileSync(join(ran, 'harness'), 'utf8')).toBe('super-tab --tab t post chat hello; nothing > here op-1\n')
  })

  it.skipIf(skip).each(Object.keys(refused))('refuses %s, and it never ran', (name) => {
    const result = api.results.get(api.id(refused[name as keyof typeof refused]))
    expect(result?.is_error).toBe(true)
  })

  it.skipIf(skip)('pushed nothing', () => {
    expect(execFileSync('git', ['--git-dir', remote, 'for-each-ref'], { encoding: 'utf8' })).toBe('')
  })
  it.skipIf(skip)('opened no pull request, wrote no comment and started no agent', () => {
    expect(readFileSync(join(ran, 'gh'), 'utf8')).not.toMatch(/^(pr create|issue comment)/m)
    expect(readFileSync(join(ran, 'harness'), 'utf8')).not.toContain('new codex')
  })
  it.skipIf(skip)('wrote no file', () => {
    expect(readFileSync(join(folder, 'notes.txt'), 'utf8')).toBe('first\n')
    expect(existsSync(join(folder, 'created.txt'))).toBe(false)
    expect(readdirSync(folder).sort()).toEqual(['.claude', '.git', '.harness', '.mcp.json', 'notes.txt'])
  })
  it.skipIf(skip)('POSTed nothing and fetched nothing', () => {
    expect(posts.filter((post) => post.includes(sinkPath))).toEqual([])
  })

  it.skipIf(skip)('runs no hook or MCP server committed to the project (Lead, 10-29)', () => {
    expect(readdirSync(ran).filter((name) => name.startsWith('committed-'))).toEqual([])
  })

  // Agent Messages' hook delivers only in a terminal pane (its inbox is the pane's), so only the interactive run can hear it.
  it.skipIf(skip || mode !== 'interactive')('runs Harness\'s own hooks: a teammate\'s message reaches the agent', () => {
    expect(api.bodies.some((body) => body.includes(HARNESS_MESSAGE))).toBe(true)
  })

  it.skipIf(skip)('tells the agent why a Bash call was refused', () => {
    expect(api.results.get(api.id(refused.gitPush))?.content).toContain('A Buddy only reads')
  })
})

/**
 * When the guard cannot answer (security review 2 of #2092): one that outlasts its timeout, and managed settings that run
 * only managed hooks, which skip it. Either way the call has to be refused, not handed to rules that might allow it, and
 * the session must not stall. The timeout is 2 s here, not the folder's 30 s, so the test is quick: what Claude Code does
 * when a hook times out does not depend on how long it waited.
 */
describe.skipIf(!hasClaude).each([
  { when: 'the guard outlasts its timeout', managed: null as null | object, slow: true },
  { when: 'managed settings run only managed hooks', managed: { allowManagedHooksOnly: true }, slow: false },
])('a Buddy\'s folder when $when (real Claude Code)', ({ managed, slow }) => {
  let root: string, folder: string, remote: string, api: ReturnType<typeof fakeModel>, stdout = ''
  const bash = (command: string): Call => ({ name: 'Bash', input: { command, description: 'step' } })
  const calls = { push: bash('git push origin HEAD:main'), write: bash('echo changed > notes.txt'), read: bash('git log --oneline') }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'buddy-closed-'))
    folder = join(root, 'buddy'); remote = join(root, 'remote.git')
    for (const dir of [folder, join(root, 'home'), join(root, 'config')]) mkdirSync(dir)
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, env })
    git('init', '-q', '-b', 'main'); writeFileSync(join(folder, 'notes.txt'), 'first\n'); git('add', 'notes.txt'); git('commit', '-qm', 'first')
    execFileSync('git', ['init', '-q', '--bare', remote]); git('remote', 'add', 'origin', remote)
    prepareSwarmSkill(folder, { role: 'buddy', key: 'session' })
    const settings = join(folder, '.claude', 'settings.local.json')
    if (slow) {
      // The folder's own guard, made to sleep before it answers.
      const local = JSON.parse(readFileSync(settings, 'utf8'))
      const hook = local.hooks.PreToolUse[0].hooks[0]
      local.hooks.PreToolUse[0].hooks[0] = { ...hook, command: `sleep 5; ${hook.command}`, timeout: 2 }
      chmodSync(settings, 0o600); writeFileSync(settings, JSON.stringify(local))
    }
    if (managed) writeFileSync(join(root, 'managed-settings.json'), JSON.stringify(managed))
    api = fakeModel(Object.values(calls))
    await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
    const claude = spawn(claudeBin!, ['-p', 'go', ...PERMISSION_MODES.claude!.buddy, '--model', 'claude-sonnet-4-5', '--output-format', 'json'], {
      cwd: folder, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin', HOME: join(root, 'home'), SHELL: '/bin/bash',
        CLAUDE_CONFIG_DIR: join(root, 'config'), ANTHROPIC_API_KEY: API_KEY, TMPDIR: root, DISABLE_AUTOUPDATER: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`,
        ...(managed ? { CLAUDE_CODE_MANAGED_SETTINGS_PATH: join(root, 'managed-settings.json') } : {}) },
    })
    claude.stdout.on('data', (chunk) => { stdout += chunk })
    await new Promise<void>((resolve, reject) => { claude.on('error', reject); claude.on('close', () => resolve()) })
  }, 180_000)
  afterAll(async () => {
    await new Promise<void>((resolve) => api?.server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  it('answers every call and finishes: nothing waits on a prompt', () => {
    expect(JSON.parse(stdout).result).toBe('done')
    expect(api.results.size).toBe(Object.keys(calls).length)
  })

  it('refuses the push and the write: it fails closed', () => {
    for (const call of [calls.push, calls.write]) expect(api.results.get(api.id(call))?.is_error, JSON.stringify(call.input)).toBe(true)
  })

  it('still runs a command Claude Code itself counts as read-only, as dontAsk does without any hook (2.1.312)', () => {
    expect(api.results.get(api.id(calls.read))).toEqual({ is_error: false, content: expect.stringContaining('first') })
  })

  it('pushed nothing and wrote nothing', () => {
    expect(execFileSync('git', ['--git-dir', remote, 'for-each-ref'], { encoding: 'utf8' })).toBe('')
    expect(readFileSync(join(folder, 'notes.txt'), 'utf8')).toBe('first\n')
  })
})
