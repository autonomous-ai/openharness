import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url))
const loader = fileURLToPath(new URL('./loadEnv.ts', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-env-'))
  roots.push(root)
  writeFileSync(join(root, '.env'), 'BACKEND_WS_URL=ws://sandbox.invalid:8090\nAUTONOMOUS_ENV=stag\nADAPTER_DATA_DIR=/sandbox/data\nHARNESS_AUTH_DIR=/sandbox/auth\nPORT=3000\n')
  return root
}

function run(cwd: string, overrides: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env }
  for (const key of ['BACKEND_WS_URL', 'AUTONOMOUS_ENV', 'ADAPTER_DATA_DIR', 'HARNESS_AUTH_DIR', 'PORT', 'HARNESS_ENV_FILE', 'DOTENV_CONFIG_PATH']) delete childEnv[key]
  const script = `import ${JSON.stringify(loader)}; console.log(JSON.stringify(Object.fromEntries(['BACKEND_WS_URL','AUTONOMOUS_ENV','ADAPTER_DATA_DIR','HARNESS_AUTH_DIR','PORT'].map(k => [k, process.env[k] ?? null]))));`
  return spawnSync(process.execPath, [tsx, '--eval', script], { cwd, env: { ...childEnv, ...overrides }, encoding: 'utf8', timeout: 10_000 })
}

describe('Harness environment loading', () => {
  it('does not adopt a project .env when a user starts Harness from that folder', () => {
    const result = run(project())
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ BACKEND_WS_URL: null, AUTONOMOUS_ENV: null, ADAPTER_DATA_DIR: null, HARNESS_AUTH_DIR: null, PORT: null })
  })

  it('uses an explicitly selected file from any project, with exported variables taking precedence', () => {
    const root = project()
    const other = join(root, 'another-project')
    mkdirSync(other)
    const file = join(root, 'harness.env')
    writeFileSync(file, 'BACKEND_WS_URL=ws://chosen.invalid:8090\nAUTONOMOUS_ENV=stag\nADAPTER_DATA_DIR=/chosen/data\nHARNESS_AUTH_DIR=/chosen/auth\n')
    for (const cwd of [root, other]) {
      const result = run(cwd, { HARNESS_ENV_FILE: file, AUTONOMOUS_ENV: 'prod' })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ BACKEND_WS_URL: 'ws://chosen.invalid:8090', AUTONOMOUS_ENV: 'prod', ADAPTER_DATA_DIR: '/chosen/data', HARNESS_AUTH_DIR: '/chosen/auth', PORT: null })
    }
  })

  it('keeps explicitly configured DOTENV_CONFIG_PATH working', () => {
    const root = project()
    const result = run(root, { DOTENV_CONFIG_PATH: join(root, '.env') })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ BACKEND_WS_URL: 'ws://sandbox.invalid:8090', AUTONOMOUS_ENV: 'stag' })
  })

  it('fails clearly if the explicitly selected environment file cannot be read', () => {
    const root = project()
    const result = run(root, { HARNESS_ENV_FILE: join(root, 'missing.env') })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Cannot read Harness environment file')
  })
})
