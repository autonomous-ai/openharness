import { describe, expect, it } from 'vitest'
import { dropAgentSessionEnv, isAgentSessionVariable } from './agentSessionEnv.js'

describe('an agent session\'s variables', () => {
  it('are the ones naming the session, never a setting the person chose', () => {
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CODEX_THREAD_ID', 'AI_AGENT']) expect(isAgentSessionVariable(name), name).toBe(true)
    // A Swarm agent's share of its machine's cores (superTabs/inCore/launch.ts) is that agent's: a daemon it starts from its
    // shell hands it to no pane.
    expect(isAgentSessionVariable('HARNESS_CORES')).toBe(true)
    for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HARNESSD_SERVICE_TOKEN', 'PATH']) expect(isAgentSessionVariable(name), name).toBe(false)
  })

  it('are every variable Orca sets in its terminals, its secrets among them, and take nothing else with them', () => {
    const env: NodeJS.ProcessEnv = {
      TERM: 'xterm-256color', ORCA_TERMINAL_HANDLE: 'term_1', ORCA_PAIRING_CODE: 'pairing', ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn', CODEX_HOME: '/c',
    }
    expect(dropAgentSessionEnv(env)).toEqual(['ORCA_TERMINAL_HANDLE', 'ORCA_PAIRING_CODE', 'ORCA_AGENT_SESSION_SPAWN_TOKEN'])
    expect(env).toEqual({ TERM: 'xterm-256color', CODEX_HOME: '/c' })
  })

  it('are taken out of an environment, which says which', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CODEX_HOME: '/c' }
    expect(dropAgentSessionEnv(env)).toEqual(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID'])
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/c' })
    expect(dropAgentSessionEnv(env)).toEqual([])
  })
})
