import { describe, expect, it } from 'vitest'
import { describeAgentCreateFailure, redactArgv } from './agentCreateDiagnosis.js'

describe('describeAgentCreateFailure', () => {
  it('reports an engine that started and exited, with its status', () => {
    expect(describeAgentCreateFailure('codex', 3, 1400)).toBe('"codex" started and exited with status 3 after 1.4s')
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
