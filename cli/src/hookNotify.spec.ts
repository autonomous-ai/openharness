import { execFileSync, spawn, spawnSync } from 'child_process'
import { createServer } from 'http'
import { createServer as createNetServer } from 'net'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Every case here spawns the real hook as a child process, and several spawn shell shims for tmux, ps
// and sqlite3 on top of that. On a loaded machine — this file runs alongside 88 others — that chain
// takes well over vitest's 5s default, and the failure looks like a product bug rather than what it is.
// The hook's own budget still bounds it; this only stops the harness from calling time first.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const HOOK = fileURLToPath(new URL('../hook/notify.mjs', import.meta.url))
const servers: ReturnType<typeof createServer>[] = []
const netServers: ReturnType<typeof createNetServer>[] = []
const tmpDirs: string[] = []

function writeLegacyStateFile(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o644 })
  chmodSync(path, 0o644)
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(netServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RunHookOpts {
  port: number
  tmuxPane?: string
  /** Legacy environment noise: process-owned hooks must behave the same with or without it. */
  launcherId?: string | null
  /** Install deterministic tmux/ps fixtures so an offline fallback can prove process ownership. */
  processEngine?: 'claude' | 'codex' | 'cursor' | 'hermes' | 'devin' | 'commandcode' | 'grok'
  /** Override the fixture's ps `comm` and full argv to exercise install-root-independent matching. */
  processExecutable?: string
  processArgs?: string
  engine?: 'claude' | 'codex' | 'cursor' | 'hermes' | 'devin' | 'commandcode' | 'grok'
  env?: Record<string, string>
  dataDir?: string
  claudeProjectsDir?: string
  codexHome?: string
  cursorHome?: string
  hermesHome?: string
  /** Fake Hermes SQLite source; null means the session row has not appeared. */
  hermesSource?: 'cli' | 'tui' | 'subagent' | null
  /** How long Hermes' store takes to answer: a loaded machine. */
  hermesDelaySeconds?: number
  grokHome?: string
  devinHome?: string
  input?: Record<string, unknown>
}

function runHook(opts: RunHookOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    // The hook abandons its optional work (including the offline registry fallback) when its 4.5s
    // wall-clock budget runs out. Under a full parallel run that budget is spent on host load, not on
    // the hook, and the assertion below then reads a registry nobody wrote — measured as roughly one
    // failure in five full-suite runs. Give the child room so these specs test behaviour, not the load
    // on the machine running them.
    env.HARNESS_HOOK_DEADLINE_MS = '30000'
    if (opts.env) Object.assign(env, opts.env)
    delete env.TMUX_PANE
    if (opts.tmuxPane) env.TMUX_PANE = opts.tmuxPane
    delete env.MACHINE_ID
    if (opts.launcherId !== null) env.MACHINE_ID = opts.launcherId ?? '11111111-2222-4333-8444-555555555555'
    if (opts.processEngine) {
      const binDir = mkdtempSync(join(tmpdir(), 'adapter-hook-bin-'))
      tmpDirs.push(binDir)
      const executable = opts.processExecutable ?? (opts.processEngine === 'cursor' ? 'agent' : opts.processEngine)
      const processArgs = opts.processArgs ?? executable
      writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\necho 7000\n', { mode: 0o755 })
      const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
      writeFileSync(join(binDir, 'ps'), `#!/bin/sh\nprintf '%s\\n' '7000 1 zsh Mon Aug 10 10:00:00 2026 -zsh' ${shellQuote(`7001 7000 ${executable} Mon Aug 10 10:00:01 2026 ${processArgs}`)} '${process.pid} 7001 node Mon Aug 10 10:00:02 2026 hook-parent'\n`, { mode: 0o755 })
      if (opts.processEngine === 'cursor') {
        const target = join(binDir, 'cursor-agent-target')
        writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 })
        symlinkSync(target, join(binDir, 'agent'))
        symlinkSync(target, join(binDir, 'cursor-agent'))
      } else if (opts.processEngine === 'grok') {
        const target = join(binDir, 'grok-target')
        writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 })
        symlinkSync(target, join(binDir, 'agent'))
        symlinkSync(target, join(binDir, 'grok'))
      }
      if (opts.hermesSource !== undefined) {
        const rows = opts.hermesSource === null ? '[]' : JSON.stringify([{ source: opts.hermesSource }])
        const delay = opts.hermesDelaySeconds ? `sleep ${opts.hermesDelaySeconds}\n` : ''
        writeFileSync(join(binDir, 'sqlite3'), `#!/bin/sh\n${delay}printf '%s\\n' '${rows}'\n`, { mode: 0o755 })
      }
      env.PATH = `${binDir}:${env.PATH ?? ''}`
    }
    const args = [HOOK, '--port', String(opts.port)]
    if (opts.engine && opts.engine !== 'claude') args.push('--engine', opts.engine)
    if (opts.dataDir) args.push('--data-dir', opts.dataDir)
    if (opts.claudeProjectsDir) args.push('--claude-projects-dir', opts.claudeProjectsDir)
    if (opts.codexHome) args.push('--codex-home', opts.codexHome)
    if (opts.cursorHome) args.push('--cursor-home', opts.cursorHome)
    if (opts.hermesHome) args.push('--hermes-home', opts.hermesHome)
    if (opts.grokHome) args.push('--grok-home', opts.grokHome)
    if (opts.devinHome) args.push('--devin-home', opts.devinHome)
    const hookDataDir = opts.dataDir || process.env.ADAPTER_DATA_DIR
    if (hookDataDir) {
      mkdirSync(hookDataDir, { recursive: true, mode: 0o700 })
      try { writeFileSync(join(hookDataDir, 'hook-credential'), `${'a'.repeat(43)}\n`, { mode: 0o600, flag: 'wx' }) } catch { /* already exists */ }
    }
    const child = spawn(process.execPath, args, {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`notify.mjs exited ${code}`)))
    child.stdin.end(JSON.stringify(opts.input ?? {
      hook_event_name: 'SessionEnd',
      session_id: 'session-test',
      reason: 'logout',
    }))
  })
}

