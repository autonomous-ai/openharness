import { describe, expect, it } from 'vitest'
import { realEngineEnvironment, realEnginePlan, redactRealEngineOutput } from './realEnginePolicy.js'

const optedIn = {
  REAL_ENGINES: '1', REAL_ENGINE: 'all',
  CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-claude-secret', OPENAI_API_KEY: 'synthetic-codex-secret',
  REAL_CLAUDE_MODEL: 'test-claude', REAL_CODEX_MODEL: 'test-codex',
}

describe('real-engine opt-in boundary', () => {
  it.each([undefined, '', '0', 'true'])('refuses REAL_ENGINES=%s before creating a fixture', (value) => {
    expect(() => realEnginePlan({ ...optedIn, REAL_ENGINES: value })).toThrow('REAL_ENGINES=1')
  })

  it.each(['CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'TF_BUILD', 'GITLAB_CI', 'JENKINS_URL'])('refuses %s even with explicit opt-in', (key) => {
    expect(() => realEnginePlan({ ...optedIn, [key]: 'true' })).toThrow('never runs in CI')
  })

  it('requires each selected credential and model, without printing credential values', () => {
    expect(() => realEnginePlan({ ...optedIn, CLAUDE_CODE_OAUTH_TOKEN: undefined })).toThrow('CLAUDE_CODE_OAUTH_TOKEN')
    expect(() => realEnginePlan({ ...optedIn, OPENAI_API_KEY: undefined })).toThrow('CODEX_API_KEY or OPENAI_API_KEY')
    expect(() => realEnginePlan({ ...optedIn, REAL_CODEX_MODEL: undefined })).toThrow('REAL_CODEX_MODEL')
    expect(() => realEnginePlan({ ...optedIn, REAL_CLAUDE_MODEL: 'bad\nmodel' })).toThrow('REAL_CLAUDE_MODEL')
    expect(() => realEnginePlan({ ...optedIn, REAL_ENGINE: 'fake' })).toThrow('REAL_ENGINE')
    expect(JSON.stringify(realEnginePlan(optedIn))).not.toContain('secret')
  })

  it('only requires and forwards the selected engine credential', () => {
    const env = { ...optedIn, REAL_ENGINE: 'codex', CLAUDE_CODE_OAUTH_TOKEN: undefined,
      REAL_CLAUDE_MODEL: undefined, CODEX_API_KEY: 'preferred-codex-secret' }
    expect(realEnginePlan(env)).toEqual({ engines: ['codex'], models: { codex: 'test-codex' } })
    const child = realEngineEnvironment(env, '/tmp/real-engine-test')
    expect(child.OPENAI_API_KEY).toBe('preferred-codex-secret')
    expect(child.CODEX_API_KEY).toBeUndefined()
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('replaces every home and refuses inherited shells, providers, sockets, hooks and artifact sinks', () => {
    const child = realEngineEnvironment({ ...optedIn, PATH: '/bin:/usr/bin', LANG: 'C',
      HOME: '/outside', CODEX_HOME: '/outside/codex', CLAUDE_CONFIG_DIR: '/outside/claude',
      TMUX: '/outside/socket,1,0', TMUX_PANE: '%0', TMUX_TMPDIR: '/outside',
      BASH_ENV: '/outside/profile', ENV: '/outside/profile', NODE_OPTIONS: '--require=/outside/hook',
      ANTHROPIC_API_KEY: 'wrong-account', ANTHROPIC_BASE_URL: 'https://outside.invalid',
      OPENAI_BASE_URL: 'https://outside.invalid', HARNESS_AUTH_DIR: '/outside/auth',
      E2E_ARTIFACTS_DIR: '/outside/artifacts', E2E_BUNDLE_PATH: '/outside/cli.js',
      CLAUDE_PATH: '/outside/fake', CODEX_PATH: '/outside/fake', ADAPTER_DATA_DIR: '/outside/data',
    }, '/tmp/real-engine-test')
    expect(child.PATH).toBe('/bin:/usr/bin')
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe(optedIn.CLAUDE_CODE_OAUTH_TOKEN)
    for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'ZDOTDIR', 'TMPDIR', 'TMUX_TMPDIR',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'ADAPTER_DATA_DIR',
      'ADAPTER_RUNTIME_DIR', 'HARNESS_AUTH_DIR', 'DSH_DIR', 'npm_config_cache']) {
      expect(child[key], key).toMatch(/^\/tmp\/real-engine-test\//)
    }
    for (const key of ['TMUX', 'TMUX_PANE', 'BASH_ENV', 'ENV', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'E2E_ARTIFACTS_DIR', 'E2E_BUNDLE_PATH', 'CLAUDE_PATH', 'CODEX_PATH']) {
      expect(child[key], key).toBeUndefined()
    }
    expect(child.SHELL).toBe('/bin/sh')
    expect(() => realEngineEnvironment(optedIn, 'relative')).toThrow('absolute')
  })

  it('redacts exact secrets, account paths and email before output is persisted', () => {
    const text = 'synthetic-codex-secret and synthetic-claude-secret /home/example/.codex user@example.invalid /tmp/run/private'
    const redacted = redactRealEngineOutput(text, optedIn, '/tmp/run')
    expect(redacted).toBe('[redacted] and [redacted] <home>/.codex <email> <run>/private')
    expect(redactRealEngineOutput('safe output', {}, '/tmp/run')).toBe('safe output')
  })
})
