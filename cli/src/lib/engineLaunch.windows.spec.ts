// The engine version probe on Windows (commandOutputInInteractiveShell), run on any OS with the platform set to win32:
// no shell runs it there, so it must run the npm shim as node on its script, and never open a console window
// (docs/windows-rules.md, rule 1). The OpenClaw shim is npm's cmd-shim (lib/windows/fixtures/npm-codex.cmd), renamed.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => [] as Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }>)
vi.mock('node:child_process', async (real) => {
  const actual = await real<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: ((file: string, args: readonly string[], options: Record<string, unknown>, done: unknown) => {
      spawned.push({ file, args, options })
      return (actual.execFile as unknown as (...a: unknown[]) => unknown)(file, args, options, done)
    }) as unknown as typeof actual.execFile,
  }
})

const { commandOutputInInteractiveShell } = await import('./engineLaunch.js')

const dirs: string[] = []
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const path = process.env.PATH
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  process.env.PATH = path
  spawned.splice(0)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the engine version probe on Windows', () => {
  it('runs an npm engine as node on its script, with no console window', async () => {
    const npm = mkdtempSync(join(tmpdir(), 'win-probe-'))
    dirs.push(npm)
    const shim = readFileSync(join(import.meta.dirname, 'windows', 'fixtures', 'npm-codex.cmd'), 'utf8')
      .replaceAll('@openai\\codex\\bin\\codex.js', 'openclaw\\openclaw.mjs')
    writeFileSync(join(npm, 'openclaw.cmd'), shim)
    const script = join(npm, 'node_modules', 'openclaw', 'openclaw.mjs')
    mkdirSync(join(script, '..'), { recursive: true })
    writeFileSync(script, '')
    // The node beside the shim, standing in for node.exe: it prints what it was asked to run.
    writeFileSync(join(npm, 'node.exe'), '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    chmodSync(join(npm, 'node.exe'), 0o700)
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    process.env.PATH = npm
    const ran = await commandOutputInInteractiveShell('openclaw', 'openclaw', ['--version'])
    expect(spawned).toEqual([{ file: join(npm, 'node.exe'), args: [script, '--version'], options: expect.objectContaining({ windowsHide: true }) }])
    expect(ran).toEqual({ code: 0, output: `${script}\n--version\n\n` })
  })
})
