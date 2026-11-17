import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENV_FIELD_NAMES } from '../config/env.js'
import { AGENT_SESSION_VARIABLES, ORCA_VARIABLES } from './agentSessionEnv.js'
import {
  DROPPED_ON_PURPOSE, START_ENV_NAMES, START_ENV_PREFIXES, narrowOwnEnvironment, startEnvironment, startEnvLine,
} from './startEnvironment.js'

// Made up, every value (docs/plans/2026-11-17-daemon-minimal-env-design.md).
const OUTSIDERS = {
  SENTINEL_TOKEN: 's', GH_TOKEN: 'g', NODE_OPTIONS: '--require /fake/hook.cjs', CLAUDE_CODE_MESSAGING_TOKEN: 't',
  CODEX_THREAD_ID: 'c', ORCA_PAIRING_CODE: 'p', HARNESS_AGENT_SESSION: '1', TERM: 'xterm-256color',
  HC_SESSION: 'h', TYPESAFE_CREDENTIALS: 'tc', GIT_SSH_COMMAND: 'ssh -i /fake/key',
  CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-sentinel',
}
const KEPT = {
  PATH: '/bin', HOME: '/h', LC_ALL: 'C.UTF-8', HTTPS_PROXY: 'http://p:1', https_proxy: 'http://p:1',
  ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'dev', CODEX_HOME: '/h/.codex',
  CLAUDE_CONFIG_DIR: '/h/.claude', CURSOR_CONFIG_DIR: '/h/.cursor', HC_SOCKET: '/h/hc.sock', XAUTHORITY: '/run/x',
  SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22', npm_config_prefix: '/h/.local', ADAPTER_DATA_DIR: '/d',
  HARNESS_ENV_FILE: '/h/harness.env',
}

