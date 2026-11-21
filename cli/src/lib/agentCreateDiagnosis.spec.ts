import { describe, expect, it } from 'vitest'
import {
  describeAgentCreateFailure,
  redactArgv,
  summarizeProcessTree,
  type AgentCreatePaneFacts,
} from './agentCreateDiagnosis.js'

const base: AgentCreatePaneFacts = {
  state: { dead: false, exitStatus: null, command: 'zsh' },
  engineBin: 'codex',
  shellName: 'zsh',
  processes: [],
  elapsedMs: 1400,
}

describe('describeAgentCreateFailure', () => {
  it('names the slow-login-shell race, the case the retry window actually loses', () => {
    const detail = describeAgentCreateFailure(base)
    expect(detail).toContain('still running "zsh" startup files')
    expect(detail).toContain('"codex" had not launched yet')
    expect(detail).toContain('may still appear on its own')
  })

  it('reports an engine that started and exited, with its status', () => {
    const detail = describeAgentCreateFailure({
      ...base,
      state: { dead: true, exitStatus: 3, command: 'codex' },
    })
    expect(detail).toBe('"codex" started and exited with status 3 after 1.4s')
  })

  it('distinguishes a running-but-unrecognised process from a missing one', () => {
    const detail = describeAgentCreateFailure({
      ...base,
      state: { dead: false, exitStatus: null, command: 'node' },
    })
    expect(detail).toContain('was running "node"')
    expect(detail).toContain('no codex process was found under it')
  })

  it('reports a matched process whose registry adoption did not finish', () => {
    const detail = describeAgentCreateFailure({
      ...base,
      state: { dead: false, exitStatus: null, command: '2.1.246' },
      engineBin: 'claude',
      engineProcessFound: true,
      processes: [{ executable: 'claude', args: 'claude' }],
    })
    expect(detail).toContain('"claude" process was found under the pane')
    expect(detail).toContain('agent registration did not complete')
    expect(detail).not.toContain('no claude process')
  })

  it('says so when tmux did not keep the pane, since the output is then unrecoverable', () => {
    const detail = describeAgentCreateFailure({ ...base, state: null })
    expect(detail).toContain('tmux did not keep it')
    expect(detail).toContain('left no output to read')
  })

  it('bounds the whole detail so it cannot overflow the dialog', () => {
    const detail = describeAgentCreateFailure({
      ...base,
      state: { dead: true, exitStatus: 1, command: 'codex' },
      engineBin: 'e'.repeat(600),
    })
    expect(detail.length).toBeLessThanOrEqual(520)
  })
})

describe('redactArgv', () => {
  it('blanks credential-shaped flag values', () => {
    expect(redactArgv('codex --api-key sk-live-1 --token=abc --model gpt-5.5'))
      .toBe('codex --api-key <redacted> --token=<redacted> --model gpt-5.5')
  })

  it('blanks a long opaque run no launch argv needs to show', () => {
    expect(redactArgv('node /bin/x AKIAIOSFODNN7EXAMPLEKEYVALUE12345'))
      .toBe('node /bin/x <redacted>')
  })

  it('leaves an ordinary launch untouched', () => {
    const argv = '/bin/zsh -lic exec "$@" harness-engine codex'
    expect(redactArgv(argv)).toBe(argv)
  })
})

describe('summarizeProcessTree', () => {
  it('names what discovery walked past, which the foreground command alone does not', () => {
    expect(summarizeProcessTree([
      { executable: 'node', args: 'node /usr/local/bin/codex-update-notifier' },
      { executable: 'sh', args: 'sh -c true' },
    ])).toBe('node "node /usr/local/bin/codex-update-notifier" \u00b7 sh "sh -c true"')
  })

  it('bounds each argv so one long command cannot eat the message', () => {
    const long = summarizeProcessTree([{ executable: 'node', args: 'node ' + 'a'.repeat(300) }])
    expect(long.length).toBeLessThan(120)
  })

  it('is empty when no process could be read', () => {
    expect(summarizeProcessTree([])).toBe('')
  })
})

describe('describeAgentCreateFailure with a process tree', () => {
  it('reports the tree so a remote reader can identify an uncovered install layout', () => {
    const detail = describeAgentCreateFailure({
      ...base,
      state: { dead: false, exitStatus: null, command: 'node' },
      processes: [{ executable: 'node', args: 'node /opt/x/update-notifier.js' }],
    })
    expect(detail).toContain('no codex process was found under it')
    expect(detail).toContain('saw: node "node /opt/x/update-notifier.js"')
  })
})
