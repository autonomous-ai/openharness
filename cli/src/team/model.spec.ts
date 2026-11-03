import { describe, expect, it, vi } from 'vitest'
import { buildModelScript, teamModelSet, MODEL_USAGE } from './model.js'
import type { TeamCommandDeps } from './command.js'

const config = { user: 'harnessteam', home: '/home/harnessteam', node: '/home/harnessteam/.harness/runtime/node/bin/node', label: 'harness-team.service' }

function setup(over: Record<string, unknown> = {}) {
  const out: string[] = [], errors: string[] = [], built: Array<{ script: string; files: Record<string, string> }> = []
  const admin = vi.fn(async (build: (stage: string) => { script: string; files?: Record<string, string> }) => {
    built.push(build('/stage') as { script: string; files: Record<string, string> })
    return { ok: true as const, stdout: 'done' }
  })
  const deps = {
    platform: 'linux', out: (line: string) => out.push(line), err: (line: string) => errors.push(line),
    interactive: true, uid: () => 501, readConfig: () => config, admin,
    askSecret: async () => 'sk-test-key', ask: async () => 'sk-test-key', ...over,
  } as unknown as TeamCommandDeps
  return { deps, out, errors, built, admin }
}

describe('harness team model set', () => {
  it('saves the key as a saved API and the engine settings, and says it in two lines', async () => {
    const f = setup()
    expect(await teamModelSet(f.deps, ['model', 'set', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017'], ['--model'])).toBe(0)
    expect(f.admin).toHaveBeenCalledTimes(1)
    const [{ script, files }] = f.built
    expect(script).toContain('api-connections/connections.json')
    expect(script).toContain('systemctl restart')
    expect(files['connections.json']).toContain('"apiKey":"sk-test-key"')
    expect(files['model.json']).toContain('"ANTHROPIC_BASE_URL":"https://openrouter.ai/api"')
    expect(f.out.join('\n')).toContain('now runs Claude Code on OpenRouter · deepseek/deepseek-v4.1-flash-1017')
    expect(f.out.join('\n')).not.toContain('sk-test-key')
  })

  it('refuses without a key, a model, a known provider, or an account, and never on Windows', async () => {
    const noModel = setup()
    expect(await teamModelSet(noModel.deps, ['model', 'set', 'openrouter'], [])).toBe(1)
    expect(noModel.errors.join('\n')).toContain('--model is needed')
    const unknown = setup()
    expect(await teamModelSet(unknown.deps, ['model', 'set', 'nope'], ['--model', 'x'])).toBe(1)
    expect(unknown.errors.join('\n')).toContain('Unknown provider')
    const anthropic = setup()
    expect(await teamModelSet(anthropic.deps, ['model', 'set', 'anthropic'], ['--model', 'claude'])).toBe(1)
    const bare = setup({ readConfig: () => null })
    expect(await teamModelSet(bare.deps, ['model', 'set', 'openrouter'], ['--model', 'x'])).toBe(1)
    expect(bare.errors.join('\n')).toContain('Run harness team setup first')
    const windows = setup({ platform: 'win32' })
    expect(await teamModelSet(windows.deps, ['model', 'set', 'openrouter'], ['--model', 'x'])).toBe(1)
    expect(windows.admin).not.toHaveBeenCalled()
  })

  it('clears it again, and never asks for a key to do so', async () => {
    const asked = vi.fn(async () => 'never')
    const f = setup({ askSecret: asked })
    expect(await teamModelSet(f.deps, ['model', 'set'], ['--clear'])).toBe(0)
    expect(asked).not.toHaveBeenCalled()
    expect(f.built[0]!.script).toContain('rm -f "$DATA/api-connections/connections.json"')
    expect(f.out.join('\n')).toContain('has no model API again')
  })

  it('keeps the usage short enough to read', () => {
    expect(MODEL_USAGE.split('\n').length).toBeLessThan(12)
    expect(MODEL_USAGE).toContain('hidden prompt')
  })
})
