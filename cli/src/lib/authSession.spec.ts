import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'

const authDir = await mkdtemp(`${tmpdir()}/harness-auth-session-`)
process.env.HARNESS_AUTH_DIR = authDir

const {
  ADOPTED_SIGN_IN,
  AUTH_SESSION_FILE,
  AuthSessionError,
  AuthSessionManager,
  clearAuthSession,
  ensureSignInEpoch,
  newSignInEpoch,
  readAuthSession,
  releaseHeldAuthLock,
  signInOf,
  writeAuthSession,
} = await import('./authSession.js')

const baseSession = () => ({
  version: 1 as const,
  accessToken: 'old-access',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() - 1,
  autonomousEnv: 'prod' as const,
  computerId: 'computer-1',
  machineId: 'machine-1',
  updatedAt: Date.now(),
})

afterEach(() => {
  clearAuthSession()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  delete process.env.HARNESS_AUTH_DIR
  await rm(authDir, { recursive: true, force: true })
})

describe('sign-in epoch', () => {
  it('rides along every rewrite of the session — a refresh and a new machine id', async () => {
    const epoch = newSignInEpoch()
    writeAuthSession({ ...baseSession(), signInEpoch: epoch })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { token: 'refreshed-access', refreshToken: 'refreshed-refresh', expiresIn: 3600 },
    }))))
    const manager = new AuthSessionManager('https://api.example.test')
    await manager.accessToken()
    manager.updateMachineId('machine-2')
    expect(readAuthSession()).toMatchObject({ accessToken: 'refreshed-access', machineId: 'machine-2', signInEpoch: epoch })
    expect(newSignInEpoch()).not.toBe(epoch)
  })

  it('gives a session from before epochs an adopted one, once, keeping its tokens', async () => {
    writeAuthSession(baseSession())
    const epoch = await ensureSignInEpoch()
    expect(epoch?.startsWith(ADOPTED_SIGN_IN)).toBe(true)
    expect(readAuthSession()).toMatchObject({ signInEpoch: epoch, refreshToken: 'refresh-1' })
    expect(await ensureSignInEpoch()).toBe(epoch)
    clearAuthSession()
    expect(await ensureSignInEpoch()).toBeNull()
  })

  it('says when it was made, and whether it was adopted — as the device key log reads it', () => {
    const epoch = newSignInEpoch(1_234)
    expect(epoch).toMatch(/^[0-9a-f]{32}@1234$/)
    expect(signInOf(epoch)).toEqual({ epoch, adopted: false, at: 1_234 })
    expect(signInOf(`${ADOPTED_SIGN_IN}${epoch}`)).toEqual({ epoch: `${ADOPTED_SIGN_IN}${epoch}`, adopted: true, at: 1_234 })
    // One from before the time was recorded.
    expect(signInOf('0123456789abcdef0123456789abcdef')).toMatchObject({ adopted: false, at: null })
    expect(signInOf(undefined)).toBeNull()
    expect(signInOf('')).toBeNull()
  })
})

it('reads a legacy session without interpreting optional metadata or rewriting the sign-in', async () => {
  const saved = { ...baseSession(), memoryOwner: { profileId: 'legacy-preview', owner: 'fixture' },
    futureMetadata: { value: 'preserved-on-disk' } }
  await writeFile(AUTH_SESSION_FILE, JSON.stringify(saved), { mode: 0o600 })
  const bytes = await readFile(AUTH_SESSION_FILE, 'utf8')
  expect(readAuthSession()).toMatchObject({ accessToken: saved.accessToken, refreshToken: saved.refreshToken,
    computerId: saved.computerId, machineId: saved.machineId })
  expect(readAuthSession()).not.toHaveProperty('memoryOwner')
  expect(await readFile(AUTH_SESSION_FILE, 'utf8')).toBe(bytes)
})

