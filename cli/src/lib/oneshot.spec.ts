import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { runGrokOneShot, runRouterOneShot } from './oneshot.js'

// What an engine prints when it fails can echo its prompt (the spoken task, agent names), and these
// errors reach the logs: they carry what failed and how much stderr, never the text.
describe.skipIf(process.platform === 'win32')('a failed one-shot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-failure-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const STDERR = 'SECRET fix the login'
  const fake = (name: string, body: string): string => {
    const file = join(dir, name)
    // Read one byte of the prompt first, so the worker's write never meets a closed pipe.
    writeFileSync(file, `#!/bin/sh\nhead -c 1 >/dev/null\n${body}\n`)
    chmodSync(file, 0o755)
    return file
  }
  const failed = async (run: Promise<unknown>) => {
    const err = await run.then(() => { throw new Error('the one-shot answered') }, (error: unknown) => error as Error & Record<string, unknown>)
    expect(err.message).not.toContain('SECRET')
    return { failure: err.failure, stderrBytes: err.stderrBytes }
  }
  const exits = `printf '%s' '${STDERR}' >&2\nexit 3`

  // Codex alone is found through process.env, not the parsed env.
  const codexPath = process.env.CODEX_PATH
  afterAll(() => { process.env.CODEX_PATH = codexPath })
  it.each([
    ['claude', (bin: string) => { env.CLAUDE_PATH = bin }],
    ['codex', (bin: string) => { process.env.CODEX_PATH = bin }],
    ['opencode', (bin: string) => { env.OPENCODE_PATH = bin }],
    ['kilo', (bin: string) => { env.KILO_PATH = bin }],
    ['pi', (bin: string) => { env.PI_PATH = bin }],
    ['commandcode', (bin: string) => { env.COMMANDCODE_PATH = bin }],
  ] as const)('%s that exits says its exit code and stderr size', async (engine, use) => {
    use(fake(engine, exits))
    expect(await failed(runRouterOneShot(engine, { prompt: 'p', cwd: dir, timeoutMs: 20_000 })))
      .toEqual({ failure: 'exited 3', stderrBytes: STDERR.length })
  })

  it('grok that exits says its exit code and stderr size', async () => {
    env.GROK_PATH = fake('grok', exits)
    expect(await failed(runGrokOneShot({ prompt: 'p', cwd: dir, timeoutMs: 20_000 })))
      .toEqual({ failure: 'exited 3', stderrBytes: STDERR.length })
  })

  it('cursor that answers with an error result says so, without the result', async () => {
    env.CURSOR_PATH = fake('cursor', `echo '{"type":"result","is_error":true,"result":"SECRET the agents Auth and Frontend"}'\nexit 1`)
    expect(await failed(runRouterOneShot('cursor', { prompt: 'p', cwd: dir, timeoutMs: 20_000 })))
      .toEqual({ failure: 'error result', stderrBytes: 0 })
  })

  it('claude that never answers says it timed out', async () => {
    env.CLAUDE_PATH = fake('claude-silent', 'exec sleep 30')
    expect(await failed(runRouterOneShot('claude', { prompt: 'p', cwd: dir, timeoutMs: 300 })))
      .toEqual({ failure: 'timed out after 300ms', stderrBytes: 0 })
  })
})
