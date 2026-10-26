import { describe, expect, it, vi } from 'vitest'
import type { Daemon, Where } from '../agentClient/daemon.js'
import { gitCredentialCommand, parseCredentialRequest, requestedRepository } from './gitCredential.js'

const where = (): Where => ({ port: 18500, dataDir: '/fixture/data', machineId: 'machine-1' })
const frames = [{ id: 'harness-1', tmuxPane: '%7', status: 'active', engine: 'codex', name: 'Builder' }]
const token = { token: 'ghs_fixture_token_1', expiresAt: '2026-10-24T13:00:00.000Z', repository: 'acme/app', trailers: ['Co-authored-by: Ada <ada@example.com>', 'Harness-Agent: Atlas'] }

/** A daemon that lists one agent in pane %7 and answers its token request with [answer]. */
function daemon(answer: Record<string, unknown> = { ok: true, value: token }) {
  const requests: Array<[string, Record<string, unknown> | undefined]> = []
  const open = vi.fn(async (at: Where) => {
    expect(at).toMatchObject({ port: 18500, machineId: 'machine-1' })
    return { machineId: at.machineId, close: vi.fn(), request: async (type: string, payload?: Record<string, unknown>) => {
      requests.push([type, payload])
      return type === 'agents_list' ? { agents: frames } : answer
    } } as Daemon
  })
  return { open, requests }
}
async function run(argv: string[], input: string, answer?: Record<string, unknown>, pane = '%7') {
  const fake = daemon(answer)
  const out: string[] = [], err: string[] = []
  const code = await gitCredentialCommand(argv, { where, open: fake.open, pane, input: async () => input, print: t => out.push(t), warn: t => err.push(t) })
  return { code, out: out.join(''), err: err.join('\n'), requests: fake.requests, open: fake.open }
}
const ask = (url: string) => `protocol=https\nhost=${new URL(url).host}\npath=${new URL(url).pathname.slice(1)}\n\n`

describe('git\'s credential request', () => {
  it('reads key=value lines up to the blank line, and a url', () => {
    expect(parseCredentialRequest('protocol=https\nhost=github.com\npath=acme/app.git\n\nignored=1\n'))
      .toEqual({ protocol: 'https', host: 'github.com', path: 'acme/app.git' })
    expect(parseCredentialRequest('url=https://github.com/acme/app.git\r\n')).toMatchObject({ protocol: 'https', host: 'github.com', path: 'acme/app.git' })
    expect(parseCredentialRequest('url=not a url\ncapability[]=authtype\n')).toEqual({ url: 'not a url', 'capability[]': 'authtype' })
  })

  it('names a github.com repository over https only, with its path', () => {
    expect(requestedRepository({ protocol: 'https', host: 'GitHub.com', path: 'Acme/App.git/' })).toBe('acme/app')
    for (const fields of <Array<Record<string, string>>>[{ protocol: 'http', host: 'github.com', path: 'acme/app' }, { protocol: 'https', host: 'gitlab.com', path: 'acme/app' },
      { protocol: 'https', host: 'github.com:8443', path: 'acme/app' }, { protocol: 'https', host: 'github.com' },
      { protocol: 'https', host: 'github.com', path: 'acme/app/extra' }, { protocol: 'https', host: 'github.com', path: 'acme/a b' }]) {
      expect(requestedRepository(fields)).toBeNull()
    }
  })
})