describe('AuthSessionManager', () => {

  it('coalesces concurrent expired-token refreshes into one request and persists the rotated tokens', async () => {
    writeAuthSession(baseSession())
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { token: 'new-access', refreshToken: 'refresh-2', expiresIn: 3600 },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const manager = new AuthSessionManager('https://api.example.test')

    await expect(Promise.all([manager.accessToken(), manager.accessToken()])).resolves.toEqual(['new-access', 'new-access'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(readAuthSession()).toMatchObject({ accessToken: 'new-access', refreshToken: 'refresh-2' })
    await expect(readFile(AUTH_SESSION_FILE, 'utf8')).resolves.toContain('new-access')
  })

  it('refreshes as the client the session was issued to, and names none for a session that kept none', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      success: true,
      data: { token: 'new-access', expiresIn: 3600 },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const manager = new AuthSessionManager('https://api.example.test')
    const sent = (call: number) => JSON.parse(String(fetchMock.mock.calls[call]![1]?.body)) as Record<string, unknown>

    writeAuthSession({ ...baseSession(), clientId: 'harness-desktop' })
    await manager.accessToken()
    expect(sent(0)).toEqual({ refreshToken: 'refresh-1', autonomousEnv: 'prod', clientId: 'harness-desktop' })
    // The client outlives the refresh: the next one names it too.
    expect(readAuthSession()).toMatchObject({ accessToken: 'new-access', clientId: 'harness-desktop' })

    writeAuthSession(baseSession())
    await manager.accessToken()
    expect(sent(1)).toEqual({ refreshToken: 'refresh-1', autonomousEnv: 'prod' })
  })

  it('reads back only a client that is ours', async () => {
    await writeFile(AUTH_SESSION_FILE, JSON.stringify({ ...baseSession(), clientId: 'someone-else' }))
    expect(readAuthSession()).not.toHaveProperty('clientId')
  })

  // `process.exit` skips `finally`: a daemon that exited mid-refresh left the lock for the next
  // `harness auth status` to wait out (30s), which is how long the desktop app waits for it.
  it('drops the refresh lock when the process exits while holding it, and only then', async () => {
    const lock = `${authDir}/session.lock`
    writeAuthSession(baseSession())
    let answer!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((resolve) => { answer = resolve })))
    const refreshing = new AuthSessionManager('https://api.example.test').accessToken()
    await vi.waitFor(() => stat(lock))
    releaseHeldAuthLock() // what the `exit` handler runs
    await expect(stat(lock)).rejects.toThrow()
    answer(new Response(JSON.stringify({ success: true, data: { token: 'new-access', expiresIn: 3600 } })))
    await expect(refreshing).resolves.toBe('new-access')

    // Another process's lock is not ours to remove.
    await writeFile(lock, '')
    releaseHeldAuthLock()
    await expect(stat(lock)).resolves.toBeTruthy()
    await rm(lock, { force: true })
  })

  it('uses the newer persisted access token rather than refreshing a stale 401 again', async () => {
    writeAuthSession({ ...baseSession(), accessToken: 'already-refreshed', expiresAt: Date.now() + 3_600_000 })
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const manager = new AuthSessionManager('https://api.example.test')

    await expect(manager.accessToken({ force: true, failedToken: 'old-access' })).resolves.toBe('already-refreshed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names `harness login` when the refresh service answers 503, because that is what a dead token looks like here', async () => {
    // Measured 2026-09-06 against the live backend: an unusable refresh token comes back as
    // `503 {"error":{"code":"AUTH_SERVICE_UNAVAILABLE"}}`, NOT 401 and not REFRESH_TOKEN_INVALID.
    // So this answer is indistinguishable from a real outage, and the message has to carry both
    // readings — saying only the upstream's "Authentication service unavailable" sends somebody
    // with a dead sign-in away to wait for a service that is fine.
    writeAuthSession(baseSession())
    // A fresh Response per call: a body can only be read once, so one shared Response would make
    // every call after the first see an empty body and prove nothing about the message.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      success: false,
      error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication service unavailable' },
    }), { status: 503 })))
    const manager = new AuthSessionManager('https://api.example.test')

    const err = await manager.accessToken().catch((e: unknown) => e) as InstanceType<typeof AuthSessionError>
    expect(err).toMatchObject({ name: AuthSessionError.name, code: 'UNAVAILABLE' })
    expect(err.message).toMatch(/harness login/)          // the way out, which the upstream never names
    expect(err.message).toMatch(/Authentication service unavailable/)  // the upstream's own words, kept
  })

  it('keeps the session when the refresh service is merely unavailable', async () => {
    // The other half of the same ambiguity, and the reason this must NOT be reclassified as
    // INVALID_REFRESH: that branch deletes the session, and deleting it on a transient blip
    // destroys a refresh token nothing can bring back. Ambiguous means keep, and say so.
    writeAuthSession(baseSession())
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication service unavailable' },
    }), { status: 503 })))
    const manager = new AuthSessionManager('https://api.example.test')

    await expect(manager.accessToken()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(readAuthSession()).toMatchObject({ refreshToken: 'refresh-1' })
  })

  it('gives up on a refresh that never answers, keeping the session', async () => {
    // The daemon's reconnect waits on this call, and the desktop never restarts a daemon that is
    // alive — an unbounded fetch here was a machine "connected" in status and disconnected in fact.
    writeAuthSession(baseSession())
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const manager = new AuthSessionManager('https://api.example.test', { refreshTimeoutMs: 50 })

    await expect(manager.accessToken()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(readAuthSession()).toMatchObject({ refreshToken: 'refresh-1' })
  })

  it('still says `harness login` when the service gives no message of its own', async () => {
    writeAuthSession(baseSession())
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('socket hang up')))
    const manager = new AuthSessionManager('https://api.example.test')

    await expect(manager.accessToken()).rejects.toThrow(/harness login/)
    expect(readAuthSession()).toMatchObject({ refreshToken: 'refresh-1' })
  })

  it('clears an invalid refresh session instead of retrying it forever', async () => {
    writeAuthSession(baseSession())
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: { code: 'REFRESH_TOKEN_INVALID', message: 'expired' },
    }), { status: 401 })))
    const manager = new AuthSessionManager('https://api.example.test')

    await expect(manager.accessToken()).rejects.toMatchObject({ name: AuthSessionError.name, code: 'INVALID_REFRESH' })
    expect(readAuthSession()).toBeNull()
  })
})
