import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  session: { autonomousEnv: 'prod' } as { autonomousEnv: string } | null,
  accessToken: vi.fn(),
}))
vi.mock('../lib/authSession.js', () => ({
  readAuthSession: () => auth.session,
  AuthSessionManager: class { accessToken = auth.accessToken },
}))
vi.mock('../lib/registry.js', () => ({ registry: {}, projectDisplayName: () => '' }))
vi.mock('../lib/voiceRouter.js', () => ({ routeVoiceTask: vi.fn() }))
vi.mock('../config/env.js', () => ({ env: {
  BACKEND_WS_URL: 'wss://api.example.test/', CABLE_STT_PATH: '/api/voice/stt',
} }))

import { DaemonCableHost, type CableHostWiring } from './cableHost.js'

const pcm = Buffer.alloc(32_000)
const ok = () => new Response(JSON.stringify({ success: true, data: { transcript: 'a test sentence' } }), {
  headers: { 'content-type': 'application/json' },
})
const rejected = (status: number, code: string, message = 'private response detail') => new Response(JSON.stringify({
  success: false, error: { code, message },
}), { status, headers: { 'content-type': 'application/json', 'cf-ray': '0123456789abcdef-HKG' } })

function setup() {
  const log = vi.fn()
  // Transcription needs only log; use the real method to exercise its fetch/retry behavior.
  const host = new DaemonCableHost({ log } as unknown as CableHostWiring)
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
