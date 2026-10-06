import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RegisteredSession } from './registry.js'
import {
  codexEffortAllowed,
  encodeRuntimeProfile,
  parseRuntimeProfile,
  parseCursorModelsOutput,
  RuntimeProfileManager,
  supportsNativeRuntimeControl,
} from './runtimeProfile.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function session(engine: RegisteredSession['engine']): RegisteredSession {
  return {
    schemaVersion: 2,
    active: true,
    sessionId: 'session:1', engine, launcherId: 'h1', agentId: 'h1', boundAt: 0, transcriptPath: '/tmp/session.jsonl', projectDir: 'tmp', cwd: '/tmp',
    tmuxPane: '%1', source: null, title: null, model: null,
    runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\u0000%1',
    cliVersion: engine === 'codex' ? '0.144.5' : engine === 'cursor' ? '2026.07.20-8cc9c0b' : '2.1.212', processIdentity: null,
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

describe('RuntimeProfileManager', () => {
  it('keeps agents that have not bound a session yet out of one another state', () => {
    // An agent awaiting its first bind carries `sessionId: ''`, which is not an identity: keyed on it,
    // EVERY unbound agent shared one entry, across engines. Measured — a claude agent ten seconds old
    // was retargeted onto a grid, the "what model was it on?" read answered `opencode/big-pickle`
    // (an OpenCode agent had sat at `''` first), and the pane came home with
    // `ANTHROPIC_MODEL=opencode/big-pickle`. Claude Code: "There's an issue with the selected model".
    const manager = new RuntimeProfileManager()
    const unboundOpencode = { ...session('opencode'), sessionId: '' }
    const unboundClaude = { ...session('claude'), sessionId: '' }

    manager.ingestPane(unboundOpencode, '  ┃  Build · Big Pickle OpenCode Zen', true)

    // Not "the other agent's model" and not the first agent's own either: with no session there is
    // nowhere to keep one, which is the truth about an engine that has not started talking yet.
    expect(manager.selectedModel(unboundClaude)).toBeNull()
    expect(manager.selectedModel(unboundOpencode)).toBeNull()
    // A bound agent is unaffected — the fix removes a shared bucket, not the feature.
    const bound = session('codex')
    manager.ingestPane(bound, 'gpt-5.6-terra  high  ·', true)
    expect(parseRuntimeProfile(manager.selectedModel(bound))).toMatchObject({
      engine: 'codex', model: 'gpt-5.6-terra', effort: 'high',
    })
  })

  it('takes Codex Max and Ultra where its catalog lists them', async () => {
    // 0.160's catalog lists them for the GPT-6 models the old slug list left out, and leaves Ultra off GPT-6-Luna.
    expect(codexEffortAllowed('gpt-6.1-sol', 'ultra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).toBe(true)
    expect(codexEffortAllowed('gpt-6-luna', 'ultra', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe(false)
    // The catalog outranks the slug list both ways.
    expect(codexEffortAllowed('gpt-5.6-sol', 'max', ['low', 'high'])).toBe(false)
    expect(codexEffortAllowed('gpt-5.4', 'xhigh', [])).toBe(true)
    expect(codexEffortAllowed('gpt-6.1-sol', 'turbo', ['turbo'])).toBe(false)

    const manager = new RuntimeProfileManager()
    const value = { ...session('codex'), codexHome: join(import.meta.dirname, '__fixtures__', 'codex-home-0.160') }
    manager.hydrate(value, [JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', reasoning_effort: 'ultra' } })])
    const offered = (await manager.modelsForSession(value)).map((option) => parseRuntimeProfile(option.id))
      .map((profile) => `${profile?.model}@${profile?.effort}`)
    expect(offered).toEqual(expect.arrayContaining(['gpt-6.1-sol@max', 'gpt-6.1-sol@ultra', 'gpt-6-astra@ultra', 'gpt-6-luna@max']))
    expect(offered).not.toContain('gpt-6-luna@ultra')
    expect(offered).not.toContain('gpt-5.5@max')
  })

  it('limits Codex Max and Ultra to GPT-5.6 models when there is no catalog to ask', () => {
    expect(codexEffortAllowed('gpt-5.6-sol', 'max')).toBe(true)
    expect(codexEffortAllowed('gpt-5.6-terra', 'ultra')).toBe(true)
    expect(codexEffortAllowed('codex-auto-review', 'ultra')).toBe(true)
    expect(codexEffortAllowed('gpt-5.5', 'max')).toBe(false)
    expect(codexEffortAllowed('gpt-5.3-codex-spark', 'ultra')).toBe(false)
    expect(codexEffortAllowed('gpt-5.4', 'xhigh')).toBe(true)
  })

  it('round trips opaque session-scoped profiles', () => {
    const id = encodeRuntimeProfile({ sessionId: 'session:1', engine: 'codex', model: 'provider/model:v2', effort: 'xhigh' })
    expect(parseRuntimeProfile(id)).toEqual({
      id, sessionId: 'session:1', engine: 'codex', model: 'provider/model:v2', effort: 'xhigh',
    })
    expect(parseRuntimeProfile('runtime-v1:session%3A1:codex:gpt-5.6-sol@ultra')).toMatchObject({
      sessionId: 'session:1', engine: 'codex', model: 'gpt-5.6-sol', effort: 'ultra',
    })
    expect(parseRuntimeProfile('runtime-v1:%ZZ:codex:model@high')).toBeNull()

    // Every engine that can produce options must also parse them back. Widening the picker to a new
    // engine and forgetting this line is silent: the id round-trips through web and device fine, then
    // setProfile rejects it as INVALID_RUNTIME_PROFILE the moment someone picks a row.
    for (const engine of ['claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes', 'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok']) {
      expect(parseRuntimeProfile(`runtime-v1:s1:${engine}:some-model@high`)).toMatchObject({ engine })
    }
    expect(parseRuntimeProfile('runtime-v1:cursor-1:cursor:gpt-5.6-sol@none')).toMatchObject({
      engine: 'cursor', effort: 'none',
    })
  })

  it('parses Cursor catalog variants without hardcoding the account model list', () => {
    const entries = parseCursorModelsOutput([
      'Available models',
      '',
      'auto - Auto (current, default)',
      'gpt-5.6-sol-none - GPT-5.6 Sol 1M None',
      'gpt-5.6-sol-extra-high-fast - GPT-5.6 Sol Extra High Fast',
      'claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking',
      'gpt-5.3-codex-low - Codex 5.3 Low',
      'gpt-5.3-codex - Codex 5.3',
      'Tip: ignored',
    ].join('\n'))

    expect(entries.map((entry) => ({
      rawId: entry.target.rawId,
      model: entry.target.modelKey,
      effort: entry.effort,
      context: entry.target.context,
      fast: entry.target.fast,
      thinking: entry.target.thinking,
    }))).toEqual([
      { rawId: 'auto', model: 'auto', effort: 'auto', context: null, fast: null, thinking: null },
      { rawId: 'gpt-5.6-sol-none', model: 'gpt-5.6-sol', effort: 'none', context: '1m', fast: false, thinking: false },
      { rawId: 'gpt-5.6-sol-extra-high-fast', model: 'gpt-5.6-sol-fast', effort: 'xhigh', context: null, fast: true, thinking: false },
      { rawId: 'claude-opus-4-8-thinking-high', model: 'claude-opus-4-8-thinking', effort: 'high', context: '1m', fast: false, thinking: true },
      { rawId: 'gpt-5.3-codex-low', model: 'gpt-5.3-codex', effort: 'low', context: null, fast: false, thinking: false },
      { rawId: 'gpt-5.3-codex', model: 'gpt-5.3-codex', effort: 'medium', context: null, fast: false, thinking: false },
    ])
  })

  it('offers no switching outside Claude and Codex', async () => {
    // View-only engines still SHOW what they run (the ingest paths do that); they just have nothing to
    // pick and nothing to drive. Both gates are asserted: an empty catalogue, and a refusal to control.
    const manager = new RuntimeProfileManager()
    for (const engine of ['cursor', 'commandcode', 'devin', 'pi', 'opencode', 'hermes', 'grok'] as const) {
      const value = { ...session('cursor'), engine }
      expect(supportsNativeRuntimeControl(value)).toBe(false)
      await expect(manager.modelsForSession(value)).resolves.toEqual([])
    }
  })

  it('is display-only through an OpenRouter gateway, but still names the model it runs', async () => {
    // `ori claude` runs the same CLI with gateway model discovery, so its picker holds the user's
    // OpenRouter catalog, not the native aliases this controller types. Both gates must hold — an empty
    // catalogue AND a refusal to control — or a stale profile id from an older client drives the pane.
    const manager = new RuntimeProfileManager()
    for (const engine of ['claude', 'codex'] as const) {
      const value = { ...session(engine), gateway: 'ori' as const }
      expect(supportsNativeRuntimeControl(value)).toBe(false)
      await expect(manager.modelsForSession(value)).resolves.toEqual([])
    }

    // Displaying it is the whole point of the flag being separate from `engine`: the chip still works.
    const value = { ...session('claude'), gateway: 'ori' as const }
    manager.hydrate(value, [])
    manager.ingest(value, JSON.stringify({ type: 'assistant', message: { model: 'anthropic/claude-sonnet-4.6' } }))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      engine: 'claude',                       // NOT a new engine — the badge stays Claude Code
      model: 'anthropic/claude-sonnet-4.6',   // the OpenRouter id, percent-encoded in the profile
      effort: 'auto',
    })

    // The same session without the flag keeps the native catalogue and native control.
    const native = session('claude')
    expect(supportsNativeRuntimeControl(native)).toBe(true)
    await expect(manager.modelsForSession(native)).resolves.not.toEqual([])
  })

  it('switches Codex from 0.144 upward, not only the two releases first driven by hand', () => {
    // The gate allowed exactly 0.144 and 0.145, so a Codex kept up to date (0.160) could not be switched.
    const value = session('codex')
    for (const version of ['0.144.0', '0.144.5', '0.145.0', '0.146.0', '0.160.0', '0.161.2', '1.0.0']) {
      value.cliVersion = version
      expect(supportsNativeRuntimeControl(value), version).toBe(true)
    }
    for (const version of ['0.143.9', '0.99.0', null, 'not a version']) {
      value.cliVersion = version
      expect(supportsNativeRuntimeControl(value), String(version)).toBe(false)
    }
  })

  it('knows Codex 0.160 Persistent effort, from the rollout, the pane and the catalog', async () => {
    const manager = new RuntimeProfileManager()
    const value = session('codex')
    manager.hydrate(value, [])
    manager.ingest(value, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.5', reasoning_effort: 'persistent' } },
    }))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'gpt-5.5', effort: 'persistent' })
    expect(codexEffortAllowed('gpt-5.5', 'persistent')).toBe(true)

    manager.ingestPane(value, '› \ngpt-6-luna high ·', true)
    manager.ingestPane(value, '› \ngpt-6-luna persistent · Context 100% left', true)
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'gpt-6-luna', effort: 'persistent' })

    const home = await mkdtemp(join(tmpdir(), 'codex-home-'))
    cleanup.push(home)
    await writeFile(join(home, 'models_cache.json'), JSON.stringify({ models: [{
      slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'persistent' }],
    }] }))
    const options = await manager.modelsForSession({ ...value, codexHome: home })
    expect(options).toContainEqual({ id: encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-5.5', effort: 'persistent' }), displayName: 'GPT-5.5 / Persistent' })
    expect(await manager.codexCatalog({ ...value, codexHome: home })).toEqual([
      { slug: 'gpt-5.5', displayName: 'GPT-5.5', listed: true, defaultEffort: 'medium', efforts: ['medium', 'persistent'] },
    ])
  })

  it('reads no Codex catalog where there is none, or none that parses', async () => {
    const manager = new RuntimeProfileManager()
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'))
    cleanup.push(home)
    const value = { ...session('codex'), codexHome: home }
    await expect(manager.codexCatalog(value)).resolves.toEqual([])
    await writeFile(join(home, 'models_cache.json'), 'null')
    await expect(manager.codexCatalog(value)).resolves.toEqual([])
    await expect(manager.modelsForSession(value)).resolves.toEqual([])
  })

  it('surfaces a Cursor model from the transcript even before any effort is known', () => {
    // Regression: selectedModel() returns null unless BOTH axes are known, and Cursor's transcript
    // reports the model while the reasoning level exists only in the pane footer. The model was
    // therefore discarded whenever the footer had not been read yet, and the device showed no model
    // at all for a Cursor agent.
    const manager = new RuntimeProfileManager()
    const value = session('cursor')
    manager.hydrate(value, [])

    manager.ingest(value, JSON.stringify({ model: 'gpt-5.6-sol' }))

    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      engine: 'cursor',
      model: 'gpt-5.6-sol',
      effort: 'auto',
    })
  })

  it('names an OpenCode model the catalog does not list, with its reasoning level', () => {
    const value = session('opencode')
    const manager = new RuntimeProfileManager()

    // A real footer from a machine with no provider connected: OpenCode runs a built-in free model
    // that `opencode models` never prints, so there is no catalog entry to resolve against and the
    // chips used to stay blank while the terminal named the model two lines below.
    manager.ingestPane(value, '┃  Build · Ox Alpha Free (Unlimited) OpenCode Zen · high')

    const profile = manager.selectedModel(value)
    expect(profile).not.toBeNull()
    const decoded = parseRuntimeProfile(profile!)
    expect(decoded?.model).toBe('Ox Alpha Free (Unlimited) OpenCode Zen')
    expect(decoded?.effort).toBe('high')
  })

  it('observes Grok model metadata and its live footer effort', () => {
    const manager = new RuntimeProfileManager()
    const value = session('grok')
    manager.hydrate(value, [])

    manager.ingest(value, JSON.stringify({
      params: { update: { _meta: { modelId: 'grok-4.5' } } },
    }))
    manager.ingestPane(value, 'Grok 4.5 (medium) · always-approve')

    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      engine: 'grok',
      model: 'grok-4.5',
      effort: 'medium',
    })
  })

  it('observes Cursor Auto model and effort from the idle footer with context usage', () => {
    const manager = new RuntimeProfileManager()
    const value = session('cursor')
    manager.hydrate(value, [])

    manager.ingestPane(value, [
      'previous output',
      '→ Add a follow-up',
      '',
      'Auto · 12.7%                                                           Run Everything',
      '~/demo · main',
    ].join('\n'))

    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'auto',
      effort: 'auto',
    })
  })

  it('observes Cursor native-default models from usage and No Thinking footers', () => {
    const manager = new RuntimeProfileManager()
    const value = session('cursor')
    manager.hydrate(value, [])

    manager.ingestPane(value, [
      '→ Add a follow-up',
      '',
      'Haiku 4.5 · 12.8%                                             Run Everything',
      '~/demo · main',
    ].join('\n'))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'haiku-4.5',
      effort: 'auto',
    })

    manager.ingestPane(value, '→ Add a follow-up\nSonnet 4.5 No Thinking')
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'sonnet-4.5',
      effort: 'auto',
    })
  })

  it('keeps synthetic Cursor routing details out of the public runtime profile', () => {
    const manager = new RuntimeProfileManager()
    const value = session('cursor')
    manager.hydrate(value, [])

    manager.ingestPane(value, [
      '→ Add a follow-up',
      '',
      'Composer 2.5 · 15.7%                                             Run Everything',
      '~/demo · main',
    ].join('\n'))

    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'composer-2.5',
      effort: 'auto',
    })

    manager.ingestPane(value, '→ Add a follow-up\nComposer 2.5 1M Thinking Fast High')
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'composer-2.5-1m-thinking-fast',
      effort: 'high',
    })
  })

  it('observes Claude model from JSONL and effort from the live pane', () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    manager.hydrate(value, [JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8' } })])
    expect(manager.selectedModel(value)).toBeNull()

    manager.ingestPane(value, 'Opus 4.8 (1M context) with high effort\n❯ ')
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'opus', effort: 'high',
    })
  })

  it('ignores Claude synthetic error models without losing the observed model', () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    const error = JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: 'Quota exceeded' } })
    manager.hydrate(value, [error])
    expect(manager.selectedModel(value)).toBeNull()

    manager.ingestPane(value, 'Opus 4.8 with high effort\n❯ ')
    const observed = manager.selectedModel(value)
    expect(observed).not.toBeNull()
    manager.ingest(value, error)
    expect(manager.selectedModel(value)).toBe(observed)
  })

  it('hydrates Claude effort from effective settings and backfills the transcript CLI version', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'machine-runtime-'))
    cleanup.push(cwd)
    await mkdir(join(cwd, '.claude'))
    await writeFile(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ effortLevel: 'low' }))
    const manager = new RuntimeProfileManager()
    const value = { ...session('claude'), cwd, cliVersion: null }
    manager.hydrate(value, [JSON.stringify({
      type: 'assistant', version: '2.1.212', message: { model: 'claude-opus-4-8' },
    })])

    await manager.ingestConfig(value, true)

    expect(value.cliVersion).toBe('2.1.212')
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'opus', effort: 'low' })
  })

  it('keeps supported Claude effort on a local model change and falls back to auto otherwise', () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Opus 4.8 with high effort\n❯ ', true)

    manager.ingest(value, JSON.stringify({ message: { content: [{ text: 'Set model to Sonnet 5' }] } }))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'sonnet', effort: 'high' })

    manager.ingest(value, JSON.stringify({ message: { content: [{ text: 'Set model to Haiku 4.5' }] } }))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'haiku', effort: 'auto' })
  })

  // Opus 5 shipped as a new family version AND as a 1M-context variant. Both had to stop resetting the
  // observed effort: the effort table used to hardcode `opus-4-[78]` and never stripped the `[1m]` suffix,
  // so `Opus 5 (1M context)` — and even `Opus 4.8 (1M context)` — looked effort-less and fell back to auto.
  it('keeps Claude effort across a switch to a new family version and to a 1M-context variant', () => {
    for (const setModel of ['Opus 5', 'Opus 5 (1M context)', 'Opus 4.8 (1M context)', 'Fable 5 (1M context)']) {
      const manager = new RuntimeProfileManager()
      const value = session('claude')
      manager.hydrate(value, [])
      manager.ingestPane(value, 'Opus 4.8 with high effort\n❯ ', true)

      manager.ingest(value, JSON.stringify({ message: { content: [{ text: `Set model to ${setModel}` }] } }))
      expect(parseRuntimeProfile(manager.selectedModel(value))?.effort, setModel).toBe('high')
    }
  })

  it('observes an Opus 5 pane status line (model + effort)', () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Opus 5 (1M context) with high effort\n❯ ')
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'opus', effort: 'high' })
  })

  it('publishes Claude aliases in native picker order without provider-model duplicates', async () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    manager.hydrate(value, [JSON.stringify({
      type: 'assistant', message: { model: 'claude-opus-4-8' },
    })])
    manager.ingestPane(value, 'Opus 4.8 with high effort\n❯ ', true)

    const profiles = (await manager.modelsForSession(value))
      .map((option) => parseRuntimeProfile(option.id))
      .filter((profile): profile is NonNullable<typeof profile> => profile !== null)
    expect([...new Set(profiles.map((profile) => profile.model))]).toEqual([
      'default', 'opus', 'fable', 'sonnet', 'haiku',
    ])
    expect(profiles.filter((profile) => profile.model === 'sonnet').map((profile) => profile.effort)).toContain('ultracode')
    expect(profiles.filter((profile) => profile.model === 'haiku').map((profile) => profile.effort)).toEqual(['auto'])
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'opus' })

    value.cliVersion = '2.1.208'
    const olderProfiles = (await manager.modelsForSession(value))
      .map((option) => parseRuntimeProfile(option.id))
      .filter((profile): profile is NonNullable<typeof profile> => profile !== null)
    expect(olderProfiles.map((profile) => profile.effort)).not.toContain('ultracode')
  })

  it('observes Claude ultracode effort from JSONL and the live footer', () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Opus 4.8 with high effort\n❯ ', true)

    manager.ingest(value, JSON.stringify({
      type: 'user', message: { content: '<local-command-stdout>Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration</local-command-stdout>' },
    }))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'opus', effort: 'ultracode' })

    manager.confirmEffort(value.sessionId, 'auto')
    manager.ingestPane(value, 'old output\n──────────────── ultracode ─\n❯\n────────────────', true)
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'opus', effort: 'ultracode' })
  })

  it('observes Codex model, effort, and plan mode from rollout settings', () => {
    const manager = new RuntimeProfileManager()
    const value = session('codex')
    manager.hydrate(value, [JSON.stringify({ type: 'session_meta', payload: { cli_version: '0.144.5' } })])
    manager.ingest(value, JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-5.6-sol', reasoning_effort: 'high', collaboration_mode: { mode: 'plan' } },
      },
    }))

    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high' })
    expect(manager.getState(value.sessionId).mode).toBe('plan')
    expect(value.cliVersion).toBe('0.144.5')
  })

  it('observes Codex ultra effort from rollout and pane state', () => {
    const manager = new RuntimeProfileManager()
    const value = session('codex')
    manager.hydrate(value, [])
    manager.ingest(value, JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'ultra' },
    }))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ effort: 'ultra' })

    manager.ingestPane(value, '› \ngpt-5.6-sol ultra ·', true)
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ effort: 'ultra' })
  })
})

