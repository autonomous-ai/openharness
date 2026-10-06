import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// env.ts reads the environment once, as it loads: each case is a process of its own, in a throwaway
// home, so the legacy-state adoption it runs on load never sees a real ~/.harness.
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url))
const module = fileURLToPath(new URL('./env.ts', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const READ = ['NODE_ENV', 'PORT', 'WEB_URL', 'HARNESS_STORE_REF', 'HARNESS_STORE_CATALOG_URL', 'HOOK_INSTALL_ENGINES', 'TERMINAL_BACKENDS', 'RECAP_WITHOUT_DEVICE', 'DISABLE_HOOK_INSTALL', 'TERMINAL_RECONCILE_INTERVAL_MS', 'ADAPTER_DATA_DIR']

function load(variables: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'harness-env-'))
  roots.push(home)
  const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, ADAPTER_DATA_DIR: join(home, 'data'), ...variables }
  const script = `import { env } from ${JSON.stringify(module)}; console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(READ)}.map((k) => [k, env[k] instanceof Set ? [...env[k]] : env[k] ?? null]))))`
  const run = spawnSync(process.execPath, [tsx, '--eval', script], { cwd: home, env: childEnv, encoding: 'utf8', timeout: 20_000 })
  return { status: run.status, stderr: run.stderr, env: run.status === 0 ? JSON.parse(run.stdout) as Record<string, unknown> : null, home }
}

describe('the environment, as env.ts reads it', () => {
  it('fills what is unset with its default, and reads what is set as its kind', () => {
    const plain = load({})
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.env).toEqual({
      NODE_ENV: 'development', PORT: 18473, WEB_URL: 'https://harness.autonomous.ai', HARNESS_STORE_REF: null, HARNESS_STORE_CATALOG_URL: null,
      HOOK_INSTALL_ENGINES: null, TERMINAL_BACKENDS: null, RECAP_WITHOUT_DEVICE: true, DISABLE_HOOK_INSTALL: false,
      TERMINAL_RECONCILE_INTERVAL_MS: null, ADAPTER_DATA_DIR: join(plain.home, 'data'),
    })
    const set = load({
      NODE_ENV: 'test', PORT: '9123', BACKEND_WS_URL: 'ws://localhost:8090', HARNESS_STORE_REF: 'feature/x', HARNESS_STORE_CATALOG_URL: ' http://127.0.0.1:9/c ',
      HOOK_INSTALL_ENGINES: 'claude, codex,', TERMINAL_BACKENDS: 'tmux', RECAP_WITHOUT_DEVICE: 'false', DISABLE_HOOK_INSTALL: 'true', TERMINAL_RECONCILE_INTERVAL_MS: '6000',
    })
    expect(set.status, set.stderr).toBe(0)
    expect(set.env).toMatchObject({
      NODE_ENV: 'test', PORT: 9123, WEB_URL: 'http://localhost:3000', HARNESS_STORE_REF: 'feature/x', HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/c',
      HOOK_INSTALL_ENGINES: ['claude', 'codex'], TERMINAL_BACKENDS: ['tmux'], RECAP_WITHOUT_DEVICE: false, DISABLE_HOOK_INSTALL: true,
      TERMINAL_RECONCILE_INTERVAL_MS: 6000,
    })
  })

  it('ignores a store setting it cannot use, which under zod stopped every `harness` command as it loaded', () => {
    const loaded = load({ HARNESS_STORE_CATALOG_URL: 'not a url', HARNESS_STORE_REF: 'not a ref!' })
    expect(loaded.status, loaded.stderr).toBe(0)
    expect(loaded.env).toMatchObject({ HARNESS_STORE_CATALOG_URL: null, HARNESS_STORE_REF: null })
  })

  it('stops, naming every variable it cannot use and why', () => {
    const loaded = load({ NODE_ENV: 'staging', TERMINAL_BACKENDS: 'nonsense' })
    expect(loaded.status).toBe(1)
    expect(loaded.stderr).toContain('Invalid environment variables:')
    expect(loaded.stderr).toContain('NODE_ENV')
    expect(loaded.stderr).toContain('expected one of "development"|"production"|"test"')
    expect(loaded.stderr).toContain('TERMINAL_BACKENDS')
    const tooOften = load({ TERMINAL_RECONCILE_INTERVAL_MS: '100' })
    expect(tooOften.status).toBe(1)
    expect(tooOften.stderr).toContain('TERMINAL_RECONCILE_INTERVAL_MS must be at least 5000')
  })
})