describe('harness git-credential', () => {
  it('answers get for the task\'s repository with the token, as the agent in the calling pane', async () => {
    const result = await run(['get'], ask('https://github.com/acme/app.git'))
    expect(result.code).toBe(0)
    expect(result.out).toBe(`username=x-access-token\npassword=ghs_fixture_token_1\npassword_expiry_utc=${Date.parse(token.expiresAt) / 1000}\n`)
    expect(result.requests).toEqual([['agents_list', {}], ['super_tabs', { action: 'githubToken', harnessId: 'harness-1' }]])
    expect(result.err).toBe('')
  })

  it('warns when the default branch does not require a pull request, and still answers', async () => {
    const result = await run(['get'], ask('https://github.com/acme/app.git'), { ok: true, value: { ...token, defaultBranch: 'main', defaultBranchProtected: false } })
    expect(result.out).toContain('password=ghs_fixture_token_1')
    expect(result.err).toBe('harness: main of acme/app does not require a pull request, so this token could push to it directly. Push to your own branch and open a pull request.')
    const unnamed = await run(['get'], ask('https://github.com/acme/app.git'), { ok: true, value: { ...token, defaultBranchProtected: false } })
    expect(unnamed.err).toContain('harness: the default branch of acme/app does not require a pull request')
    expect((await run(['get'], ask('https://github.com/acme/app.git'), { ok: true, value: { ...token, defaultBranchProtected: true } })).err).toBe('')
  })

  it('gives another host, plain http or no path nothing, without asking the daemon', async () => {
    for (const input of [ask('https://gitlab.example.com/acme/app.git'), 'protocol=http\nhost=github.com\npath=acme/app\n\n', 'protocol=https\nhost=github.com\n\n']) {
      const result = await run(['get'], input)
      expect(result).toMatchObject({ code: 0, out: '', err: '' })
      expect(result.open).not.toHaveBeenCalled()
    }
  })

  it('gives another repository on github.com nothing, and says why', async () => {
    const result = await run(['get'], ask('https://github.com/acme/other.git'))
    expect(result.out).toBe('')
    expect(result.err).toBe('harness: this agent\'s GitHub token is for acme/app, its task\'s repository, not acme/other.')
  })

  it('passes on the server\'s refusal, outside a Swarm agent\'s pane too, and gives nothing', async () => {
    const refused = await run(['get'], ask('https://github.com/acme/app'), { error: 'GITHUB_APP_NOT_INSTALLED',
      detail: 'The Harness GitHub App is not installed on acme/app. Ask an owner of acme to install it: https://github.com/apps/harness/installations/new.' })
    expect(refused.out).toBe('')
    expect(refused.err).toContain('harness: no GitHub token for acme/app: The Harness GitHub App is not installed on acme/app.')
    const outside = await run(['get'], ask('https://github.com/acme/app'), undefined, '%99')
    expect(outside.out).toBe('')
    expect(outside.err).toContain('outside a Swarm agent\'s harness')
    expect(outside.requests).toEqual([['agents_list', {}]])
    const fake = { open: vi.fn(async () => { throw new Error('connect ENOENT') }) }
    const err: string[] = []
    expect(await gitCredentialCommand(['get'], { where, open: fake.open as never, pane: '%7', input: async () => ask('https://github.com/acme/app'),
      print: () => {}, warn: t => err.push(t) })).toBe(0)
    expect(err.join('')).toContain('connect ENOENT')
  })

  it('reads and ignores store and erase', async () => {
    for (const action of ['store', 'erase']) {
      const result = await run([action], `${ask('https://github.com/acme/app')}username=x-access-token\npassword=old\n`)
      expect(result).toMatchObject({ code: 0, out: '', err: '' })
      expect(result.open).not.toHaveBeenCalled()
    }
  })

  it('prints the commit trailers, or nothing when there is no token', async () => {
    expect((await run(['trailers'], '')).out).toBe('Co-authored-by: Ada <ada@example.com>\nHarness-Agent: Atlas\n')
    expect((await run(['trailers'], '', { error: 'NO_ASSIGNMENT' }))).toMatchObject({ code: 0, out: '' })
  })

  it('takes the daemon\'s port and machine from flags, and refuses anything else', async () => {
    const opened: Where[] = []
    await gitCredentialCommand(['--port', '18501', '--machine', 'machine-2', 'trailers'], { where, pane: '%7', print: () => {}, warn: () => {},
      open: (async (at: Where) => { opened.push(at); throw new Error('stop') }) as never })
    expect(opened[0]).toMatchObject({ port: 18501, machineId: 'machine-2', dataDir: '/fixture/data' })
    for (const argv of [[], ['fill'], ['get', 'extra'], ['--port', 'x', 'get'], ['--machine', '../m', 'get']]) {
      const err: string[] = []
      expect(await gitCredentialCommand(argv, { where, print: () => {}, warn: t => err.push(t) })).toBe(2)
      expect(err[0]).toContain('harness git-credential')
    }
  })
})
