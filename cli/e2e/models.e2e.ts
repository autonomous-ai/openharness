/**
 * A Codex agent's model and effort switched from the app, on the real daemon: `agent_update` with a
 * `selectedModel` the agent's catalog offered, typed into the fake Codex's `/model` picker as 0.160
 * draws it (fakeEngine.mjs) and confirmed by the `thread_settings_applied` record Codex writes. Its rows
 * are the catalog's display names, read from `models_cache.json` in the agent's CODEX_HOME: the catalog
 * 0.160 ships (src/lib/__fixtures__/codex-home-0.160).
 *
 * Until this switch read rows by display name the daemon refused every Codex from 0.146 on, so no run
 * of this suite switched a Codex model at all: the fake reported 0.159.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until, type DaemonOptions } from './harness/daemon.js'

const CATALOG = JSON.parse(readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json'), 'utf8'))

/** A `runtime-v1:` profile id as the daemon mints them (lib/runtimeProfile.ts), and its model and effort. */
const profile = (agentId: string, model: string, effort: string) =>
  `runtime-v1:${encodeURIComponent(agentId)}:codex:${encodeURIComponent(model)}@${effort}`
const parseProfile = (id: unknown): { model: string; effort: string } | null => {
  const match = typeof id === 'string' ? /^runtime-v1:[^:]+:codex:([^@]+)@([a-z0-9_-]+)$/.exec(id) : null
  return match ? { model: decodeURIComponent(match[1]), effort: match[2] } : null
}

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

async function create(daemon: IsolatedDaemon, client: LocalClient, folder: string): Promise<Record<string, any>> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}

/** A turn, so the rollout names the model and effort the agent runs on (the fake's `turn_context`). */
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, 'turn_ended')
  client.send('message', { agentId, content })
  await ended
}

/** The agent's chip once it reads `model` at `effort`. */
const runningOn = (client: LocalClient, agentId: string, model: string, effort: string) =>
  until(`the agent to run on ${model} at ${effort}`, async () => {
    const running = parseProfile((await row(client, agentId))?.selectedModel)
    return running?.model === model && running.effort === effort ? running : null
  }, 30_000, 250)

