/**
 * What the person lets agents do with Harness (docs/design/2026-10-11-agent-client.md): three of the account's
 * experiments, Settings ▸ Experimental (backend lib/experimentalSettings.ts), each off until the person turns it on.
 * They were each computer's own Settings ▸ Agents, on by default, until the owner made them the account's, one choice
 * for every computer, and off for all: none had been announced (2026-10-12).
 *
 * This computer's daemon keeps a copy in its data folder, `agent-settings.json`, because nothing that reads them may
 * wait on the network: every launch (whether its agent is told how to start others, and whether one another agent
 * started says so in its pull requests), `harness new` when an agent runs it (whether it may), and Agent Messages
 * every 2 s. The core's sync (core/experiments.ts `createAgentSettingsSync`) is its only writer, and writes it for an
 * account and this computer's machine in it. A copy written for another account, or read while signed out, is the
 * defaults: a copy kept for the whole installation must never turn one account's experiments on for another (the
 * desktop app keeps the same rule for its own). A file that is missing or cannot be read is the defaults too, never a
 * refusal to work.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAuthSession, type AuthSession } from './authSession.js'

export interface AgentSettings {
  /** Agents may start, wait for and close harnesses of their own, and are told how as they start. */
  agentsStartAgents: boolean
  /** A harness another agent started adds a line to the pull requests it opens (lib/agentAttribution.ts). Read at
   *  each launch of one, so a harness running when it is turned off keeps its line until it restarts. */
  pullRequestLine: boolean
  /** Agents in the same tab may message each other (`harness send`, messages/service.ts). It replaced each tab's own
   *  switch, a chat icon beside its × that was easy to hit by mistake (owner, 2026-10-12). */
  agentMessages: boolean
  /** Agent Messages does not tell a shared tab's other accounts a one-line summary of what each harness does. Stored
   *  inverted, as the account's experiment is (backend lib/experimentalSettings.ts): every one of them is "off unless
   *  true", and sharing the summary is the default. */
  agentMessagesHideSummary: boolean
  /** An agent may give more work to a harness it started (`harness tell`, messages/tell.ts), with no tab and whether
   *  Agent Messages are on or not. A switch of its own, off by default: the owner ruled that a harness another started
   *  gets no exception from Agent Messages (2026-10-11), so this one-way order from the starter is the person's to
   *  allow, not a side effect of starting. */
  agentsTellAgents: boolean
}

export const AGENT_SETTINGS_DEFAULTS: AgentSettings = { agentsStartAgents: false, pullRequestLine: false, agentMessages: false, agentMessagesHideSummary: false, agentsTellAgents: false }

/** Each setting's name in `harness settings`, and its key. */
export const AGENT_SETTING_NAMES: Record<string, keyof AgentSettings> = { 'agents-start-agents': 'agentsStartAgents', 'agents-tell-agents': 'agentsTellAgents', 'pull-request-line': 'pullRequestLine', 'agent-messages': 'agentMessages', 'agent-messages-hide-summary': 'agentMessagesHideSummary' }

/** Each setting's account experiment, as the backend names it (lib/experimentalSettings.ts `experimentalFeatures`). */
export const AGENT_SETTING_EXPERIMENTS: Record<keyof AgentSettings, string> = { agentsStartAgents: 'agents_start_agents', pullRequestLine: 'agent_pull_request_line', agentMessages: 'agent_messages', agentMessagesHideSummary: 'agent_messages_hide_summary', agentsTellAgents: 'agents_tell_agents' }

/** Whom a copy is for: the account, and this computer's machine in it. A machine is one account's, so a sign-in to
 *  another account on this computer has another. */
export interface AgentSettingsOwner { accountId: string; machineId: string }

export const agentSettingsPath = (dataDir: string): string => join(dataDir, 'agent-settings.json')

/** Whether a copy kept for [owner] is this sign-in's: the same machine, and the same account where the session knows
 *  its account (`signInAcct`, recorded after a sign-in by hand). */
export const ownsAgentSettings = (owner: AgentSettingsOwner, session: AuthSession | null): boolean =>
  !!session?.machineId && owner.machineId === session.machineId && (!session.signInAcct || owner.accountId === session.signInAcct)

/** The settings for whoever is signed in here now ([session], read from its file unless given). */
export function readAgentSettings(dataDir: string, session: AuthSession | null = readAuthSession()): AgentSettings {
  try {
    const saved = JSON.parse(readFileSync(agentSettingsPath(dataDir), 'utf8')) as Record<string, unknown>
    // A copy from before they were the account's names no one: Settings ▸ Agents wrote it, for this computer alone.
    if (typeof saved.accountId !== 'string' || typeof saved.machineId !== 'string'
      || !ownsAgentSettings({ accountId: saved.accountId, machineId: saved.machineId }, session)) return { ...AGENT_SETTINGS_DEFAULTS }
    return Object.fromEntries(Object.entries(AGENT_SETTINGS_DEFAULTS)
      .map(([key, fallback]) => [key, typeof saved[key] === 'boolean' ? saved[key] : fallback])) as unknown as AgentSettings
  } catch {
    return { ...AGENT_SETTINGS_DEFAULTS }
  }
}

/** The settings an answer of `GET` or `PATCH /api/experimental-settings` gives, and whose; null for any other
 *  answer. An experiment the backend does not name (one from before them) is off. */
export function agentSettingsFromAnswer(answer: { status: number; body: Record<string, unknown> }): { accountId: string; settings: AgentSettings } | null {
  const data = answer.status === 200 && answer.body.success === true ? answer.body.data as { accountId?: unknown; features?: unknown } | null | undefined : null
  if (typeof data?.accountId !== 'string' || !data.accountId || !data.features || typeof data.features !== 'object') return null
  const features = data.features as Record<string, unknown>
  return {
    accountId: data.accountId,
    settings: Object.fromEntries(Object.entries(AGENT_SETTING_EXPERIMENTS).map(([key, feature]) => [key, features[feature] === true])) as unknown as AgentSettings,
  }
}

/** Keeps [settings] for [owner]: written whole and renamed into place, so a reader never sees half a file. The core's
 *  sync alone calls it. */
export function saveAgentSettings(dataDir: string, owner: AgentSettingsOwner, settings: AgentSettings): void {
  const path = agentSettingsPath(dataDir)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 2, accountId: owner.accountId, machineId: owner.machineId, ...settings })}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}
