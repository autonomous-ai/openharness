import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SETTING_EXPERIMENTS, AGENT_SETTING_NAMES, agentSettingsFromAnswer, agentSettingsPath, ownsAgentSettings, readAgentSettings, saveAgentSettings } from './agentSettings.js'
import { clearAuthSession, writeAuthSession, type AuthSession } from './authSession.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-settings-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); clearAuthSession() })

const OFF = { agentsStartAgents: false, pullRequestLine: false, agentMessages: false, agentMessagesHideSummary: false, agentsTellAgents: false }
const session = (over: Partial<AuthSession> = {}): AuthSession =>
  ({ version: 1, accessToken: 't', autonomousEnv: 'prod', computerId: 'c', machineId: 'm1', updatedAt: 0, ...over })
const owner = { accountId: 'acct', machineId: 'm1' }

describe('what the person lets agents do', () => {
  it('is nothing until the account turns a switch on: every one off by default', () => {
    // Off for all: none had been announced (owner, 2026-10-12).
    expect(readAgentSettings(dir, session())).toEqual(OFF)
    expect(readAgentSettings(dir, null)).toEqual(OFF)
    expect(AGENT_SETTING_NAMES).toEqual({ 'agents-start-agents': 'agentsStartAgents', 'agents-tell-agents': 'agentsTellAgents', 'pull-request-line': 'pullRequestLine', 'agent-messages': 'agentMessages', 'agent-messages-hide-summary': 'agentMessagesHideSummary' })
    expect(AGENT_SETTING_EXPERIMENTS).toEqual({ agentsStartAgents: 'agents_start_agents', pullRequestLine: 'agent_pull_request_line', agentMessages: 'agent_messages', agentMessagesHideSummary: 'agent_messages_hide_summary', agentsTellAgents: 'agents_tell_agents' })
  })

  it('reads the copy kept for the account signed in here, written whole and private', () => {
    saveAgentSettings(dir, owner, { ...OFF, agentMessages: true })
    expect(readAgentSettings(dir, session())).toEqual({ ...OFF, agentMessages: true })
    expect(readAgentSettings(dir, session({ signInAcct: 'acct' }))).toEqual({ ...OFF, agentMessages: true })
    expect(JSON.parse(readFileSync(agentSettingsPath(dir), 'utf8'))).toEqual({ version: 2, accountId: 'acct', machineId: 'm1', ...OFF, agentMessages: true })
    expect(statSync(agentSettingsPath(dir)).mode & 0o777).toBe(0o600)
    // Read from the session's own file when not given one.
    expect(readAgentSettings(dir)).toEqual(OFF)
    writeAuthSession(session())
    expect(readAgentSettings(dir)).toEqual({ ...OFF, agentMessages: true })
  })

  it('never turns one account\'s experiments on for another, or for no one', () => {
    saveAgentSettings(dir, owner, { agentsStartAgents: true, pullRequestLine: true, agentMessages: true, agentMessagesHideSummary: true, agentsTellAgents: true })
    // Signed out, signed in with no machine yet, to another account's machine, or to another account.
    expect(readAgentSettings(dir, null)).toEqual(OFF)
    expect(readAgentSettings(dir, session({ machineId: undefined }))).toEqual(OFF)
    expect(readAgentSettings(dir, session({ machineId: 'm2' }))).toEqual(OFF)
    expect(readAgentSettings(dir, session({ signInAcct: 'other' }))).toEqual(OFF)
    expect(ownsAgentSettings(owner, session())).toBe(true)
    expect(ownsAgentSettings(owner, session({ signInAcct: 'other' }))).toBe(false)
    // A copy from when they were each computer's own Settings ▸ Agents names no account: it is no one's.
    writeFileSync(agentSettingsPath(dir), '{"version":1,"agentsStartAgents":true,"pullRequestLine":true,"agentMessages":true}')
    expect(readAgentSettings(dir, session())).toEqual(OFF)
  })

  it('reads what a copy does not say, or says wrongly, and a broken file, as the defaults', () => {
    writeFileSync(agentSettingsPath(dir), '{"version":2,"accountId":"acct","machineId":"m1","agentsStartAgents":true,"agentMessages":"on"}')
    expect(readAgentSettings(dir, session())).toEqual({ ...OFF, agentsStartAgents: true })
    writeFileSync(agentSettingsPath(dir), 'not json')
    expect(readAgentSettings(dir, session())).toEqual(OFF)
  })

  it('takes the account\'s experiments from its answer, and nothing from any other', () => {
    const answer = (data: unknown, status = 200, success = true) => ({ status, body: { success, data } })
    expect(agentSettingsFromAnswer(answer({ accountId: 'acct', revision: 3, features: { share_button: true, agent_messages: true, agents_start_agents: false } })))
      .toEqual({ accountId: 'acct', settings: { ...OFF, agentMessages: true } })
    // The summary switch is stored inverted (T4): true hides it, and a backend that does not name it leaves it shown.
    expect(agentSettingsFromAnswer(answer({ accountId: 'acct', features: { agent_messages_hide_summary: true } })))
      .toEqual({ accountId: 'acct', settings: { ...OFF, agentMessagesHideSummary: true } })
    // A backend from before them names none: off.
    expect(agentSettingsFromAnswer(answer({ accountId: 'acct', features: { share_button: true } }))).toEqual({ accountId: 'acct', settings: OFF })
    for (const refused of [answer({ accountId: 'acct', features: {} }, 401), answer({ accountId: 'acct', features: {} }, 200, false), answer(null),
      answer({ features: {} }), answer({ accountId: '', features: {} }), answer({ accountId: 'acct' }), answer({ accountId: 'acct', features: 'on' })]) {
      expect(agentSettingsFromAnswer(refused)).toBeNull()
    }
  })
})
