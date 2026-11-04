/**
 * `harness team model set …`: the Harness Team account's own model API, for a computer whose owner has no subscription
 * for the relay to lend, or wants another model. The key is asked for here, hidden, and never reaches a command line.
 *
 * It writes the four things a person would otherwise edit by hand: the saved API (Models ▸ APIs) in the team account's
 * data folder, the engine's base URL, token and model in its Claude settings, and a restart of its daemon.
 */
import { API_PRESETS, servesModels } from '../lib/apiConnections.js'
import type { TeamCommandDeps } from './command.js'
import { teamPaths } from './layout.js'
import { writeModelHandoff, type TeamModelHandoff } from './modelHandoff.js'

export const MODEL_USAGE = [
  'Usage: harness team model set <provider> --model <model-id> [--key-stdin] [--clear]',
  '',
  '  <provider>   openrouter, openai, anthropic, requesty, fal, replicate, or custom with --base-url <url>',
  '  --model      the model id that provider serves, e.g. deepseek/deepseek-v4.1-flash-1017',
  '  --key-stdin  read the API key from stdin instead of the hidden prompt (for scripts)',
  '  --clear      remove it again, back to the owner\'s subscription through the relay',
  '',
  'The key is asked for here: never printed, never in your shell history.',
].join('\n')

/** The wide line the hidden prompt leaves behind, and the two lines the command ends with. */
const DONE = (provider: string, model: string, where: string): string[] => [
  `  ✓ ${where}'s Harness Team account now runs Claude Code on ${provider} · ${model}.`,
  '  Next: harness team status',
]

interface Chosen { provider: string; name: string; baseUrl: string; keyEnv: string }

function choose(deps: TeamCommandDeps, words: readonly string[], flags: readonly string[]): Chosen | null {
  const provider = words[2]
  if (!provider) { deps.err(MODEL_USAGE); return null }
  if (provider === 'custom') {
    const url = flags.includes('--base-url') ? words[3] : undefined
    if (!url) { deps.err('✗ --base-url is needed with custom (the provider\'s API address, ending in /v1).'); return null }
    return { provider, name: 'Custom', baseUrl: url.replace(/\/+$/, ''), keyEnv: 'CUSTOM_API_KEY' }
  }
  const preset = API_PRESETS.find((row) => row.provider === provider)
  if (!preset) { deps.err(`✗ Unknown provider "${provider}".

${MODEL_USAGE}`); return null }
  return { provider, name: preset.name, baseUrl: preset.baseUrl, keyEnv: preset.keyEnv }
}

/** `--model <id>` and `--model=<id>`, beside the flags the dispatcher already split out. */
function modelOf(words: readonly string[], flags: readonly string[]): string | null {
  const inline = flags.find((flag) => flag.startsWith('--model='))
  if (inline) return inline.slice('--model='.length)
  return flags.includes('--model') ? words[3] ?? null : null
}

function baseUrlOf(words: readonly string[], flags: readonly string[]): string | null {
  const inline = flags.find((flag) => flag.startsWith('--base-url='))
  if (inline) return inline.slice('--base-url='.length)
  return flags.includes('--base-url') ? words[3] ?? null : null
}

/** The team account's settings.json, with [change] applied: its own env entries and model, or those taken out again. */
const MERGE = [
  "import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'",
  'const [payloadPath, settingsPath, team] = process.argv.slice(2)',
  'const payload = JSON.parse(readFileSync(payloadPath, "utf8"))',
  'let settings = {}',
  'try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) } catch {}',
  'const env = settings.env && typeof settings.env === "object" ? settings.env : {}',
  'const keys = payload.clear ? ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] : Object.keys(payload.env)',
  'for (const key of keys) delete env[key]',
  'if (!payload.clear) Object.assign(env, payload.env)',
  'if (Object.keys(env).length) settings.env = env; else delete settings.env',
  'if (payload.clear) delete settings.model; else settings.model = payload.model',
  'const next = settingsPath + ".next"',
  'writeFileSync(next, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })',
  'renameSync(next, settingsPath)',
  'chmodSync(settingsPath, 0o600)',
].join('\n')

/** What the root script does: the saved API as the team account, the engine's settings, then its daemon again. */
export function buildModelScript(input: {
  platform: NodeJS.Platform
  team: string
  home: string
  node: string
  label: string
  stage: string
  clear: boolean
}): string {
  const data = teamPaths(input.home).data
  const mac = input.platform === 'darwin'
  return [
    '#!/bin/sh',
    '# Harness Team account: its model API (cli/src/team/model.ts), run once as root.',
    'set -eu',
    'cd /',
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    `TEAM=${JSON.stringify(input.team)}`,
    `TEAM_HOME=${JSON.stringify(input.home)}`,
    `NODE=${JSON.stringify(input.node)}`,
    `STAGE=${JSON.stringify(input.stage)}`,
    `DATA=${JSON.stringify(data)}`,
    `LABEL=${JSON.stringify(input.label)}`,
    `if [ ! -x "$NODE" ]; then echo "harness: the team account has no Node runtime" >&2; exit 4; fi`,
    'install -d -o "$TEAM" -m 700 "$DATA/api-connections"',
    input.clear
      ? 'rm -f "$DATA/api-connections/connections.json"'
      : `install -o "$TEAM" -m 600 "$STAGE/connections.json" "$DATA/api-connections/connections.json"`,
    'mkdir -p "$TEAM_HOME/.claude"',
    '"$NODE" "$STAGE/merge.mjs" "$STAGE/model.json" "$TEAM_HOME/.claude/settings.json" "$TEAM"',
    'chown "$TEAM" "$TEAM_HOME/.claude/settings.json"',
    'chmod 600 "$TEAM_HOME/.claude/settings.json"',
    mac
      ? 'launchctl kickstart -k "system/$LABEL" >/dev/null 2>&1 || true'
      : 'systemctl restart "$LABEL" >/dev/null 2>&1 || true',
    'echo "done"',
  ].join('\n')
}

