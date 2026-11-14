/**
 * `harness device claude …` as the menu-bar app, the plugin's hook and its mod run it: a fake `claude` (a ClaudeRun that
 * answers from a table) and a daemon listening on a socket in a throwaway folder. The real `claude`, ~/.claude and the
 * daemon are never touched.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { unixSocketPath } from '../lib/localSocket.js'
import { DEVICE_USAGE, runDeviceCommand, type DeviceDeps } from './command.js'
import type { ClaudeRun } from './plugin.js'

const SRC = fileURLToPath(new URL('..', import.meta.url))
/** Names the daemon's socket only: the daemon here listens on a socket in a throwaway folder. */
const PORT = 4998
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dc-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A `claude` 2.1.287 with nothing installed, whose calls answer from [answers] by their arguments. */
function fakeClaude(answers: Record<string, { code: number; stdout?: string; stderr?: string }> = {}): ClaudeRun {
  const table: typeof answers = { '--version': { code: 0, stdout: '2.1.287 (Claude Code)\n' }, 'plugin list --json': { code: 0, stdout: '[]' }, ...answers }
  return async (args) => {
    const answer = table[args.join(' ')] ?? { code: 0 }
    return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
}

async function* chunks(...parts: string[]): AsyncIterable<string> {
  yield* parts
}

async function device(argv: string[], deps: Partial<DeviceDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runDeviceCommand(argv, {
    dataDir: folder(), port: PORT, platform: 'darwin', stdin: chunks(), claude: () => fakeClaude(),
    out: (line) => { out.push(line) }, err: (line) => { err.push(line) },
    ...deps,
  })
  return { code, out, err }
}

describe('harness device claude', () => {
  it('status --json prints the four fields on one line', async () => {
    const status = await device(['claude', 'status', '--json'])
    expect(status).toEqual({
      code: 0, err: [],
      out: ['{"supported":true,"installed":false,"enabled":false,"claudeVersion":"2.1.287"}'],
    })
  })

  it('enable prints its error on stderr and exits 1', async () => {
    const claude = fakeClaude({ 'plugin install harness-device@openharness --scope user': { code: 1, stderr: 'Plugin not found\nmore' } })
    expect(await device(['claude', 'enable'], { claude: () => claude })).toEqual({ code: 1, out: [], err: ['Plugin not found'] })
    expect(await device(['claude', 'enable'], { claude: () => null }))
      .toEqual({ code: 1, out: [], err: ['Claude Code 2.1.287 or later is needed.'] })
  })

  it('disable exits 0', async () => {
    const installed = fakeClaude({ 'plugin list --json': { code: 0, stdout: JSON.stringify([{ id: 'harness-device@openharness', scope: 'user', enabled: true }]) } })
    expect(await device(['claude', 'disable'], { claude: () => installed })).toEqual({ code: 0, out: [], err: [] })
  })

  it('link --json prints the socket path and nothing else', async () => {
    const dataDir = folder()
    expect(await device(['claude', 'link', '--json'], { dataDir }))
      .toEqual({ code: 0, err: [], out: [JSON.stringify({ socketPath: unixSocketPath(dataDir, PORT) })] })
  })

  it('link on Windows exits 1 with no output', async () => {
    expect(await device(['claude', 'link', '--json'], { platform: 'win32' })).toEqual({ code: 1, out: [], err: [] })
  })

  it('approve reads stdin and prints the decision', async () => {
    const dataDir = folder()
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"decision":"allow"}') })
    })
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    await new Promise<void>((resolve) => { server.listen(unixSocketPath(dataDir, PORT)!, resolve) })
    const stdin = chunks(JSON.stringify({ session_id: 'sess-1', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'npm test' } }))
    expect(await device(['claude', 'approve'], { dataDir, stdin, claude: () => { throw new Error('approve never looks for claude') } }))
      .toEqual({ code: 0, out: [ALLOW], err: [] })
  })

  it('an unknown subcommand prints the usage and exits 1', async () => {
    for (const argv of [[], ['claude'], ['claude', 'install'], ['codex', 'status'], ['claude', 'status', 'extra']]) {
      expect(await device(argv), argv.join(' ')).toEqual({ code: 1, out: [], err: [DEVICE_USAGE] })
    }
  })

  it('DEVICE_USAGE names status, enable and disable, and neither approve nor link', () => {
    for (const word of ['status', 'enable', 'disable']) expect(DEVICE_USAGE).toContain(`harness device claude ${word}`)
    expect(DEVICE_USAGE).not.toMatch(/approve|link/)
  })

  it('no file under core/, services/ or cable/ imports deviceClaude/', () => {
    const importsDevice = /(?:from|import\s*\()\s*['"][^'"]*deviceClaude\//
    // The pattern catches a static and a dynamic import, or an empty list would prove nothing.
    expect(["import { runApprove } from '../deviceClaude/approve.js'", "await import('../deviceClaude/plugin.js')"].every((line) => importsDevice.test(line))).toBe(true)
    const importers = ['core', 'services', 'cable'].flatMap((dir) =>
      readdirSync(join(SRC, dir), { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(dir, name))
        .filter((file) => importsDevice.test(readFileSync(join(SRC, file), 'utf8'))))
    expect(importers).toEqual([])
  })
})
