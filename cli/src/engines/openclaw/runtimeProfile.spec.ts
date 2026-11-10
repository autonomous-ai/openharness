import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { inspectRuntimePane } from '../../lib/legacyPane.js'
import { parseRuntimeProfile } from '../../lib/runtimeProfileWire.js'
import {
  createRuntimeProfileReader, parseOpenclawFooter, type OpenclawFooter,
} from './runtimeProfile.js'
import { readOpenclawScreen } from './contract.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const screen = (name: string): string => readFileSync(join(dir, `screen-${name}.txt`), 'utf8')
const openclawPaneState = (capture: string) => readOpenclawScreen(capture).state

describe('OpenClaw pane state', () => {
  it.each([
    ['plain', 'ready'], ['plain-darwin', 'ready'], ['plain-start', 'ready'], ['plain-start-darwin', 'ready'],
    ['tool', 'ready'], ['reset', 'ready'], ['main-heartbeat', 'ready'], ['two-panes-main-b', 'ready'],
    ['no-gateway-reconnected', 'ready'],
    ['abort', 'ready'], ['fail', 'ready'], ['fail-model', 'ready'], ['approval', 'ready'],
    ['abort-running', 'busy'],
    ['no-gateway', 'no-gateway'], ['no-gateway-bare', 'no-gateway'], ['no-gateway-attached', 'no-gateway'],
    ['no-token', 'no-token'],
    ['remote', 'remote'],
  ])('%s is %s', (name, state) => {
    expect(openclawPaneState(screen(name))).toBe(state)
  })

  it('reads a streaming or connecting status as busy', () => {
    const base = screen('plain')
    expect(openclawPaneState(base.replace(' connected | idle', ' ⠋ streaming • 3s | connected'))).toBe('busy')
    expect(openclawPaneState(base.replace(' connected | idle', ' ⠋ connecting • 1s'))).toBe('busy')
  })

  it('is null for a screen that is not OpenClaw', () => {
    expect(openclawPaneState('$ ls\nfoo bar\n')).toBeNull()
    expect(openclawPaneState('')).toBeNull()
    expect(openclawPaneState('minimax/minimax-m3 • high\n')).toBeNull()
  })

  it('is null for an OpenClaw header with a status it does not know', () => {
    expect(openclawPaneState(' openclaw tui - ws://127.0.0.1:18789 - agent main - session x\n  something | odd\n agent main | session x | m/m | deliver:off | tokens ?\n')).toBeNull()
  })
})

describe('OpenClaw footer', () => {
  it('reads the model and the tokens', () => {
    expect(parseOpenclawFooter(screen('main-heartbeat'))).toEqual<OpenclawFooter>({
      model: 'deepseek/deepseek-v4.1-flash', effort: null, tokens: '19k/1.0m',
    })
  })

  it('reads them at 160 columns, on one line', () => {
    expect(parseOpenclawFooter(screen('two-panes-main-a'))?.tokens).toBe('18k/1.0m')
    expect(parseOpenclawFooter(screen('plain'))).toEqual({ model: 'deepseek/deepseek-v4.1-flash', effort: null, tokens: '0/1.0m' })
  })

  it('reads them at 80 columns, where the footer wraps', () => {
    const wrapped = parseOpenclawFooter(screen('two-panes-main-b'))
    expect(wrapped).toEqual({ model: 'deepseek/deepseek-v4.1-flash', effort: null, tokens: '18k/1.0m' })
  })

  it('reads a footer wrapped inside the token cell', () => {
    expect(parseOpenclawFooter(screen('reset-new'))).toEqual({ model: 'deepseek/deepseek-v4.1-flash', effort: null, tokens: null })
  })

  it('reads the thinking level next to the model', () => {
    expect(parseOpenclawFooter(screen('model-switch')))
      .toEqual({ model: 'deepseek/deepseek-v4-flash-0731', effort: 'high', tokens: '19k/1.0m' })
  })

  it('has no tokens while the count is unknown, and no model before the Gateway answers', () => {
    expect(parseOpenclawFooter(screen('plain-start'))).toEqual({ model: 'deepseek/deepseek-v4.1-flash', effort: null, tokens: null })
    expect(parseOpenclawFooter(screen('no-gateway'))).toBeNull()
  })

  it('is null off an OpenClaw screen', () => {
    expect(parseOpenclawFooter('$ ls\n')).toBeNull()
  })
})

describe('OpenClaw pane inspection', () => {
  it('is idle when ready with an empty composer', () => {
    expect(inspectRuntimePane('openclaw', screen('plain'))).toEqual({ idle: true, plan: false, dialog: false, draft: false })
  })

  it('is not idle while busy, disconnected or unknown', () => {
    expect(inspectRuntimePane('openclaw', screen('abort-running')).idle).toBe(false)
    expect(inspectRuntimePane('openclaw', screen('no-gateway')).idle).toBe(false)
    expect(inspectRuntimePane('openclaw', 'plain shell').idle).toBe(false)
  })

  it('sees a draft in the composer', () => {
    const drafted = screen('plain').replace(/(─{8,}\n)\n(─{8,})/, '$1half a sentence\n$2')
    expect(drafted).not.toBe(screen('plain'))
    expect(inspectRuntimePane('openclaw', drafted)).toMatchObject({ idle: false, draft: true })
  })
})

describe('OpenClaw runtime profile reader', () => {
  const context = (sessionId = 'agent:main:plain') => ({
    session: { sessionId } as never,
    state: { model: null as string | null, effort: null as string | null, mode: 'default' as const, cliVersion: null, observedAt: null as number | null },
    refreshConfig() {},
  })

  it('takes the model and the thinking level from the pane', () => {
    const reader = createRuntimeProfileReader()
    const ctx = context()
    reader.pane?.(ctx, screen('model-switch'))
    expect(ctx.state.model).toBe('deepseek/deepseek-v4-flash-0731')
    expect(ctx.state.effort).toBe('high')
    expect(ctx.state.observedAt).not.toBeNull()
    expect(reader.tokens('agent:main:plain')).toBe('19k/1.0m')
  })

  it('leaves the state alone on a pane with no footer', () => {
    const reader = createRuntimeProfileReader()
    const ctx = context()
    expect(reader.pane?.(ctx, screen('no-gateway'))).toBe(false)
    expect(ctx.state.model).toBeNull()
  })

  it('keeps the workspace from the session header, per session', () => {
    const reader = createRuntimeProfileReader()
    const a = context('agent:main:a')
    const b = context('agent:main:b')
    reader.transcript?.(a, { type: 'session', cwd: '/root/.openclaw/workspace' })
    reader.transcript?.(b, { type: 'session', cwd: '/' })
    expect(reader.workspace('agent:main:a')).toBe('/root/.openclaw/workspace')
    // `/` is the Gateway's own folder, which a session made by /model before any message records.
    expect(reader.workspace('agent:main:b')).toBeNull()
    reader.forget?.('agent:main:a')
    expect(reader.workspace('agent:main:a')).toBeNull()
  })
})

describe('OpenClaw runtime profile id', () => {
  it('parses on the wire', () => {
    expect(parseRuntimeProfile('runtime-v1:agent%3Amain%3Aplain:openclaw:deepseek%2Fdeepseek-v4.1-flash@high'))
      .toMatchObject({ engine: 'openclaw', model: 'deepseek/deepseek-v4.1-flash', effort: 'high' })
  })
})