/** `harness team model set`: the team account's own model API. */
/** How long the owner waits for the Team daemon, which looks once a minute (./engines.ts ENGINE_RECHECK_MS). */
const HANDOVER_WAIT_MS = 90_000

/** Windows: left for the Team daemon, which writes it as itself (./modelHandoff.ts). True once it says it did. */
async function handOverOnWindows(deps: TeamCommandDeps, statusFile: string, handoff: TeamModelHandoff, json: boolean): Promise<boolean> {
  const startedAt = deps.now()
  try { (deps.handModel ?? writeModelHandoff)(handoff) } catch (error) { deps.err(`✗ ${(error as Error).message}`); return false }
  if (!json) deps.out('  Waiting for the Harness Team account to take it…')
  while (deps.now() - startedAt < HANDOVER_WAIT_MS) {
    const said = deps.readStatus(statusFile)?.model
    if (said && said.at >= startedAt) {
      if (said.state === 'applied') return true
      deps.err(`✗ The Harness Team account could not take it: ${said.detail ?? 'no reason given'}`)
      return false
    }
    await deps.sleep(2_000)
  }
  deps.err('✗ The Harness Team account did not take it yet, so it may not be running. It takes it when it next runs: harness team status shows its state.')
  return false
}

export async function teamModelSet(deps: TeamCommandDeps, words: readonly string[], flags: readonly string[], json = false): Promise<number> {
  const where = deps.platform === 'darwin' ? 'this Mac' : 'this computer'
  const config = deps.readConfig()
  if (!config) { deps.err(`✗ No Harness Team account on ${where}. Run harness team setup first.`); return 1 }
  const clear = flags.includes('--clear')
  let chosen: Chosen | null = null, model: string | null = null
  if (!clear) {
    chosen = choose(deps, words, flags)
    if (!chosen) return 1
    model = modelOf(words, flags)
    if (!model) { deps.err(`✗ --model is needed: the model id that ${chosen.name} serves.`); return 1 }
    if (!servesModels({ authHeader: 'Authorization', authPrefix: 'Bearer' })) return 1
    if (chosen.provider === 'anthropic') {
      deps.err('✗ Anthropic\'s own API does not fit a Swarm engine. Use openrouter, openai or custom.')
      return 1
    }
  }
  let key = ''
  if (!clear) {
    if (flags.includes('--key-stdin')) key = (await readStdin()).trim()
    else if (!deps.interactive) { deps.err('✗ No terminal to ask for the key. Pipe it: ... | harness team model set … --key-stdin'); return 1 }
    else {
      const question = `Paste the ${chosen!.name} API key: `
      key = (await (deps.askSecret ? deps.askSecret(question) : deps.ask(question))).trim()
    }
    if (!key) { deps.err('✗ No API key was given.'); return 1 }
  }
  const baseUrl = chosen ? (baseUrlOf(words, flags) ?? chosen.baseUrl).replace(/\/+$/, '') : ''
  // Claude reads its endpoint as the API root: OpenRouter's Anthropic-compatible messages live under /api/v1.
  const claudeBase = baseUrl.replace(/\/v1$/, '')
  const connections = JSON.stringify({
    version: 1,
    connections: chosen
      ? [{ id: chosen.provider, provider: chosen.provider, name: chosen.name, baseUrl, keyEnv: chosen.keyEnv,
        authHeader: 'Authorization', authPrefix: 'Bearer', apiKey: key }]
      : [],
    recognizedBases: baseUrl ? [baseUrl] : [],
  })
  const payload = JSON.stringify(chosen
    ? { clear: false, model, env: { ANTHROPIC_BASE_URL: claudeBase, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' } }
    : { clear: true })
  if (deps.platform === 'win32') {
    if (!await handOverOnWindows(deps, config.statusFile, { connections, payload }, json)) return 1
    if (json) { deps.out(JSON.stringify({ ok: true, provider: chosen?.provider ?? null, model: model ?? null })); return 0 }
    for (const line of clear ? [`  ✓ The Harness Team account on ${where} has no model API again.`, '  Next: harness team status']
      : DONE(chosen!.name, model!, where)) deps.out(line)
    return 0
  }
  const result = await deps.admin((stageDir) => ({
    script: buildModelScript({ platform: deps.platform, team: config.user, home: config.home, node: config.node,
      label: config.label, stage: stageDir, clear }),
    files: { 'connections.json': connections, 'model.json': payload, 'merge.mjs': MERGE },
  }), chosen ? `Harness wants to give the Harness Team account on ${where} the model API ${chosen.name}.` : `Harness wants to remove the Harness Team account's model API on ${where}.`)
  if (!result.ok) {
    if (result.code === 'NO_PROMPT') deps.err(`✗ ${result.message} Run it in a terminal.`)
    else if (result.code !== 'CANCELLED') deps.err(`✗ ${result.message}`)
    return 1
  }
  if (json) { deps.out(JSON.stringify({ ok: true, provider: chosen?.provider ?? null, model: model ?? null })); return 0 }
  for (const line of clear ? [`  ✓ The Harness Team account on ${where} has no model API again.`, '  Next: harness team status'] : DONE(chosen!.name, model!, where)) deps.out(line)
  return 0
}

/** The key from stdin, for scripts and for a terminal that cannot hide typing. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { text += chunk })
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', () => resolve(text))
  })
}

