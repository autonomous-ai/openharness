import { afterEach, describe, expect, it, vi } from 'vitest'
import { setAgentSignaller, signalAgentProcess } from './processSignals.js'

afterEach(() => { setAgentSignaller(null); vi.restoreAllMocks() })

describe('signalAgentProcess', () => {
  it('defaults to process.kill with the same pid and signal, and propagates its throw', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    signalAgentProcess(50, 'SIGKILL')
    expect(kill).toHaveBeenCalledExactlyOnceWith(50, 'SIGKILL')
    kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    expect(() => signalAgentProcess(50, 'SIGTERM')).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  })

  it('uses an injected signaller until it is cleared', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const injected = vi.fn()
    setAgentSignaller(injected)
    signalAgentProcess(51, 'SIGTERM')
    expect(injected).toHaveBeenCalledExactlyOnceWith(51, 'SIGTERM')
    expect(kill).not.toHaveBeenCalled()
    setAgentSignaller(null)
    signalAgentProcess(51, 'SIGTERM')
    expect(kill).toHaveBeenCalledExactlyOnceWith(51, 'SIGTERM')
  })
})
