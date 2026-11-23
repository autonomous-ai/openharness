import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

// The core's sign-in, as the host is handed it (`CoreApi.account`): the host holds none of its own.
const auth = {
  session: { autonomousEnv: 'prod' } as { autonomousEnv: string } | null,
  accessToken: vi.fn(),
}
vi.mock('../lib/voiceRouter.js', () => ({ routeVoiceTask: vi.fn() }))
// The rest of the real env: the cable session's imports read their own paths from it as they load.
vi.mock('../config/env.js', async (original) => ({ env: {
  ...(await original<typeof import('../config/env.js')>()).env,
  BACKEND_WS_URL: 'wss://api.example.test/', CABLE_STT_PATH: '/api/voice/stt',
} }))

import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { DaemonCableHost, type CableHostWiring } from './cableHost.js'
import { CableSession, type CableAgent, type CableHost, type CablePort, type WindowRoute } from './cableSession.js'
import { DialLog } from './dialLog.js'
import { DIAL_VOICE_SURFACE, DIAL_VOICE_SURFACE_HEADER } from '../lib/dialUsageContract.js'

const pcm = Buffer.alloc(32_000)
const ok = () => new Response(JSON.stringify({ success: true, data: { transcript: 'a test sentence' } }), {
  headers: { 'content-type': 'application/json' },
})
const rejected = (status: number, code: string, message = 'private response detail') => new Response(JSON.stringify({
  success: false, error: { code, message },
}), { status, headers: { 'content-type': 'application/json', 'cf-ray': '0123456789abcdef-HKG' } })

function setup() {
  const log = vi.fn()
  // Transcription needs only the sign-in and log; use the real method to exercise its fetch/retry behavior.
  const host = new DaemonCableHost({
    log, accessToken: auth.accessToken, signedIn: () => auth.session !== null, environment: () => auth.session?.autonomousEnv ?? '',
    sessions: () => [], displayName: () => '',
  } as unknown as CableHostWiring)
  const fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
  return { host, log, fetchMock }
}

beforeEach(() => {
  auth.session = { autonomousEnv: 'prod' }
  auth.accessToken.mockReset().mockResolvedValue('test-access-token')
})
afterEach(() => vi.unstubAllGlobals())

