import { describe, expect, it } from 'vitest'
import { dropAgentSessionEnv, isAgentSessionVariable } from './agentSessionEnv.js'

describe('an agent session\'s variables', () => {
  it('are the ones naming the session, never a setting the person chose', () => {
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CODEX_THREAD_ID', 'AI_AGENT']) expect(isAgentSessionVariable(name), name).toBe(true)
    for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HARNESSD_SERVICE_TOKEN', 'PATH']) expect(isAgentSessionVariable(name), name).toBe(false)
  })

  it('are taken out of an environment, which says which', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CODEX_HOME: '/c' }
    expect(dropAgentSessionEnv(env)).toEqual(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID'])
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/c' })
    expect(dropAgentSessionEnv(env)).toEqual([])
  })
})
