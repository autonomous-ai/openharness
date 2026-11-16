import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openRouterComplete, resolveOpenRouterKey } from './openrouter.js'

const KEY = 'sk-or-v1-file-key'
const originalPath = process.env.ORI_CREDENTIALS_PATH
const originalEnvKey = process.env.OPENROUTER_API_KEY
const dirs: string[] = []

function credentialsFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ori-cred-'))
  dirs.push(dir)
  const file = join(dir, 'credentials.json')
  writeFileSync(file, contents)
  return file
}

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY
  // A path that does not exist is the normal state on a machine without ori.
  process.env.ORI_CREDENTIALS_PATH = join(tmpdir(), 'ori-cred-absent', 'credentials.json')
})

afterEach(() => {
  if (originalPath === undefined) delete process.env.ORI_CREDENTIALS_PATH
  else process.env.ORI_CREDENTIALS_PATH = originalPath
  if (originalEnvKey === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = originalEnvKey
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('resolveOpenRouterKey', () => {
  it('prefers the daemon env, then the credentials file', async () => {
    process.env.ORI_CREDENTIALS_PATH = credentialsFile(JSON.stringify({ key: KEY }))
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-daemon'
    expect(await resolveOpenRouterKey()).toBe('sk-or-v1-daemon')

    delete process.env.OPENROUTER_API_KEY
    expect(await resolveOpenRouterKey()).toBe(KEY)
  })

  it('returns null — never throws — when the file is absent, corrupt or keyless', async () => {
    expect(await resolveOpenRouterKey()).toBeNull()
    process.env.ORI_CREDENTIALS_PATH = credentialsFile('{not json')
    expect(await resolveOpenRouterKey()).toBeNull()
    process.env.ORI_CREDENTIALS_PATH = credentialsFile(JSON.stringify({ userId: 'or_user_1' }))
    expect(await resolveOpenRouterKey()).toBeNull()
  })

  it('re-reads after the file changes, so `ori login` needs no daemon restart', async () => {
    const file = credentialsFile(JSON.stringify({ key: 'sk-or-v1-old' }))
    process.env.ORI_CREDENTIALS_PATH = file
    expect(await resolveOpenRouterKey()).toBe('sk-or-v1-old')
    writeFileSync(file, JSON.stringify({ key: 'sk-or-v1-new' }))
    expect(await resolveOpenRouterKey()).toBe('sk-or-v1-new')
  })
})

describe('openRouterComplete', () => {
  const options = { prompt: 'summarize this', model: 'deepseek/deepseek-v4-flash', apiKey: KEY }

  it('sends the prompt and returns the completion text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: ' recap\n\nbody ' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await openRouterComplete(options)).toBe('recap\n\nbody')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: options.model,
      messages: [{ role: 'user', content: options.prompt }],
    })
  })

  it('returns null on an HTTP error instead of failing the turn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 402, text: async () => 'no credits' }))
    expect(await openRouterComplete(options)).toBeNull()
  })

  it('logs an HTTP error by its status and token code and type, never text that can quote the prompt', async () => {
    // A moderation refusal's body carries `metadata.flagged_input`: a piece of the prompt, which for the voice router
    // is the person's spoken words and their sessions' names. Its `message`, or a free-text `type`, is not proven
    // never to quote it either.
    const refusal = {
      error: {
        code: 403,
        type: 'flagged: SECRET-TRANSCRIPT',
        message: 'Your input "SECRET-TRANSCRIPT fix the login bug" was flagged for "harassment".',
        metadata: { reasons: ['harassment'], flagged_input: 'SECRET-TRANSCRIPT fix the login bug', provider_name: 'x' },
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => JSON.stringify(refusal) }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await openRouterComplete(options)).toBeNull()
      expect(warn.mock.calls[0]).toEqual([`[openrouter] ${options.model} failed with HTTP 403 · code=403`])
      const limited = { error: { code: 'rate_limit_exceeded', type: 'requests', message: 'SECRET slow down' } }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => JSON.stringify(limited) }))
      expect(await openRouterComplete(options)).toBeNull()
      expect(warn.mock.calls[1]).toEqual([`[openrouter] ${options.model} failed with HTTP 429 · code=rate_limit_exceeded · type=requests`])
      // A body that is not OpenRouter's error shape says only its status.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => '<html>SECRET bad gateway</html>' }))
      expect(await openRouterComplete(options)).toBeNull()
      expect(warn.mock.calls[2]).toEqual([`[openrouter] ${options.model} failed with HTTP 502`])
      expect(warn.mock.calls.flat().join('\n')).not.toContain('SECRET')
    } finally { warn.mockRestore() }
  })

  it('returns null on a transport failure and on an empty completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    expect(await openRouterComplete(options)).toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) }))
    expect(await openRouterComplete(options)).toBeNull()
  })

  it('logs a failed call by its error name and token code, never a message that can quote the body', async () => {
    // V8's JSON.parse error quotes a window of the body it failed on, and a completion's body holds the model's
    // answer, which for the voice router can repeat the person's spoken words.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => JSON.parse('SECRET-TRANSCRIPT fix the login bug') }))
      expect(await openRouterComplete(options)).toBeNull()
      expect(warn.mock.calls[0]).toEqual([`[openrouter] ${options.model} call failed: SyntaxError`])
      const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(reset))
      expect(await openRouterComplete(options)).toBeNull()
      expect(warn.mock.calls[1]).toEqual([`[openrouter] ${options.model} call failed: TypeError · code=ECONNRESET`])
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('SECRET thrown text'))
      expect(await openRouterComplete(options)).toBeNull()
      expect(warn.mock.calls[2]).toEqual([`[openrouter] ${options.model} call failed: error`])
      expect(warn.mock.calls.flat().join('\n')).not.toContain('SECRET')
    } finally { warn.mockRestore() }
  })

  it("re-throws the CALLER's abort, so a superseded recap stays superseded", async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }))
    await expect(openRouterComplete({ ...options, signal: controller.signal })).rejects.toThrow('aborted')
  })

  it('re-throws an abort that lands during a body-parse failure as a bare AbortError, never the parse error', async () => {
    // The SyntaxError quotes a window of the body (the model's answer, which can repeat the person's words), and the
    // voice router lets this rejection reach whoever logs routeVoiceTask's failure.
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        controller.abort()
        return JSON.parse('SECRET-TRANSCRIPT fix the login bug')
      },
    }))
    const err = await openRouterComplete({ ...options, signal: controller.signal }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('AbortError')
    expect(`${(err as Error).message}\n${(err as Error).stack}`).not.toContain('SECRET')
  })
})
