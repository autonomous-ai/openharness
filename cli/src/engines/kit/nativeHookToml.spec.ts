import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installNativeTomlHooks, type NativeHookTomlSettings } from './nativeHookToml.js'

/** Kimi's shape, aimed at a throwaway config.toml — never the developer's real file (cli/AGENTS.md). */
function rule(file: string): NativeHookTomlSettings {
  return {
    file,
    engine: 'kimi',
    events: ['SessionStart', 'SessionEnd', 'StopFailure'],
    timeout: 5,
    startMarker: '# harness:kimi-hooks:start',
    endMarker: '# harness:kimi-hooks:end',
    messages: {
      current: 'current',
      installed: 'installed {file}',
      failed: 'failed',
    },
  }
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-hooks-'))
  const environment = { HOME: dir, PATH: process.env.PATH ?? '' }
  const file = join(dir, 'config.toml')
  const install = (port = 1234) => installNativeTomlHooks(rule(file), port, { environment })
  return { dir, file, install }
}

const MANAGED_RE = /# harness:kimi-hooks:start\n(\[\[hooks\]\]\nevent = "[^"]+"\ncommand = "[^"]*notify\.mjs[^"]*"\ntimeout = 5\n)+# harness:kimi-hooks:end\n/

describe('installNativeTomlHooks', () => {
  it('creates a missing config.toml with only the managed block', async () => {
    const { file, install } = workspace()
    await expect(install()).resolves.toBe(true)
    const content = readFileSync(file, 'utf8')
    expect(content).toMatch(MANAGED_RE)
    expect(content.match(/\[\[hooks\]\]/g)).toHaveLength(3)
  })

  it('appends to a foreign config, preserving every line of it', async () => {
    const { file, install } = workspace()
    const foreign = '[providers.kimi]\napi_key = "sk-real"\n\n[[hooks]]\nevent = "Notification"\ncommand = "notify-send done"\n'
    writeFileSync(file, foreign)
    await expect(install()).resolves.toBe(true)
    const content = readFileSync(file, 'utf8')
    expect(content.startsWith(foreign)).toBe(true)
    expect(content.slice(foreign.length)).toMatch(MANAGED_RE)
    // The person's own hook and provider survive untouched.
    expect(content).toContain('notify-send done')
    expect(content).toContain('sk-real')
  })

  it('rewrites the managed block in place when the port drifts, leaving foreign content alone', async () => {
    const { file, install } = workspace()
    writeFileSync(file, '# my preamble\n\n[experimental]\ntower = true\n')
    await install(1111)
    await install(2222)
    const content = readFileSync(file, 'utf8')
    expect(content).toMatch(MANAGED_RE)
    expect(content).toContain('--port 2222')
    expect(content).not.toContain('--port 1111')
    expect(content).toContain('tower = true')
    expect(content.indexOf('tower = true')).toBeLessThan(content.indexOf('# harness:kimi-hooks:start'))
    // Still valid TOML with both the foreign table and three hook entries.
    const { parse } = await import('smol-toml')
    const parsed = parse(content) as { hooks: Array<{ event: string; command: string }> }
    expect(parsed.hooks).toHaveLength(3)
  })

  it('refuses a malformed config.toml and leaves it byte for byte', async () => {
    const { file, install } = workspace()
    const broken = 'this is [not toml'
    writeFileSync(file, broken)
    await expect(install()).resolves.toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(broken)
  })

  it('refuses a start marker without its end marker rather than guessing the span', async () => {
    const { file, install } = workspace()
    const handEdited = '# harness:kimi-hooks:start\n[[hooks]]\nevent = "SessionStart"\n'
    writeFileSync(file, handEdited)
    await expect(install()).resolves.toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(handEdited)
  })

  it('does not write at all when the block is current', async () => {
    const { file, install } = workspace()
    await install(3333)
    const before = readFileSync(file, 'utf8')
    await install(3333)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('does not install on Windows, where the hook runner is unverified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-hooks-'))
    const file = join(dir, 'config.toml')
    await expect(installNativeTomlHooks(rule(file), 1, {}, 'win32')).resolves.toBe(true)
    expect(existsSync(file)).toBe(false)
  })
})