describe('cabled voice transcription', () => {
  it('uploads a WAV with the signed-in environment and returns the transcript', async () => {
    const { host, fetchMock } = setup()
    fetchMock.mockResolvedValue(ok())
    await expect(host.transcribe(pcm, 16000, 'en')).resolves.toBe('a test sentence')
    const [url, options] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.test/api/voice/stt?lang=en')
    expect(options?.headers).toMatchObject({ authorization: 'Bearer test-access-token', 'x-autonomous-env': 'prod' })
    expect((options?.body as Buffer).includes(Buffer.from('RIFF'))).toBe(true)
    expect((options?.body as Buffer).includes(Buffer.from('WAVE'))).toBe(true)
  })

  it('forces one refresh after 401 even before the stored expiry, reusing the same audio', async () => {
    const { host, fetchMock } = setup()
    auth.accessToken.mockResolvedValueOnce('old-token').mockResolvedValueOnce('new-token')
    fetchMock.mockResolvedValueOnce(rejected(401, 'UNAUTHORIZED')).mockResolvedValueOnce(ok())
    await expect(host.transcribe(pcm, 16000, 'en')).resolves.toBe('a test sentence')
    expect(auth.accessToken.mock.calls).toEqual([[], [{ force: true, failedToken: 'old-token' }]])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![1]?.headers).toMatchObject({ authorization: 'Bearer new-token' })
    expect(fetchMock.mock.calls[1]![1]?.body).toBe(fetchMock.mock.calls[0]![1]?.body)
  })

  it('marks the upload as the dial\'s, on the retry too, and with nothing else', async () => {
    const { host, fetchMock } = setup()
    fetchMock.mockResolvedValueOnce(rejected(401, 'UNAUTHORIZED')).mockResolvedValueOnce(ok())
    await expect(host.transcribe(pcm, 16000, 'en')).resolves.toBe('a test sentence')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).toMatchObject({ [DIAL_VOICE_SURFACE_HEADER]: DIAL_VOICE_SURFACE })
      expect(Object.keys(options?.headers as Record<string, string>).sort())
        .toEqual(['authorization', 'content-type', 'x-autonomous-env', 'x-harness-voice-surface'])
    }
  })

  it('hands the abort signal to the post and to the 401 retry', async () => {
    const { host, fetchMock } = setup()
    const c = new AbortController()
    fetchMock.mockResolvedValueOnce(rejected(401, 'UNAUTHORIZED')).mockResolvedValueOnce(ok())
    await expect(host.transcribe(pcm, 16000, 'en', c.signal)).resolves.toBe('a test sentence')
    expect(fetchMock.mock.calls[0]![1]?.signal).toBe(c.signal)
    expect(fetchMock.mock.calls[1]![1]?.signal).toBe(c.signal)
  })

  it('an aborted signal rejects the upload', async () => {
    const { host, fetchMock } = setup()
    const c = new AbortController()
    // As the real fetch: rejects with the signal's reason, whether it aborted before the call or during it.
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      const signal = options?.signal
      if (signal?.aborted) reject(signal.reason)
      signal?.addEventListener('abort', () => reject(signal.reason))
    }))
    const upload = host.transcribe(pcm, 16000, 'en', c.signal)
    c.abort()
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops after the retry and gives a sign-in instruction for another 401', async () => {
    const { host, fetchMock, log } = setup()
    fetchMock.mockImplementation(async () => rejected(401, 'UNAUTHORIZED'))
    await expect(host.transcribe(pcm, 16000, 'en')).rejects.toThrow('Sign in again on your computer')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith('cable: stt HTTP 401 code=UNAUTHORIZED kind=json request=0123456789abcdef-HKG')
  })

  it.each(['AUTONOMOUS_ENV_MISMATCH', 'AUTONOMOUS_ENV_NOT_ALLOWED'])('identifies %s without changing environment or retrying', async (code) => {
    const { host, fetchMock, log } = setup()
    fetchMock.mockResolvedValue(rejected(403, code))
    await expect(host.transcribe(pcm, 16000, 'en')).rejects.toThrow('Sign in again on your computer')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.accessToken).toHaveBeenCalledTimes(1)
    expect(auth.session?.autonomousEnv).toBe('prod')
    expect(log.mock.calls[0]![0]).toContain(`code=${code}`)
    expect(JSON.stringify(log.mock.calls)).not.toContain('private response detail')
  })

  it('records an edge rejection without logging HTML or retrying access denial', async () => {
    const { host, fetchMock, log } = setup()
    fetchMock.mockResolvedValue(new Response('<html>private request echo test-access-token</html>', {
      status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge', 'cf-ray': '0123456789abcdef-HKG' },
    }))
    await expect(host.transcribe(pcm, 16000, 'en')).rejects.toThrow('Voice service rejected upload (403)')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('cable: stt HTTP 403 code=unknown kind=challenge request=0123456789abcdef-HKG')
  })

  it('does not reflect arbitrary JSON fields or headers into diagnostics', async () => {
    const { host, fetchMock, log } = setup()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'test-access-token', message: 'private words' } }), {
      status: 403, headers: { 'content-type': 'application/json', 'cf-ray': 'test-access-token' },
    }))
    await expect(host.transcribe(pcm, 16000, 'en')).rejects.toThrow('(403)')
    expect(log).toHaveBeenCalledWith('cable: stt HTTP 403 code=unknown kind=json request=unknown')
  })

  it.each([['{invalid', 403, 'rejected upload'], ['null', 503, 'unavailable']] as const)('handles unreadable error JSON %s', async (body, status, message) => {
    const { host, fetchMock } = setup()
    fetchMock.mockResolvedValue(new Response(body, { status, headers: { 'content-type': 'application/json' } }))
    await expect(host.transcribe(pcm, 16000, 'en')).rejects.toThrow(message)
  })

  it('does not start an upload while signed out', async () => {
    const { host, fetchMock } = setup()
    auth.session = null
    await expect(host.transcribe(pcm, 16000, 'en')).rejects.toThrow('Sign in on your computer')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// The dial's usage counts (docs/plans/2026-11-23-dial-usage-counts-design.md): each voice turn reports one end, at the
// exit that decides it, and a count never changes what the dial is told.
describe('each voice turn reports one end', () => {
  /** A port whose two ends are both in this process: the dial speaks with `say`, and `sent` is what it was told. */
  class LoopbackPort implements CablePort {
    readonly path = '/dev/loopback'
    isOpen = true
    readonly sent: Array<Record<string, unknown>> = []
    private decoder = new CableDecoder()
    constructor(private readonly onData: (chunk: Buffer) => void) {}
    async write(bytes: Uint8Array): Promise<void> {
      this.decoder.feed(Buffer.from(bytes), (frame) => {
        if (frame.type === CableType.Json) this.sent.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')))
      })
    }
    async close(): Promise<void> { this.isOpen = false }
    say(msg: Record<string, unknown>): void {
      this.onData(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(msg), 'utf8'))))
    }
    pcm(bytes: Buffer): void { this.onData(Buffer.from(encodeCableFrame(CableType.Pcm, bytes))) }
    voice(): Array<Record<string, unknown>> { return this.sent.filter((m) => String(m.t).startsWith('voice.')) }
  }

  const agents: CableAgent[] = [{ id: 'a1', name: 'Fix login screen', engine: 'claude' },
    { id: 'a2', name: 'Device firmware voice', engine: 'codex' }]

  async function talk(over: Partial<CableHost> = {}) {
    const voiceEnded = vi.fn()
    const host = {
      localMachine: () => ({ id: 'mac-local', name: 'MacBook Pro' }),
      listMachines: async () => ({ machines: [], source: 'backend' as const }),
      selectedMachine: () => 'mac-local', selectMachine: async () => ({ ok: true as const }),
      listSwarms: () => ({ selected: '', swarms: [], tiles: [] }), selectSwarm: vi.fn(), listUnread: () => [],
      appName: () => 'harness', voiceLang: () => 'en', listAgents: async () => agents, agentTotal: () => agents.length,
      activeSwarm: () => '', describe: () => undefined, sendTurn: vi.fn(), stopTurn: vi.fn(), scrolled: vi.fn(),
      answer: vi.fn(), focus: vi.fn(), openAgent: vi.fn(), updateAgent: vi.fn(), listModels: async () => [],
      recentSummaries: async () => [], log: () => {},
      forkAgent: async () => ({ ok: false as const, error: 'no' }),
      transcribe: async () => 'fix the login screen',
      route: async () => ({ agentId: 'a1', confidence: 0.9, reason: 'matched' }),
      voiceEnded,
      ...over,
    } as CableHost
    let port!: LoopbackPort
    const session = new CableSession(host, new DialLog(mkdtempSync(join(tmpdir(), 'cable-voice-'))), async (onData) => {
      port = new LoopbackPort(onData)
      return port
    })
    session.start()
    onTestFinished(() => session.stop())
    await vi.waitFor(() => expect(port).toBeDefined())
    /** One recording, from the press to the release. */
    const speak = (begin: Record<string, unknown> = {}, end: Record<string, unknown> = {}) => {
      port.say({ t: 'voice.begin', uploadId: 'u1', ...begin })
      port.pcm(Buffer.alloc(3200, 7))
      port.say({ t: 'voice.end', ...end })
    }
    /** The dial's answer has come, and the turn's end has been reported. */
    const answered = () => vi.waitFor(() => {
      expect(port.voice()).toHaveLength(1)
      expect(host.voiceEnded).toHaveBeenCalled()
    })
    return { port, host, voiceEnded, speak, answered }
  }

  it('each voice turn reports one end: sent to the agent named', async () => {
    const { voiceEnded, speak, answered } = await talk()
    speak({ agentId: 'a2' }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'sent', agentId: 'a2' }]])
  })

  it('each voice turn reports one end: sent to the router\'s pick', async () => {
    const { voiceEnded, speak, answered } = await talk()
    speak(); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'sent', agentId: 'a1' }]])
  })

  it('each voice turn reports one end: sent by the window', async () => {
    const { voiceEnded, speak, answered } = await talk({ routeInWindow: async () => ({ t: 'sent', agentId: 'a2' }) })
    speak(); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'sent', agentId: 'a2' }]])
  })

  // The window delivers what it picks: an abort while it picks does not take the words back.
  it('each voice turn reports one end: sent by the window, though aborted while it picked', async () => {
    let picked!: (route: WindowRoute) => void
    const routeInWindow = vi.fn(() => new Promise<WindowRoute>((resolve) => { picked = resolve }))
    const { port, voiceEnded, speak } = await talk({ routeInWindow })
    speak()
    await vi.waitFor(() => expect(routeInWindow).toHaveBeenCalled())
    port.say({ t: 'voice.abort', uploadId: 'u1' })
    picked({ t: 'sent', agentId: 'a2' })
    await vi.waitFor(() => expect(voiceEnded).toHaveBeenCalled())
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'sent', agentId: 'a2' }]])
  })

  it('each voice turn reports one end: cancelled in the window', async () => {
    const { voiceEnded, speak, answered } = await talk({ routeInWindow: async () => ({ t: 'cancelled' }) })
    speak(); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'cancelled' }]])
  })

  it('each voice turn reports one end: window_busy', async () => {
    const { voiceEnded, speak, answered } = await talk({ routeInWindow: async () => ({ t: 'abandoned' }) })
    speak(); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'failed', code: 'window_busy' }]])
  })

  it('each voice turn reports one end: cancelled while recording', async () => {
    const { port, voiceEnded } = await talk()
    port.say({ t: 'voice.begin', uploadId: 'u1', agentId: 'a1' })
    port.say({ t: 'voice.abort', uploadId: 'u1' })
    await vi.waitFor(() => expect(voiceEnded).toHaveBeenCalled())
    port.say({ t: 'voice.abort', uploadId: 'u1' })
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'cancelled', agentId: 'a1' }]])
  })

  it('each voice turn reports one end: cancelled while transcribing', async () => {
    let heard!: (text: string) => void
    const transcribe = vi.fn(() => new Promise<string>((resolve) => { heard = resolve }))
    const { port, host, voiceEnded, speak } = await talk({ transcribe })
    speak({ agentId: 'a1' })
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
    port.say({ t: 'voice.abort', uploadId: 'u1' })
    heard('fix the login screen')
    await vi.waitFor(() => expect(voiceEnded).toHaveBeenCalled())
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'cancelled', agentId: 'a1' }]])
    expect(host.sendTurn).not.toHaveBeenCalled()
  })

  it('each voice turn reports one end: a recording a newer one replaced is cancelled', async () => {
    const { port, voiceEnded, answered } = await talk()
    port.say({ t: 'voice.begin', uploadId: 'old', agentId: 'a1' })
    port.say({ t: 'voice.begin', uploadId: 'new', agentId: 'a2' })
    port.pcm(Buffer.alloc(3200, 7)); port.say({ t: 'voice.end' }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'cancelled', agentId: 'a1' }], [{ outcome: 'sent', agentId: 'a2' }]])
  })

  it('each voice turn reports one end: no_speech, nothing recorded', async () => {
    const { port, voiceEnded, answered } = await talk()
    port.say({ t: 'voice.begin', uploadId: 'u1', agentId: 'a1' }); port.say({ t: 'voice.end' }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'failed', code: 'no_speech', agentId: 'a1' }]])
  })

  it('each voice turn reports one end: no_speech, an empty transcript', async () => {
    const { voiceEnded, speak, answered } = await talk({ transcribe: async () => '' })
    speak({ agentId: 'a1' }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'failed', code: 'no_speech', agentId: 'a1' }]])
  })

  it('each voice turn reports one end: transcribe_failed', async () => {
    const { voiceEnded, speak, answered } = await talk({ transcribe: async () => { throw new Error('Voice is busy') } })
    speak({ agentId: 'a1' }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'failed', code: 'transcribe_failed', agentId: 'a1' }]])
  })

  it('each voice turn reports one end: route_failed', async () => {
    const { voiceEnded, speak, answered } = await talk({ route: async () => { throw new Error('Routing is down') } })
    speak(); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'failed', code: 'route_failed' }]])
  })

  it('each voice turn reports one end: no_agent', async () => {
    const { voiceEnded, speak, answered } = await talk({ route: async () => ({ agentId: '', confidence: 0, reason: '' }) })
    speak(); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'failed', code: 'no_agent' }]])
  })

  it('each voice turn reports one end: refused by the agent', async () => {
    const { voiceEnded, speak, answered } = await talk({ sendTurn: async () => ({ ok: false, message: 'Busy' }) })
    speak({ agentId: 'a1' }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'failed', code: 'refused', agentId: 'a1' }]])
  })

  it('each voice turn reports one end: refused, an agent that takes no voice', async () => {
    const transcribe = vi.fn(async () => 'fix the login screen')
    const { voiceEnded, speak, answered } = await talk({ transcribe, capsOf: () => 's' })
    speak({ agentId: 'a1' }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'failed', code: 'refused', agentId: 'a1' }]])
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('each voice turn reports one end: send_failed', async () => {
    const { voiceEnded, speak, answered } = await talk({ sendTurn: async () => { throw new Error('gone') } })
    speak({ agentId: 'a1' }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'failed', code: 'send_failed', agentId: 'a1' }]])
  })

  it('each voice turn reports one end: other, a draft to review', async () => {
    const { host, voiceEnded, speak, answered } = await talk()
    speak({ agentId: 'a1' }, { review: true }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'other' }]])
    expect(host.sendTurn).not.toHaveBeenCalled()
  })

  it('each voice turn reports one end: other, a form field', async () => {
    const form = vi.fn(async (c: import('./windowForm.js').FormCommand) => ({ ok: true, active: true, canQuery: true,
      queryId: c.queryId, revision: 2 }))
    const { voiceEnded, speak, answered } = await talk({ form })
    speak({ formId: 'form-one', formRevision: 2 }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'other' }]])
  })

  it('each voice turn reports one end: other, a search', async () => {
    const { voiceEnded, speak, answered } = await talk({ selectPassage: async () => ({ ok: false, error: 'Gone' }) })
    speak({ agentId: 'a1', searchId: 'find-one', searchRevision: 1 }); await answered()
    expect(voiceEnded.mock.calls).toEqual([[{ outcome: 'other' }]])
  })

  it('a count that throws changes nothing the dial is told', async () => {
    const { port, host, speak, answered } = await talk({ voiceEnded: vi.fn(() => { throw new Error('count failed') }) })
    speak({ agentId: 'a1' }); await answered()
    expect(host.sendTurn).toHaveBeenCalledWith('a1', 'fix the login screen')
    expect(port.voice()).toEqual([expect.objectContaining({ t: 'voice.transcript', agentId: 'a1' })])
  })
})