/** The settings Codex applied, from its rollout: every `thread_settings_applied` record, in order. */
function applied(daemon: IsolatedDaemon, sessionId: string): Array<{ model: string; effort: string }> {
  const folder = join(daemon.engineConfig.codexHome, 'sessions', '2026', '10', '03')
  const file = readdirSync(folder).find((name) => name.endsWith(`${sessionId}.jsonl`))
  if (!file) return []
  return readFileSync(join(folder, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((record) => record.type === 'event_msg' && record.payload?.type === 'thread_settings_applied')
    .map((record) => ({ model: record.payload.thread_settings.model, effort: record.payload.thread_settings.reasoning_effort }))
}

describe('switching a Codex agent model and effort', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  /** A daemon whose Codex home holds a catalog (0.160's own unless told), and the server's answer when one is given. */
  const fresh = async (options: DaemonOptions, server?: { delayMs: number; models: unknown[] }, catalog = CATALOG) => {
    const d = await IsolatedDaemon.create(options)
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').filter((line) => /runtime-profile|codex/i.test(line)).slice(-60).join('\n')}`) })
    writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), JSON.stringify(catalog))
    if (server) writeFileSync(join(d.engineConfig.codexHome, 'fake-models-server.json'), JSON.stringify(server))
    await d.start()
    return d
  }

  it('switches the model through All models by its display name, then the effort alone, then to a quick preset', async () => {
    // An auto preset makes `/model` open on the quick menu, with every other model behind `All models`
    // (the catalog of 0.160's own test `custom_model_display_name_in_pickers_preserves_selection_slug`).
    const luna = CATALOG.models.find((model: { slug: string }) => model.slug === 'gpt-6-luna')
    const autoFast = { ...luna, slug: 'codex-auto-fast', display_name: 'Auto Fast', description: 'Custom provider model', priority: 0,
      default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'low', description: 'Quick answers' }, { effort: 'high', description: 'Deeper reasoning' }] }
    const d = await fresh({ codexModel: 'gpt-5.5' }, undefined, { ...CATALOG, models: [autoFast, ...CATALOG.models] })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'switch')
    await turn(client, agent.id, 'hello')
    await runningOn(client, agent.id, 'gpt-5.5', 'high')

    // What the app offers is the catalog: a model and effort the picker lists.
    const offered = (await client.request<{ models: Array<{ id: string; displayName: string }> }>('models_list', { agentId: agent.id })).models
    const xhigh = profile(agent.id, 'gpt-6-luna', 'xhigh')
    expect(offered.find((option) => option.id === xhigh)?.displayName).toBe('GPT-6-Luna / XHigh')

    const switched = await client.request('agent_update', { agentId: agent.id, selectedModel: xhigh }, 60_000)
    expect(switched.error, JSON.stringify(switched)).toBeUndefined()
    expect(switched.agent.selectedModel).toBe(xhigh)
    expect(applied(d, agent.sessionId)).toEqual([{ model: 'gpt-6-luna', effort: 'xhigh' }])

    // The effort alone: the same model's row again, and Low in its reasoning picker.
    const low = profile(agent.id, 'gpt-6-luna', 'low')
    const lowered = await client.request('agent_update', { agentId: agent.id, selectedModel: low }, 60_000)
    expect(lowered.error, JSON.stringify(lowered)).toBeUndefined()
    expect(lowered.agent.selectedModel).toBe(low)
    expect(applied(d, agent.sessionId)).toEqual([{ model: 'gpt-6-luna', effort: 'xhigh' }, { model: 'gpt-6-luna', effort: 'low' }])

    // The picker closed behind it and the agent goes on, on the model it was moved to.
    expect(await d.capture(agent.tmuxPane)).not.toMatch(/Select Model|Select Reasoning Level/)
    await turn(client, agent.id, 'after the switch')
    await runningOn(client, agent.id, 'gpt-6-luna', 'low')

    // The quick preset's row applies its default effort, High, at once: one key.
    const quick = await client.request('agent_update', { agentId: agent.id, selectedModel: profile(agent.id, 'codex-auto-fast', 'auto') }, 60_000)
    expect(quick.error, JSON.stringify(quick)).toBeUndefined()
    expect(applied(d, agent.sessionId).at(-1)).toEqual({ model: 'codex-auto-fast', effort: 'high' })
    await runningOn(client, agent.id, 'codex-auto-fast', 'high')
    client.close()
  })

  it('presses the row the list shows once the server answer has renumbered it', async () => {
    // The server knows a model the cache does not, first in priority: when its answer reaches the open
    // picker every row moves down one, GPT-6-Luna from 4 to 5.
    const server = [{ ...CATALOG.models.find((model: { slug: string }) => model.slug === 'gpt-6.1-sol'), slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', priority: 0 },
      ...CATALOG.models]
    const d = await fresh({ codexModel: 'gpt-5.5' }, { delayMs: 150, models: server })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'refresh')
    await turn(client, agent.id, 'hello')
    await runningOn(client, agent.id, 'gpt-5.5', 'high')

    const target = profile(agent.id, 'gpt-6-luna', 'high')
    const answer = await client.request('agent_update', { agentId: agent.id, selectedModel: target }, 60_000)
    expect(answer.error, JSON.stringify(answer)).toBeUndefined()
    expect(applied(d, agent.sessionId)).toEqual([{ model: 'gpt-6-luna', effort: 'high' }])
    // Codex saved what the server answered, and the next picker opens on it.
    expect(JSON.parse(readFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), 'utf8')).models[0].slug).toBe('gpt-6.2-sol')
    client.close()
  })

  it('lists the choices from models\' own process, and switches with models killed: the switch is the core\'s', async () => {
    const d = await fresh({ codexModel: 'gpt-5.5', env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '8000', HARNESSD_SERVICE_MAX_BACKOFF_MS: '8000' } })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'apart')
    await turn(client, agent.id, 'hello')
    await runningOn(client, agent.id, 'gpt-5.5', 'high')
    // The picker's choices come from models, in its own process (harnessd/services.ts), which asks the core
    // for the agent's catalog. It is started by this first ask, which waits for it (core/modelsWake.ts).
    const xhigh = profile(agent.id, 'gpt-6-luna', 'xhigh')
    const offered = (await client.request<{ models: Array<{ id: string }> }>('models_list', { agentId: agent.id }, 30_000)).models
    expect(offered.map((option) => option.id)).toContain(xhigh)

    const pids = [...d.log().matchAll(/\[harnessd\] service models started \(pid (\d+)\)/g)].map((match) => Number(match[1]))
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
    await until('the core to see models gone', () => d.log().includes('[services] models disconnected') || null, 15_000, 100)
    expect(await client.request('models_list', { agentId: agent.id }, 10_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: true })
    // A switch the picker already offered is the core's to make, and the agent goes on on it.
    const switched = await client.request('agent_update', { agentId: agent.id, selectedModel: xhigh }, 60_000)
    expect(switched.error, JSON.stringify(switched)).toBeUndefined()
    expect(applied(d, agent.sessionId)).toEqual([{ model: 'gpt-6-luna', effort: 'xhigh' }])
    await turn(client, agent.id, 'while models was gone')
    await runningOn(client, agent.id, 'gpt-6-luna', 'xhigh')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('offers an account held to the reserve model no other model, and changes the reserve effort', async () => {
    const d = await fresh({ codexModel: 'gpt-reserve' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'reserve')
    await turn(client, agent.id, 'hello')
    await runningOn(client, agent.id, 'gpt-reserve', 'high')

    // The catalog still lists GPT-6-Luna, but the picker has one row: the reserve model under its name.
    const refused = await client.request('agent_update', { agentId: agent.id, selectedModel: profile(agent.id, 'gpt-6-luna', 'high') }, 60_000)
    expect(refused.error).toBe('MODEL_UNAVAILABLE')
    expect(applied(d, agent.sessionId)).toEqual([])
    await until('the picker to close', async () => !/Select Model/.test(await d.capture(agent.tmuxPane)) || null, 10_000, 200)

    // Its default effort, Medium, through the one row and the reasoning picker it lends.
    const auto = profile(agent.id, 'gpt-reserve', 'auto')
    const answer = await client.request('agent_update', { agentId: agent.id, selectedModel: auto }, 60_000)
    expect(answer.error, JSON.stringify(answer)).toBeUndefined()
    expect(applied(d, agent.sessionId)).toEqual([{ model: 'gpt-reserve', effort: 'medium' }])
    await runningOn(client, agent.id, 'gpt-reserve', 'medium')
    client.close()
  })
})
