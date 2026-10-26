/**
 * `harness settings`: what the person lets agents do (lib/agentSettings.ts), the account's three experiments in
 * Settings ▸ Experimental, for a terminal or a machine with no window. Each is off until the person turns it on.
 *
 *     harness settings                          every setting and its state
 *     harness settings agents-start-agents on   turn one on or off, for the account
 *
 * It asks this computer's daemon (`/api/agent-settings`), which reads them as this computer keeps them and writes a
 * change through to the account (core/experiments.ts `createAgentSettingsSync`): the copy is the daemon's alone.
 */
import { AGENT_SETTING_NAMES, askThePersonFirst, PERSON_SAID_YES, type AgentSettings } from '../lib/agentSettings.js'
import { localCredentialHeaders } from '../lib/localCredential.js'
import { env } from '../config/env.js'
import { daemonUnreachableText } from '../lib/daemonState.js'
import { outsideCaller } from './model.js'

/** A refusal, as the agent verbs exit (commands.ts `EXIT.refused`): not a failure to retry. */
const REFUSED = 5

/** Said to an agent that tries to turn a setting on without the person's yes: the consent is theirs to give, and the
 *  agent asks them for it (lib/agentSettings.ts `askThePersonFirst`). */
export const settingsOnlyThePerson = (name: string, value: 'on' | 'off' = 'on'): string =>
  askThePersonFirst(name, 'leave it as it is, and do the work another way.', value)

/** The value of a setting that widens what is shared or allowed, which only the person gives. Every setting is granted by `on`
 *  but the summary switch, which is stored inverted: it widens sharing when it is turned off. */
const GRANTING: Partial<Record<keyof AgentSettings, 'off'>> = { agentMessagesHideSummary: 'off' }

export const SETTINGS_USAGE = `Usage: harness settings [<name> on|off [${PERSON_SAID_YES}]]

What agents may do, as Settings ▸ Experimental shows it: experiments of your account, the same on each of its
computers, and each off until you turn it on:
  agents-start-agents   agents may start, wait for and close harnesses of their own, and are told how
  agents-tell-agents    an agent may give more work to a harness it started (harness tell), with no tab
  pull-request-line     a harness another agent starts says so in the pull requests it opens: one line beside the
                        engine's own
  agent-messages        agents in the same tab may message each other with harness send
  agent-messages-hide-summary
                        keep the one-line summary of what a harness does from a shared tab's other accounts
                        (on hides it; it is shared while this is off)

An agent turns one on only for the person: it asks them first, with its tool for asking them (Claude Code:
AskUserQuestion; Codex: request_user_input) or in its reply, and adds ${PERSON_SAID_YES} once they said yes.
Turning one off needs no one's yes.`

const ABOUT: Record<keyof AgentSettings, string> = {
  agentsStartAgents: 'agents may start, wait for and close harnesses of their own',
  agentsTellAgents: 'an agent may give more work to a harness it started',
  pullRequestLine: 'a harness another agent starts says so in the pull requests it opens',
  agentMessages: 'agents in the same tab may message each other',
  agentMessagesHideSummary: 'the one-line summary of what a harness does is kept from a shared tab\'s other accounts',
}

export const SETTINGS_SIGNED_OUT = 'Signed out: these are experiments of your account. Sign in (harness login) to turn them on.'

export interface SettingsDeps {
  /** This computer's daemon's port (lib/daemonState.ts `daemonPort`). */
  port: number
  /** Its data dir, where its local credential is (lib/localCredential.ts). */
  dataDir?: string
  /** Who runs it, by what its shell says (model.ts `outsideCaller`): an agent may not turn a setting on. */
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  out?: (line: string) => void
  err?: (line: string) => void
}

type Answer = { status: number; body: Record<string, unknown> }

export async function settingsCommand(argv: readonly string[], deps: SettingsDeps): Promise<number> {
  const out = deps.out ?? console.log
  const err = deps.err ?? console.error
  if (argv.includes('--help') || argv.includes('-h')) { out(SETTINGS_USAGE); return 0 }
  let change: Record<string, unknown> | null = null
  let saidYes = false
  if (argv.length) {
    const yes = argv.includes(PERSON_SAID_YES)
    const [name, value, ...rest] = argv.filter((word) => word !== PERSON_SAID_YES)
    const key = AGENT_SETTING_NAMES[name]
    if (!key || (value !== 'on' && value !== 'off') || rest.length) { err(SETTINGS_USAGE); return 2 }
    change = { [key]: value === 'on' }
    // An agent refused a start would otherwise turn on the setting that refused it, and the person's say would be its
    // own. Its shell says it is one (Claude Code, Codex, AI_AGENT), in a Harness pane or not. Turning one off is safe,
    // but for the one stored inverted. It may once it asked the person and they said yes: people ask their agent for
    // the work and never open a terminal for this (2026-10-26). The yes is the agent's word, so it is named in the
    // daemon's log with the agent that gave it.
    const granting = GRANTING[key] ?? 'on'
    const agent = outsideCaller(deps.env ?? process.env, '')
    if (value === granting && agent) {
      if (!yes) { err(settingsOnlyThePerson(name, granting)); return REFUSED }
      saidYes = true
      change.byAgent = agent.name
    }
  }
  let answer: Answer
  try {
    const response = await (deps.fetch ?? fetch)(`http://127.0.0.1:${deps.port}/api/agent-settings`, {
      method: change ? 'PATCH' : 'GET',
      // The local API's CSRF gate: a write must say it comes from this computer.
      headers: { 'x-adapter-local': '1', ...localCredentialHeaders(deps.dataDir ?? env.ADAPTER_DATA_DIR), ...(change ? { 'content-type': 'application/json' } : {}) },
      ...(change ? { body: JSON.stringify(change) } : {}),
      signal: AbortSignal.timeout(20_000),
    })
    answer = { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> }
  } catch (error) {
    err(daemonUnreachableText((error as { cause?: unknown }).cause ?? error))
    return 1
  }
  if (answer.status !== 200) {
    const error = answer.body.error as { message?: unknown } | undefined
    err(typeof error?.message === 'string' ? error.message : `Harness could not ${change ? 'change' : 'read'} the settings (${answer.status}).`)
    return 1
  }
  if (change) {
    const [key] = Object.keys(change).filter((each) => each !== 'byAgent') as Array<keyof AgentSettings>
    const name = Object.keys(AGENT_SETTING_NAMES).find((each) => AGENT_SETTING_NAMES[each] === key)!
    out(`${name} is ${answer.body[key] === true ? 'on' : 'off'} for your account.${saidYes ? ' The person said yes; tell them they can turn it off any time by asking you.' : ''}`)
    return 0
  }
  out(Object.entries(AGENT_SETTING_NAMES)
    .map(([name, key]) => `${name.padEnd(28)}${answer.body[key] === true ? 'on ' : 'off'}  ${ABOUT[key]}`).join('\n'))
  if (answer.body.signedIn === false) out(SETTINGS_SIGNED_OUT)
  return 0
}