describe('RuntimeProfileManager.transcriptFields', () => {
  const codexLine = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload })

  it('names the fields a Codex record sets, through the same reader as ingest', () => {
    const manager = new RuntimeProfileManager()
    const codex = session('codex')
    expect(manager.transcriptFields(codex, codexLine('turn_context', { model: 'gpt-6', reasoning_effort: 'high', collaboration_mode: { mode: 'plan' } })))
      .toEqual(['model', 'effort', 'mode'])
    expect(manager.transcriptFields(codex, codexLine('turn_context', { model: 'gpt-6', collaboration_mode: { mode: 'default' } }))).toEqual(['model', 'mode'])
    expect(manager.transcriptFields(codex, codexLine('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6', reasoning_effort: 'low' } })))
      .toEqual(['model', 'effort'])
    expect(manager.transcriptFields(codex, codexLine('session_meta', { cli_version: '0.159.0' }))).toEqual([])
    expect(manager.transcriptFields(codex, codexLine('event_msg', { type: 'user_message', message: 'hi' }))).toEqual([])
  })

  it('names the fields a Claude record sets', () => {
    const manager = new RuntimeProfileManager()
    const claude = session('claude')
    const assistant = (model: string) => JSON.stringify({ type: 'assistant', version: '2.1.212', message: { role: 'assistant', model, content: [] } })
    expect(manager.transcriptFields(claude, assistant('claude-opus-5-5'))).toEqual(['model'])
    expect(manager.transcriptFields(claude, assistant('<synthetic>'))).toEqual([])
    const local = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } })
    expect(manager.transcriptFields(claude, local('Set effort level to high'))).toEqual(['effort'])
    expect(manager.transcriptFields(claude, JSON.stringify({ type: 'user', message: { role: 'user', content: 'plain' } }))).toEqual([])
  })

  it('leaves the session, its controls and its state untouched', () => {
    const manager = new RuntimeProfileManager()
    const claude = session('claude')
    manager.hydrate(claude, [JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } })])
    const before = manager.getState(claude.sessionId)
    expect(manager.transcriptFields(claude, JSON.stringify({ type: 'assistant', version: '9.9.9', message: { model: 'claude-fable-5-1' } }))).toEqual(['model'])
    expect(manager.getState(claude.sessionId)).toEqual(before)
    expect(claude.cliVersion).toBe('2.1.212')
  })

  it('answers nothing for other engines or a record that is not an object', () => {
    const manager = new RuntimeProfileManager()
    expect(manager.transcriptFields(session('grok'), JSON.stringify({ params: { update: { _meta: { modelId: 'grok-5' } } } }))).toEqual([])
    expect(manager.transcriptFields(session('codex'), 'not json')).toEqual([])
    expect(manager.transcriptFields(session('codex'), '[1]')).toEqual([])
  })
})

