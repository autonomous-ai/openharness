import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as releaseFixtures.spec.ts
// loads it.
const { fakeEngineShim } = await import('../../e2e/harness/daemon.js' as string) as {
  fakeEngineShim: (name: 'codex', config: Record<string, unknown>) => string
}

let root = ''
let child: ChildProcessWithoutNullStreams | undefined

afterEach(() => {
  try { if (child?.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  child = undefined
  rmSync(root, { recursive: true, force: true })
})

describe('the fake codex app-server', () => {
  it.each([
    ['as the rate-limit read runs it', ['app-server']],
    ['with -c pairs, as a provider move runs it', ['app-server', '-c', 'model_provider="grid"']],
  ])('answers nothing and ends when its stdin ends, %s', async (_, argv) => {
    root = mkdtempSync(join(tmpdir(), 'fake-app-server-'))
    mkdirSync(join(root, 'bin'))
    const codex = join(root, 'bin', 'codex')
    writeFileSync(codex, fakeEngineShim('codex', {
      port: 1, dataDir: join(root, 'data'), claudeProjectsDir: join(root, 'claude'), codexHome: join(root, 'codex'), root, hookLog: join(root, 'hooks.log'),
    }), { mode: 0o755 })
    const started = spawn(codex, argv, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    child = started
    let out = ''
    started.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    const ended = new Promise<number | null>((done) => started.on('close', (code) => done(code)))
    started.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {} })}\n`)
    started.stdin.end()
    let timer: NodeJS.Timeout | undefined
    const code = await Promise.race([ended, new Promise<'still running'>((done) => { timer = setTimeout(() => done('still running'), 10_000) })])
    clearTimeout(timer)
    expect(code, 'the server once its stdin ended').toBe(0)
    expect(out).toBe('')
    // A read is no launch: the tests that read launch-argv see agents only.
    expect(existsSync(join(root, 'launch-argv'))).toBe(false)
  }, 20_000)
})