/** A throwaway localhost adapter that records every hook POST. */
async function collect(response: Record<string, unknown> = {}): Promise<{ port: number; requests: Array<{ url: string; body: Record<string, unknown> }> }> {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk.toString() })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
      res.end(JSON.stringify(response))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  return { port: address.port, requests }
}

describe('hook notify terminal scope', () => {
  it.each(['claude', 'codex'] as const)('acknowledges an emitted %s memory packet without copying the prompt or claim into the receipt', async engine => {
    const additionalContext = 'Historical coding memory: keep review changes small.'
    const memoryReceiptId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const { port, requests } = await collect({ ok: true, additionalContext, memoryReceiptId })
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/swarm-prompt-hooks.json', import.meta.url), 'utf8'))
    const input = recordings[engine].input
    const stdout = await runHook({ port, engine, tmuxPane: '%42', input })
    expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } })
    expect(requests.map(request => request.url)).toEqual(['/api/hook/session-start', '/api/hook/memory-emitted'])
    expect(requests[1].body).toMatchObject({ engine, sessionId: input.session_id, memoryReceiptId })
    expect(requests[1].body).not.toHaveProperty('prompt')
    expect(requests[1].body).not.toHaveProperty('additionalContext')
  })

  it('never acknowledges a receipt without emitted user-turn context', async () => {
    const { port, requests } = await collect({ ok: true, memoryReceiptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/swarm-prompt-hooks.json', import.meta.url), 'utf8'))
    expect(await runHook({ port, engine: 'claude', tmuxPane: '%42', input: recordings.claude.input })).toBe('')
    expect(requests.map(request => request.url)).toEqual(['/api/hook/session-start'])
  })

  it.each(['claude', 'codex'] as const)('adds daemon-verified companion context to the actual %s user turn', async engine => {
    const additionalContext = 'Companions collection context: selected GNU; retain this conversation.'
    const { port, requests } = await collect({ ok: true, additionalContext })
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/swarm-prompt-hooks.json', import.meta.url), 'utf8'))
    const input = recordings[engine].input
    const stdout = await runHook({ port, engine, tmuxPane: '%42', input })
    expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } })
    expect(requests[0]?.body.prompt).toBe(input.prompt)
    expect(await runHook({ port, engine, tmuxPane: '%42', input: { ...input, hook_event_name: 'SessionStart' } })).toBe('')
  })
  it.each(['claude', 'codex', 'grok'] as const)('forwards the actual %s accepted prompt without changing the model input', async engine => {
    const { port, requests } = await collect()
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/swarm-prompt-hooks.json', import.meta.url), 'utf8'))
    const input = recordings[engine].input
    const stdout = await runHook({ port, engine, tmuxPane: '%42', input })
    expect(requests).toContainEqual({ url: '/api/hook/session-start', body: expect.objectContaining({
      hookEvent: 'UserPromptSubmit', prompt: input.prompt, engine,
    }) })
    expect(stdout).toBe('')
  })
  it.each(['claude', 'codex', 'grok'] as const)('still announces an oversized %s prompt so earlier scope is cleared', async engine => {
    const { port, requests } = await collect()
    const recordings = JSON.parse(readFileSync(new URL('./lib/__fixtures__/swarm-prompt-hooks.json', import.meta.url), 'utf8'))
    for (const prompt of ['x'.repeat(140_000), '\u0000'.repeat(30_000)]) {
      const stdout = await runHook({ port, engine, tmuxPane: '%42', input: { ...recordings[engine].input, prompt } })
      expect(stdout).toBe('')
    }
    expect(requests).toHaveLength(2)
    for (const request of requests) expect(request).toMatchObject({ url: '/api/hook/session-start', body: {
      hookEvent: 'UserPromptSubmit', prompt: '', engine,
    } })
  })
  it('refuses a symlinked hook credential instead of authenticating with its target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-credential-link-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const target = join(dir, 'credential-target')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(target, `${'a'.repeat(43)}\n`, { mode: 0o600 })
    symlinkSync(target, join(dataDir, 'hook-credential'))
    const { port, requests } = await collect()

    await runHook({ port, tmuxPane: '%42', dataDir })

    expect(requests).toEqual([])
  })

  it('rejects a hook credential FIFO without blocking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-credential-fifo-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { mode: 0o700 })
    const credential = join(dataDir, 'hook-credential')
    execFileSync('mkfifo', [credential])

    const result = spawnSync(process.execPath, [HOOK, '--port', '9', '--data-dir', dataDir], {
      encoding: 'utf8',
      env: { ...process.env, TMUX_PANE: '%42' },
      input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fifo', reason: 'logout' }),
      timeout: 1_500,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(statSync(credential).isFIFO()).toBe(true)
  })

  it('forwards Cursor Task/stop hooks, journals the launcher, and always prints JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cursor-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const cursorHome = join(dir, 'cursor')
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk.toString() })
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
        res.end('{}')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    const stdout = await runHook({
      port: address.port,
      tmuxPane: '%21',
      engine: 'cursor',
      dataDir,
      cursorHome,
      input: {
        hook_event_name: 'preToolUse',
        session_id: 'cursor-session',
        tool_name: 'Task',
        tool_use_id: 'call-1',
        tool_input: { description: 'Inspect', prompt: 'Read code', model: 'inherit' },
        user_email: 'must-not-leak@example.com',
      },
    })
    expect(stdout).toBe('{}\n')
    expect(requests).toEqual([{
      url: '/api/hook/tool-start',
      body: {
        sessionId: 'cursor-session',
        toolUseId: 'call-1',
        toolName: 'Task',
        input: { description: 'Inspect', prompt: 'Read code', model: 'inherit' },
        engine: 'cursor',
        tmuxPane: '%21',
        runtimeHints: [{ backend: 'tmux', paneId: '%21' }],
        callerPid: expect.any(Number),
      },
    }])
    expect(JSON.parse(readFileSync(join(dataDir, 'cursor-pending-tasks.json'), 'utf8'))).toMatchObject([{
      sessionId: 'cursor-session',
      toolUseId: 'call-1',
    }])

    requests.splice(0)
    await runHook({
      port: address.port,
      tmuxPane: '%21',
      engine: 'cursor',
      dataDir,
      cursorHome,
      input: {
        hook_event_name: 'stop',
        session_id: 'cursor-session',
        workspace_roots: ['/tmp/cursor-workspace'],
        cursor_version: '2026.07.20-8cc9c0b',
      },
    })
    expect(requests.map((request) => request.url)).toEqual([
      '/api/hook/session-start',
      '/api/hook/turn-stop',
    ])
    expect(() => readFileSync(join(dataDir, 'cursor-pending-tasks.json'), 'utf8')).toThrow()
  })

  it('ignores Cursor background agents without leaking them into the registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cursor-background-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const output = await runHook({
      port: 9,
      tmuxPane: '%22',
      engine: 'cursor',
      dataDir,
      cursorHome: join(dir, 'cursor'),
      input: {
        hook_event_name: 'sessionStart',
        session_id: 'background',
        is_background_agent: true,
      },
    })
    expect(output).toBe('{}\n')
    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it('ignores Codex subagent rollouts instead of replacing the parent transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-codex-subagent-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const codexHome = join(dir, 'codex')
    const childId = '019f8dae-e5f4-7c11-90d1-600854063b2c'
    const parentId = '019f7f1b-195d-70f2-861b-de5d54a3e141'
    const transcriptPath = join(codexHome, 'sessions', '2026', '07', `rollout-${childId}.jsonl`)
    mkdirSync(join(transcriptPath, '..'), { recursive: true })
    writeFileSync(transcriptPath, JSON.stringify({
      type: 'session_meta',
      payload: {
        id: childId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
      },
    }) + '\n')
    const requests: string[] = []
    const server = createServer((req, res) => {
      requests.push(req.url ?? '')
      req.resume()
      res.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({
      port: address.port,
      tmuxPane: '%8',
      engine: 'codex',
      dataDir,
      codexHome,
      input: {
        hook_event_name: 'SessionStart',
        session_id: parentId,
        transcript_path: transcriptPath,
        cwd: '/tmp/codex',
      },
    })

    expect(requests).toEqual([])
    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it('forwards tmux events regardless of legacy MACHINE_ID', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk.toString() })
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
        res.end('{}')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({ port: address.port, tmuxPane: '%42', launcherId: null })
    expect(requests).toHaveLength(1)

    await runHook({ port: address.port, tmuxPane: '%42' })
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-end', '/api/hook/session-end'])
  })

  it('drops standalone SessionEnd but forwards tmux SessionEnd', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk.toString() })
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
        res.end('{}')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({ port: address.port })
    expect(requests).toEqual([])

    await runHook({ port: address.port, tmuxPane: '%42' })
    expect(requests).toEqual([{
      url: '/api/hook/session-end',
      body: {
        sessionId: 'session-test',
        reason: 'logout',
        engine: 'claude',
        tmuxPane: '%42',
        runtimeHints: [{ backend: 'tmux', paneId: '%42' }],
        callerPid: expect.any(Number),
      },
    }])
  })

  it('falls back to registry.json when SessionStart cannot reach the adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-1.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeLegacyStateFile(join(dataDir, 'registry.json'), '[]')
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9,
      tmuxPane: '%7',
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-1',
        transcript_path: transcriptPath,
        cwd: '/tmp/demo',
        session_title: 'Demo',
        model: 'sonnet',
        cli_version: '1.0.0',
      },
    })

    const registry = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    expect(registry).toMatchObject([{
      sessionId: 'session-1',
      engine: 'claude',
      transcriptPath,
      projectDir: 'demo',
      cwd: '/tmp/demo',
      tmuxPane: '%7',
      title: 'Demo',
      model: 'sonnet',
      cliVersion: '1.0.0',
    }])
    expect(statSync(dataDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dataDir, 'registry.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, 'registry-boot')).mode & 0o777).toBe(0o600)
  })

  it('leaves a corrupt offline registry byte-identical instead of replacing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-corrupt-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-corrupt.jsonl')
    const registryFile = join(dataDir, 'registry.json')
    const corrupt = '[{"schemaVersion":2'
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(transcriptPath, '{}\n')
    writeFileSync(registryFile, corrupt, { mode: 0o600 })

    await runHook({
      port: 9,
      tmuxPane: '%70',
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-corrupt',
        transcript_path: transcriptPath,
        cwd: '/tmp/demo',
      },
    })

    expect(readFileSync(registryFile, 'utf8')).toBe(corrupt)
  })

  it('leaves malformed current, future, and legacy rows byte-identical while offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-invalid-v2-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-invalid-v2.jsonl')
    const registryFile = join(dataDir, 'registry.json')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    for (const bytes of [
      JSON.stringify([{ schemaVersion: 2, agentId: 'damaged' }]),
      JSON.stringify([{ schemaVersion: '3', agentId: 'future' }]),
      JSON.stringify([{}]),
      JSON.stringify([7]),
      JSON.stringify([{ agentId: 'legacy-agent' }]),
    ]) {
      writeFileSync(registryFile, bytes, { mode: 0o600 })
      await runHook({
        port: 9,
        tmuxPane: '%71',
        processEngine: 'claude',
        dataDir,
        claudeProjectsDir,
        input: {
          hook_event_name: 'SessionStart',
          session_id: 'session-invalid-v2',
          transcript_path: transcriptPath,
          cwd: '/tmp/demo',
        },
      })
      expect(readFileSync(registryFile, 'utf8')).toBe(bytes)
    }
  })

  it('falls back with Codex engine under CODEX_HOME/sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-codex-'))
    tmpDirs.push(dir)
    const codexHome = join(dir, 'codex')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(codexHome, 'sessions', '2026', 'rollout.jsonl')
    mkdirSync(join(codexHome, 'sessions', '2026'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9,
      tmuxPane: '%8',
      engine: 'codex',
      processEngine: 'codex',
      processExecutable: 'node',
      processArgs: 'node /nix/store/codex-cli/lib/node_modules/@openai/codex/bin/codex.js',
      dataDir,
      codexHome,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'codex-session',
        transcript_path: transcriptPath,
        cwd: '/tmp/codex',
      },
    })

    const registry = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    expect(registry).toMatchObject([{ sessionId: 'codex-session', engine: 'codex', tmuxPane: '%8' }])
  })

  it('does not treat engine names in unrelated process arguments as an offline agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-process-false-positive-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-false.jsonl')
    mkdirSync(join(transcriptPath, '..'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9,
      tmuxPane: '%81',
      processEngine: 'claude',
      processExecutable: 'python3',
      processArgs: 'python3 /work/runner.py compare claude codex agent hermes',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-false',
        transcript_path: transcriptPath,
      },
    })

    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it.each(['cli', 'tui'] as const)('offline Hermes fallback binds source=%s and rejects delegation children or unknown rows', async (interactiveSource) => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-hermes-source-'))
    tmpDirs.push(dir)
    const hermesHome = join(dir, 'hermes')
    const cliData = join(dir, 'cli-data')
    const common = {
      port: 9,
      tmuxPane: '%82',
      engine: 'hermes' as const,
      processEngine: 'hermes' as const,
      processExecutable: 'python3',
      processArgs: 'python3 /opt/venvs/hermes/lib/python3.12/site-packages/hermes-agent/hermes',
      hermesHome,
    }

    await runHook({
      ...common,
      dataDir: cliData,
      hermesSource: interactiveSource,
      input: { hook_event_name: 'on_session_start', session_id: '20260810_120000_a1b2c3' },
    })
    expect(JSON.parse(readFileSync(join(cliData, 'registry.json'), 'utf8'))).toMatchObject([{
      sessionId: '20260810_120000_a1b2c3', engine: 'hermes', tmuxPane: '%82',
    }])

    for (const [name, source] of [['child', 'subagent'], ['unknown', null]] as const) {
      const dataDir = join(dir, `${name}-data`)
      await runHook({
        ...common,
        dataDir,
        hermesSource: source,
        input: { hook_event_name: 'on_session_start', session_id: `20260810_12000${name === 'child' ? '1' : '2'}_a1b2c3` },
      })
      expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
    }
  })

  it.each([
    "import sys, runpy; sys.path.insert(0, '/opt/custom'); runpy.run_module('hermes_cli.main', run_name='__main__')",
    "import os, re, sys; sys.path.insert(0, '/opt/custom'); import hermes_bootstrap; from hermes_cli.main import main; sys.exit(main())",
    "import os, sys, runpy; os.environ.pop('PYTHONHOME', None); sys.path.insert(0, '/opt/custom'); os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or '/home/demo/.hermes'; import hermes_bootstrap; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)",
  ])('offline Hermes discovery follows a managed Python bootstrap: %s', async (source) => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-hermes-launcher-'))
    tmpDirs.push(dir)
    const common = {
      port: 9, tmuxPane: '%82', engine: 'hermes' as const, processEngine: 'hermes' as const,
      processExecutable: '/home/demo/.her', hermesHome: join(dir, 'hermes'), hermesSource: 'cli' as const,
      input: { hook_event_name: 'on_session_start', session_id: '20260810_120000_a1b2c3' },
    }
    await runHook({ ...common, dataDir: join(dir, 'data'), processArgs: `/opt/python3 -I -I -c ${source}` })
    expect(JSON.parse(readFileSync(join(dir, 'data', 'registry.json'), 'utf8'))).toMatchObject([
      { engine: 'hermes', tmuxPane: '%82', processIdentity: { pid: 7001 } },
    ])
    await runHook({ ...common, dataDir: join(dir, 'unrelated'), processArgs: `python3 worker.py -c ${source}` })
    expect(() => readFileSync(join(dir, 'unrelated', 'registry.json'), 'utf8')).toThrow()
  })

  it('still binds a CLI Hermes session when its store is slow to answer, as on a loaded machine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-hermes-slow-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    await runHook({
      port: 9,
      tmuxPane: '%83',
      engine: 'hermes',
      processEngine: 'hermes',
      processExecutable: 'python3',
      processArgs: 'python3 /opt/venvs/hermes/lib/python3.12/site-packages/hermes-agent/hermes',
      hermesHome: join(dir, 'hermes'),
      dataDir,
      hermesSource: 'cli',
      hermesDelaySeconds: 1.5,
      input: { hook_event_name: 'on_session_start', session_id: '20260810_120003_a1b2c3' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))).toMatchObject([{
      sessionId: '20260810_120003_a1b2c3', engine: 'hermes', tmuxPane: '%83',
    }])
  })

  it('does not fallback when the adapter accepts the hook event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-online-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-online.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    const server = createServer((_req, res) => res.end('{}'))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({
      port: address.port,
      tmuxPane: '%9',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-online',
        transcript_path: transcriptPath,
      },
    })

    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf-8')).toThrow()
  })

  it('does not write fallback registry entries outside tmux or outside the transcript root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-invalid-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const outside = join(dir, 'outside.jsonl')
    mkdirSync(claudeProjectsDir, { recursive: true })
    writeFileSync(outside, '{}\n')

    await runHook({
      port: 9,
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'no-tmux',
        transcript_path: outside,
      },
    })
    await runHook({
      port: 9,
      tmuxPane: '%10',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'outside',
        transcript_path: outside,
      },
    })

    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf-8')).toThrow()
  })

  it('leaves offline registry ownership unchanged on SessionEnd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-end-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify([{ sessionId: 'keep' }, { sessionId: 'ended' }]))

    await runHook({
      port: 9,
      tmuxPane: '%11',
      dataDir,
      input: { hook_event_name: 'SessionEnd', session_id: 'ended', reason: 'logout' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'keep' }, { sessionId: 'ended' }])

    await runHook({
      port: 9,
      tmuxPane: '%11',
      dataDir,
      input: { hook_event_name: 'SessionEnd', session_id: 'keep', reason: 'clear' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'keep' }, { sessionId: 'ended' }])
  })

  it('keeps fallback registry entries when SessionEnd cannot prove the tmux app exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-end-unknown-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const binDir = join(dir, 'bin')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify([{ sessionId: 'maybe-alive' }]))
    writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    await runHook({
      port: 9,
      tmuxPane: '%13',
      dataDir,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      input: { hook_event_name: 'SessionEnd', session_id: 'maybe-alive', reason: 'logout' },
    })

    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'maybe-alive' }])
  })

  it('carries what the daemon chose at launch through an offline re-register', async () => {
    // A hook arriving while the daemon is down rebuilds the row. The grid launch (key included), the
    // Codex profile, the bypass flag and the observed grid are not on the process or in the hook body
    // — they must come from the row being replaced, or this becomes the one write that strips them
    // and the next restart relaunches the agent on the wrong login.
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-carry-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-1.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeFileSync(transcriptPath, '{}\n')
    const gridLaunch = { networkId: 'grid-abc', networkName: 'Team grid', baseUrl: 'https://grid.example/grid-abc/relay/v1', apiKey: 'gridkey-abc123' }
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([{
      schemaVersion: 2,
      active: true,
      launch: { state: 'starting' },
      agentId: 'agent-created',
      sessionId: '',
      boundAt: null,
      engine: 'claude',
      gateway: null,
      grid: { baseUrl: gridLaunch.baseUrl, model: null },
      gridLaunch,
      codexHome: null,
      bypassPermission: true,
      transcriptPath: null,
      projectDir: 'demo',
      cwd: '/tmp/demo',
      runtimes: [{ backend: 'tmux', paneId: '%7' }],
      primaryRuntimeKey: 'tmux\u0000%7',
      tmuxPane: '%7',
      source: null,
      title: null,
      model: null,
      cliVersion: null,
      processIdentity: { pid: 7001, executable: 'claude', startMarker: 'Mon Aug 10 10:00:01 2026' },
      registeredAt: 1,
      updatedAt: 1,
      lastHookAt: 1,
      lastTranscriptAt: 1,
      // When an app last opened it — every app's "last used" order reads this, so a hook that lands
      // while the daemon is down must not be the write that forgets it.
      lastOpenedAt: 1_790_000_000_000,
    }]))

    await runHook({
      port: 9,
      tmuxPane: '%7',
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-1', transcript_path: transcriptPath, cwd: '/tmp/demo' },
    })

    const registry = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    expect(registry).toHaveLength(1)
    expect(registry[0]).toMatchObject({
      agentId: 'agent-created',
      sessionId: 'session-1',
      grid: { baseUrl: gridLaunch.baseUrl, model: null },
      gridLaunch,
      bypassPermission: true,
      lastOpenedAt: 1_790_000_000_000,
    })
    expect(registry[0]).not.toHaveProperty('launch')
  })

  it('an offline re-register of the session a row already holds keeps the row\'s folder', async () => {
    // Claude's UserPromptSubmit carries the tracked shell directory — wherever the agent last
    // `cd`'d — and a daemon-down rebuild must not move the row there any more than the daemon does.
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cwd-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-1.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeFileSync(transcriptPath, '{}\n')
    const row = {
      schemaVersion: 2, active: true, agentId: 'agent-bound', sessionId: 'session-1', boundAt: 1, engine: 'claude',
      gateway: null, grid: null, codexHome: null, transcriptPath, projectDir: 'demo', cwd: '/tmp/demo',
      runtimes: [{ backend: 'tmux', paneId: '%7' }], primaryRuntimeKey: 'tmux\u0000%7', tmuxPane: '%7',
      source: null, title: null, model: null, cliVersion: null,
      processIdentity: { pid: 7001, executable: 'claude', startMarker: 'Mon Aug 10 10:00:01 2026' },
      registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    }
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([row]))

    await runHook({
      port: 9, tmuxPane: '%7', processEngine: 'claude', dataDir, claudeProjectsDir,
      input: { hook_event_name: 'UserPromptSubmit', session_id: 'session-1', transcript_path: transcriptPath, cwd: '/tmp/demo/cli' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))[0]).toMatchObject({ agentId: 'agent-bound', sessionId: 'session-1', cwd: '/tmp/demo' })

    // A rotation is a new session and takes the folder it reports.
    const rotated = join(claudeProjectsDir, 'demo', 'session-2.jsonl')
    writeFileSync(rotated, '{}\n')
    await runHook({
      port: 9, tmuxPane: '%7', processEngine: 'claude', dataDir, claudeProjectsDir,
      input: { hook_event_name: 'SessionStart', session_id: 'session-2', transcript_path: rotated, cwd: '/tmp/demo/cli' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))[0]).toMatchObject({ agentId: 'agent-bound', sessionId: 'session-2', cwd: '/tmp/demo/cli' })
  })

  it('drops stale registry entries when boot marker predates this boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-reboot-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'fresh.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeFileSync(transcriptPath, '{}\n')
    writeLegacyStateFile(join(dataDir, 'registry-boot'), '1')
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([{ sessionId: 'stale', tmuxPane: '%1' }]))

    await runHook({
      port: 9,
      tmuxPane: '%12',
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'fresh',
        transcript_path: transcriptPath,
      },
    })

    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toMatchObject([
      { sessionId: 'fresh', tmuxPane: '%12' },
    ])
  })
})