describe('RuntimeProfileManager.beginHydrate', () => {
  const turnContext = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6', reasoning_effort: 'high', collaboration_mode: { mode: 'plan' } } })

  it('changes nothing the session shows until commit, then shows the staged state', () => {
    const manager = new RuntimeProfileManager()
    const codex = session('codex')
    manager.hydrate(codex, [JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5', reasoning_effort: 'low' } })])
    const before = manager.getState(codex.sessionId)
    const staged = manager.beginHydrate(codex)
    staged.ingest(turnContext)
    staged.ingest('not json')
    staged.ingest('[1]')
    expect(manager.getState(codex.sessionId)).toEqual(before)
    staged.commit()
    expect(manager.getState(codex.sessionId)).toMatchObject({ model: 'gpt-6', effort: 'high', mode: 'plan', cliVersion: '0.144.5' })
  })

  it('reads Claude records too, and keeps an unbound session out of the shared state', () => {
    const manager = new RuntimeProfileManager()
    const claude = session('claude')
    const staged = manager.beginHydrate(claude)
    staged.ingest(JSON.stringify({ type: 'assistant', version: '2.1.270', message: { model: 'claude-opus-5-5' } }))
    staged.commit()
    expect(manager.getState(claude.sessionId)).toMatchObject({ model: 'claude-opus-5-5', cliVersion: '2.1.270' })
    const unbound = { ...session('codex'), sessionId: '' }
    const nothing = manager.beginHydrate(unbound)
    nothing.ingest(turnContext)
    nothing.commit()
    expect(manager.getState('')).toMatchObject({ model: null })
  })
})