describe('the environment harness start gives the daemon', () => {
  it('keeps what Harness and its engines need and drops every outsider', () => {
    const shell = { ...KEPT, ...OUTSIDERS }
    expect(startEnvironment(shell, 'darwin')).toEqual(KEPT)
    expect(startEnvironment(shell, 'linux')).toEqual(KEPT)
    // A copy: the shell keeps its own.
    expect(shell.SENTINEL_TOKEN).toBe('s')
  })
  it('keeps every variable config/env.ts reads', () => {
    expect(ENV_FIELD_NAMES).toEqual(expect.arrayContaining(['PORT', 'BACKEND_WS_URL', 'CODEX_HOME', 'CLAUDE_PATH']))
    for (const name of ENV_FIELD_NAMES) expect(startEnvironment({ [name]: 'x' }, 'linux'), name).toEqual({ [name]: 'x' })
  })
  // Read through a parameter, so the read-coverage test cannot see them (decisions 3, 6, 7 and 9).
  it.each(['CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'OPENCODE_DB', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'KILO_DB',
    'GRID_HOME', 'GRID_CONTROL_PLANE_URL', 'LLAMA_SERVER', 'HC_SOCKET', 'SSH_CONNECTION', 'ZDOTDIR', 'WSL_DISTRO_NAME',
    'XAUTHORITY', 'npm_config_prefix', 'BROWSER'])('keeps the setting %s', (name) => {
    expect(startEnvironment({ [name]: 'x' }, 'linux')).toEqual({ [name]: 'x' })
  })
  it('keeps each provider by its own prefix, and nothing because it looks like a secret', () => {
    const providers = {
      ANTHROPIC_AUTH_TOKEN: 'a', OPENAI_API_KEY: 'o', AWS_SECRET_ACCESS_KEY: 'w', GOOGLE_APPLICATION_CREDENTIALS: '/g',
      GEMINI_API_KEY: 'g', AZURE_OPENAI_API_KEY: 'z', OPENROUTER_API_KEY: 'r', XAI_API_KEY: 'x', CLOUD_ML_REGION: 'us', CLAUDE_CODE_USE_VERTEX: '1',
    }
    expect(startEnvironment({ ...providers, NPM_TOKEN: 'n', STRIPE_API_KEY: 's', MY_SECRET_KEY: 'k' }, 'linux')).toEqual(providers)
    expect(START_ENV_PREFIXES).toEqual(['LC_', 'XDG_', 'HARNESS_', 'HARNESSD_', 'ADAPTER_', 'ANTHROPIC_', 'OPENAI_', 'AWS_',
      'GOOGLE_', 'GEMINI_', 'AZURE_', 'OPENROUTER_', 'XAI_', 'CLAUDE_CODE_USE_'])
    expect(START_ENV_NAMES).toEqual(expect.arrayContaining(['SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING', 'TMUX_TMPDIR',
      'DBUS_SESSION_BUS_ADDRESS', 'NODE_EXTRA_CA_CERTS', 'DOTENV_CONFIG_PATH', 'PI_CODING_AGENT_SESSION_DIR']))
  })
  it('drops every agent session variable, under an allowed prefix too', () => {
    const session = Object.fromEntries([...AGENT_SESSION_VARIABLES, ...ORCA_VARIABLES, 'ORCA_FUTURE_SETTING'].map((name) => [name, 'x']))
    expect(startEnvironment({ PATH: '/bin', TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3', ...session }, 'linux')).toEqual({ PATH: '/bin' })
  })
  it('drops every name it drops on purpose, each with its reason', () => {
    expect(Object.keys(DROPPED_ON_PURPOSE)).toEqual(expect.arrayContaining(['TERM', 'COLORTERM', 'NODE_OPTIONS', 'TMUX',
      'TMUX_PANE', 'HC_SESSION', 'TYPESAFE_CREDENTIALS', 'GIT_SSH_COMMAND', 'CLAUDE_CODE_OAUTH_TOKEN']))
    for (const [name, why] of Object.entries(DROPPED_ON_PURPOSE)) {
      expect(why.trim(), name).not.toBe('')
      expect(startEnvironment({ [name]: 'x' }, 'linux'), name).toEqual({})
    }
  })
  it('on Windows keeps the whole environment, as before (decision 5)', () => {
    const shell = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', JAVA_HOME: 'C:\\jdk', SENTINEL_TOKEN: 's', CLAUDECODE: '1' }
    const kept = startEnvironment(shell, 'win32')
    expect(kept).toEqual(shell)
    expect(kept).not.toBe(shell)
  })
  it('keeps a variable set to nothing: empty is a setting', () => {
    expect(startEnvironment({ HARNESS_GRID_BIN: '', PATH: '' }, 'linux')).toEqual({ HARNESS_GRID_BIN: '', PATH: '' })
  })
  it('takes a prefix only with its underscore, and a name only as spelled', () => {
    expect(startEnvironment({ HARNESSX: 'x', HARNESS: 'x', AWS: 'x', LC: 'x', XDG: 'x', ANTHROPIC: 'x', CLAUDE_CODE_USER: 'x',
      CLAUDE_CODE_SESSION_ID: 'x', Path: '/bin', path: '/bin', systemroot: '/x' }, 'linux')).toEqual({})
  })
  it('gives the same answer for an environment it narrowed already', () => {
    const once = startEnvironment({ ...KEPT, ...OUTSIDERS }, 'darwin')
    expect(startEnvironment(once, 'darwin')).toEqual(once)
  })
  it('says how many variables a start left out, and never which', () => {
    const given = { PATH: '/bin', HOME: '/h', SENTINEL_TOKEN: 'sentinel-value', GH_TOKEN: 'g', TERM: 'x' }
    expect(startEnvLine(given, startEnvironment(given, 'linux')))
      .toBe('[env] started with 2 variables; 3 left out (docs/cli.md#the-daemons-environment)')
  })
})

describe('a start that becomes the daemon', () => {
  let folder: string
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'start-env-')) })
  afterEach(() => { rmSync(folder, { recursive: true, force: true }) })

  it('narrows an environment in place, then reads the env file again', () => {
    const file = join(folder, 'harness.env')
    writeFileSync(file, 'FROM_FILE=in-the-file\nSENTINEL_TOKEN=from-the-file\n')
    // As config/loadEnv.ts left it when the CLI loaded: FROM_FILE read from the file, SENTINEL_TOKEN the shell's own.
    const env: NodeJS.ProcessEnv = { PATH: '/bin', HARNESS_ENV_FILE: file, FROM_FILE: 'in-the-file', SENTINEL_TOKEN: 'from-the-shell', GH_TOKEN: 'g' }
    const line = narrowOwnEnvironment(env, 'darwin')
    // The shell's token is gone; what the person put in the file is the daemon's, as after a background start.
    expect(env).toEqual({ PATH: '/bin', HARNESS_ENV_FILE: file, FROM_FILE: 'in-the-file', SENTINEL_TOKEN: 'from-the-file' })
    // Only GH_TOKEN is gone: FROM_FILE and SENTINEL_TOKEN came back from the file.
    expect(line).toBe('[env] started with 4 variables; 1 left out (docs/cli.md#the-daemons-environment)')
  })
  it('counts what the env file gives a background start\'s daemon as its own, not as left out', () => {
    const file = join(folder, 'harness.env')
    writeFileSync(file, 'FROM_FILE=in-the-file\n')
    // The CLI read the file as it loaded; the daemon it spawns reads it again as it starts (config/loadEnv.ts).
    const given: NodeJS.ProcessEnv = { PATH: '/bin', HARNESS_ENV_FILE: file, FROM_FILE: 'in-the-file', GH_TOKEN: 'g' }
    expect(startEnvLine(given, startEnvironment(given, 'linux')))
      .toBe('[env] started with 3 variables; 1 left out (docs/cli.md#the-daemons-environment)')
  })
  it('narrows with no env file named', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/h', CLAUDE_CODE_MESSAGING_TOKEN: 't', NODE_OPTIONS: '--require /fake/hook.cjs' }
    expect(narrowOwnEnvironment(env, 'linux')).toBe('[env] started with 1 variables; 2 left out (docs/cli.md#the-daemons-environment)')
    expect(env).toEqual({ HOME: '/h' })
  })
  it('on Windows takes nothing out', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows', JAVA_HOME: 'C:\\jdk', SENTINEL_TOKEN: 's' }
    expect(narrowOwnEnvironment(env, 'win32')).toBe('[env] started with 3 variables; 0 left out (docs/cli.md#the-daemons-environment)')
    expect(env).toEqual({ Path: 'C:\\Windows', JAVA_HOME: 'C:\\jdk', SENTINEL_TOKEN: 's' })
  })
})