describe('hook notify Grok lifecycle', () => {
  it('resolves updates.jsonl, registers lifecycle events, and uses only StopFailure as a close fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-grok-'))
    tmpDirs.push(dir)
    const grokHome = join(dir, 'grok')
    const cwd = '/tmp/grok workspace'
    const sessionId = '8184b11d-175e-46cb-9cee-cf41cafe70d2'
    const transcript = join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl')
    mkdirSync(join(transcript, '..'), { recursive: true })
    writeFileSync(transcript, '{}\n')
    const { port, requests } = await collect()

    await runHook({
      port, tmuxPane: '%44', engine: 'grok', grokHome,
      input: { hookEventName: 'session_start', sessionId, cwd, model: 'grok-4.5', cliVersion: '1.0.0' },
    })
    expect(requests).toEqual([{
      url: '/api/hook/session-start',
      body: expect.objectContaining({
        engine: 'grok', hookEvent: 'SessionStart', sessionId, transcriptPath: transcript,
        cwd, tmuxPane: '%44', model: 'grok-4.5', cliVersion: '1.0.0',
      }),
    }])

    requests.splice(0)
    await runHook({ port, tmuxPane: '%44', engine: 'grok', grokHome, input: { hookEventName: 'stop', sessionId, cwd } })
    expect(requests).toEqual([])
    await runHook({ port, tmuxPane: '%44', engine: 'grok', grokHome, input: { hookEventName: 'stop_failure', sessionId, cwd } })
    expect(requests).toEqual([{
      url: '/api/hook/turn-stop',
      body: {
        sessionId,
        transcriptPath: transcript,
        status: 'error',
        engine: 'grok',
        tmuxPane: '%44',
        runtimeHints: [{ backend: 'tmux', paneId: '%44' }],
        callerPid: expect.any(Number),
      },
    }])
  })

  it('writes an offline fallback registry entry under the trusted Grok root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-grok-offline-'))
    tmpDirs.push(dir)
    const grokHome = join(dir, 'grok')
    const dataDir = join(dir, 'data')
    const cwd = '/tmp/grok-offline'
    const sessionId = '98ee3dac-175e-46cb-9cee-cf41cafe70d2'
    const transcript = join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl')
    mkdirSync(join(transcript, '..'), { recursive: true })
    writeFileSync(transcript, '{}\n')

    await runHook({
      port: 9, tmuxPane: '%45', engine: 'grok', processEngine: 'grok',
      processExecutable: 'agent', processArgs: 'agent', grokHome, dataDir,
      input: { hookEventName: 'session_start', sessionId, cwd },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))).toMatchObject([{
      sessionId, engine: 'grok', transcriptPath: transcript, projectDir: 'grok-offline', cwd, tmuxPane: '%45',
    }])

    const rejectedDataDir = join(dir, 'cursor-owned-agent-data')
    await runHook({
      port: 9, tmuxPane: '%46', engine: 'grok', processEngine: 'cursor',
      processExecutable: 'agent', processArgs: 'agent', grokHome, dataDir: rejectedDataDir,
      input: { hookEventName: 'session_start', sessionId, cwd },
    })
    expect(() => readFileSync(join(rejectedDataDir, 'registry.json'), 'utf8')).toThrow()
  })
})

/**
 * Devin's documented user-level hook locations include `~/.claude/settings.json`, so the machine's CLAUDE
 * hook can fire inside a Devin session and register it under the wrong engine. The claude arm bails out
 * on a payload whose session id is a Devin slug holding a live `session_locks/<id>.lock`.
 */
describe('hook notify Devin/claude disambiguation', () => {

  it('ignores a Devin session that fired the claude hook, but still registers a real claude session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-devin-'))
    tmpDirs.push(dir)
    const devinHome = join(dir, 'devin')
    const projectsDir = join(dir, 'projects')
    mkdirSync(join(devinHome, 'session_locks'), { recursive: true })
    writeFileSync(join(devinHome, 'session_locks', 'classy-tourmaline.lock'), '21988')
    mkdirSync(projectsDir, { recursive: true })
    const transcript = join(projectsDir, 'a3f1c2d4-0000-4000-8000-000000000001.jsonl')
    writeFileSync(transcript, '')

    const { port, requests } = await collect()

    // Devin's SessionStart, arriving on the claude-armed hook → dropped.
    await runHook({
      port,
      tmuxPane: '%30',
      dataDir: join(dir, 'data'),
      claudeProjectsDir: projectsDir,
      devinHome,
      input: { hook_event_name: 'SessionStart', session_id: 'classy-tourmaline', source: 'startup' },
    })
    expect(requests).toEqual([])

    // A genuine claude session is unaffected.
    await runHook({
      port,
      tmuxPane: '%30',
      dataDir: join(dir, 'data'),
      claudeProjectsDir: projectsDir,
      devinHome,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'a3f1c2d4-0000-4000-8000-000000000001',
        transcript_path: transcript,
        cwd: '/tmp/claude-workspace',
        source: 'startup',
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/hook/session-start')
    expect(requests[0].body).toMatchObject({ engine: 'claude', sessionId: 'a3f1c2d4-0000-4000-8000-000000000001' })
  })

  it('registers a Devin session with no transcript path and the hook process cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-devin2-'))
    tmpDirs.push(dir)
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%31',
      engine: 'devin',
      dataDir: join(dir, 'data'),
      devinHome: join(dir, 'devin'),
      input: { hook_event_name: 'SessionStart', session_id: 'blue-agustinia', source: 'startup' },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/hook/session-start')
    expect(requests[0].body).toMatchObject({
      engine: 'devin',
      sessionId: 'blue-agustinia',
      tmuxPane: '%31',
      cwd: process.cwd(),
    })
    expect(requests[0].body.transcriptPath).toBeUndefined()
  })

  it('routes a Devin Stop to turn-stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-devin3-'))
    tmpDirs.push(dir)
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%32',
      engine: 'devin',
      dataDir: join(dir, 'data'),
      devinHome: join(dir, 'devin'),
      input: { hook_event_name: 'Stop', session_id: 'blue-agustinia', stop_hook_active: false, prompt_id: 'p1' },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/hook/turn-stop')
    expect(requests[0].body).toMatchObject({ sessionId: 'blue-agustinia' })
  })
})

describe('hook notify Command Code re-registration', () => {
  // Command Code's hook set is PreToolUse/PostToolUse/Stop/SessionStart — Stop doubles as its only catch
  // hook, so it must register as well as close the turn. Without that, a session dropped from the registry
  // stays invisible on web/device until the user quits and relaunches the CLI.
  it('re-registers on Stop, with the transcript path, before closing the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cc-'))
    tmpDirs.push(dir)
    const transcript = join(dir, '53955d6d.jsonl')
    writeFileSync(transcript, '{}\n')
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%3',
      engine: 'commandcode',
      dataDir: join(dir, 'data'),
      input: {
        hook_event_name: 'Stop',
        session_id: '53955d6d',
        transcript_path: transcript,
        cwd: '/tmp/demo',
        session_title: 'Greeting',
      },
    })

    expect(requests.map((r) => r.url)).toEqual(['/api/hook/session-start', '/api/hook/turn-stop'])
    expect(requests[0].body).toMatchObject({
      engine: 'commandcode',
      hookEvent: 'Stop',
      sessionId: '53955d6d',
      transcriptPath: transcript,
      tmuxPane: '%3',
      cwd: '/tmp/demo',
      title: 'Greeting',
    })
    expect(requests[1].body).toMatchObject({ sessionId: '53955d6d' })
  })

  it('omits a transcript path that does not exist yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cc2-'))
    tmpDirs.push(dir)
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%3',
      engine: 'commandcode',
      dataDir: join(dir, 'data'),
      input: { hook_event_name: 'Stop', session_id: '53955d6d', transcript_path: join(dir, 'nope.jsonl') },
    })

    expect(requests).toHaveLength(2)
    expect(requests[0].body.transcriptPath).toBeUndefined()
  })

  it('leaves the claude Stop path as a turn-stop only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cc3-'))
    tmpDirs.push(dir)
    const transcript = join(dir, 'projects', 'demo', 'abc.jsonl')
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    writeFileSync(transcript, '{}\n')
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%4',
      dataDir: join(dir, 'data'),
      claudeProjectsDir: join(dir, 'projects'),
      input: { hook_event_name: 'Stop', session_id: 'abc', transcript_path: transcript },
    })

    expect(requests.map((r) => r.url)).toEqual(['/api/hook/turn-stop'])
  })
})

// The destructive-action gate (cli/src/lib/actionPolicy.ts; first written by Fred Nix in the nixfred fork).
describe('claude PreToolUse gate', () => {
  const input = { hook_event_name: 'PreToolUse', session_id: 'claude-session', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'git push origin main' } }
  it('turns the daemon\'s ask verdict into Claude\'s own permission prompt', async () => {
    const { port, requests } = await collect({ ok: true, gate: { decision: 'ask', rule: 'git push', reason: 'git push needs your approval' } })
    const stdout = await runHook({ port, tmuxPane: '%7', input })
    expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Harness gate: git push needs your approval',
    } })
    expect(requests.find((r) => r.url === '/api/hook/tool-start')?.body).toMatchObject({ sessionId: 'claude-session', toolName: 'Bash', input: { command: 'git push origin main' } })
  })
  it('stays silent (allow) when the daemon says nothing about the call', async () => {
    const { port } = await collect({ ok: true })
    expect(await runHook({ port, tmuxPane: '%7', input })).toBe('')
  })
})
