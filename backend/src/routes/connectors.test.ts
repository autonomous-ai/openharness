import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'crypto'

const mocks = vi.hoisted(() => {
  // An in-memory Redis for the sign-ins in progress: set (with EX), get, del and multi.
  const store = new Map<string, string>()
  const ops = {
    set: (key: string, value: string) => { store.set(key, value); return 'OK' },
    get: (key: string) => store.get(key) ?? null,
    del: (key: string) => (store.delete(key) ? 1 : 0),
  }
  const pub = {
    set: vi.fn(async (key: string, value: string) => ops.set(key, value)),
    get: vi.fn(async (key: string) => ops.get(key)),
    del: vi.fn(async (key: string) => ops.del(key)),
    multi: vi.fn(() => {
      const queued: (() => unknown)[] = []
      const chain = {
        set: (key: string, value: string) => { queued.push(() => ops.set(key, value)); return chain },
        get: (key: string) => { queued.push(() => ops.get(key)); return chain },
        del: (key: string) => { queued.push(() => ops.del(key)); return chain },
        exec: async () => queued.map(run => [null, run()]),
      }
      return chain
    }),
  }
  // The account's kept sign-ins (ConnectorCredential), by userId + connector.
  type Row = { userId: string, connector: string, accessToken: string, refreshToken: string, tokenType: string, scope: string, accountName: string, expiresAt: number, connectedAt: Date }
  const rows = new Map<string, Row>()
  const id = (where: { userId_connector: { userId: string, connector: string } }) => `${where.userId_connector.userId}/${where.userId_connector.connector}`
  const connectorCredential = {
    findMany: vi.fn(async ({ where }: { where: { userId: string } }) => [...rows.values()].filter(row => row.userId === where.userId)),
    findUnique: vi.fn(async ({ where }: { where: { userId_connector: { userId: string, connector: string } } }) => rows.get(id(where)) ?? null),
    upsert: vi.fn(async ({ where, create, update }: { where: { userId_connector: { userId: string, connector: string } }, create: Row, update: Partial<Row> }) => {
      const row = rows.has(id(where)) ? { ...rows.get(id(where))!, ...update } : { ...create, connectedAt: new Date() }
      rows.set(id(where), row as Row); return row
    }),
    deleteMany: vi.fn(async ({ where }: { where: { userId: string, connector: string } }) => {
      const had = rows.delete(`${where.userId}/${where.connector}`); return { count: had ? 1 : 0 }
    }),
  }
  // connector_apps, by code.
  const appRows = new Map<string, Record<string, unknown>>()
  const connectorApp = {
    findMany: vi.fn(async ({ where }: { where: { enabled: boolean } }) => [...appRows.values()].filter(row => row.enabled === where.enabled)),
    upsert: vi.fn(async ({ where, create, update }: { where: { code: string }, create: Record<string, unknown>, update: Record<string, unknown> }) => {
      const row = appRows.has(where.code) ? { ...appRows.get(where.code)!, ...update } : create
      appRows.set(where.code, row); return row
    }),
  }
  return { store, pub, rows, appRows, prisma: { connectorCredential, connectorApp }, auth: vi.fn() }
})
vi.mock('../lib/bus.js', () => ({ pub: mocks.pub }))
vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: mocks.auth }))
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test', CONNECTOR_REDIRECT_URI: 'https://www.autonomous.ai/connector/callback' } }))
/** The apps, in the Grid config-connector-auth.json shape `npm run connectors:import` takes. */
const CONFIG = JSON.stringify({ connectors: {
      github: { auth_type: 'app', label: 'GitHub', client_id: 'gh-client', client_secret: 'gh-secret', auth_url: 'https://github.com/login/oauth/authorize',
        token_url: 'https://github.com/login/oauth/access_token', scopes: ['repo', 'read:user'], userinfo_url: 'https://api.github.com/user', mcp_url: 'https://api.githubcopilot.com/mcp/' },
      gmail: { auth_type: 'app', label: 'Gmail', client_id: 'g-client', client_secret: 'g-secret', auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_url: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], refresh: true, auth_style: 'header',
        auth_params: { access_type: 'offline', prompt: 'consent' }, transport: 'rest',
        rest_entry: { auth: { in: 'header', name: 'Authorization', format: 'Bearer {access_token}' },
          tools: [{ name: 'gmail_identity', request: { method: 'GET', url: 'https://www.googleapis.com/oauth2/v3/userinfo' } }] } },
      notion: { auth_type: 'app', client_id: 'n', auth_url: 'https://mcp.notion.com/authorize', token_url: 'https://mcp.notion.com/token', pkce: true },
      slack: { auth_type: 'app', client_id: 's', client_secret: 's-secret', auth_url: 'https://slack.com/oauth/v2/authorize', token_url: 'https://slack.com/api/oauth.v2.access',
        extra: { token_field: 'authed_user.access_token', mcp_url: 'https://mcp.slack.com/mcp' } },
      linear: { auth_type: 'dcr', mcp_url: 'https://mcp.linear.app/mcp' },
} })
import { connectorRoutes } from './connectors.js'
import { importApps, resetConfig } from '../lib/connectorGateway.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

type Fetched = { url: string, init: RequestInit }

describe('the connector gateway', () => {
  let app: FastifyInstance
  let fetched: Fetched[]
  let answer: (url: string, init: RequestInit) => Response
  const owner = { authorization: 'Bearer owner' }

  beforeEach(async () => {
    vi.clearAllMocks(); mocks.store.clear(); mocks.rows.clear(); mocks.appRows.clear(); resetConfig(); fetched = []
    expect(await importApps(CONFIG)).toEqual(['github', 'gmail', 'notion', 'slack'])
    mocks.auth.mockImplementation(async (token: string) => ({ sub: token === 'stranger' ? 'stranger' : 'owner', email: 'o@example.com', role: 'user', autonomousEnv: 'prod' }))
    answer = (url) => url.includes('/user')
      ? Response.json({ login: 'octo' })
      : Response.json({ access_token: 'gho-1', token_type: 'bearer', scope: 'repo,read:user' })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { fetched.push({ url: String(url), init }); return answer(String(url), init) }))
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth)
    await app.register(connectorRoutes); await app.ready()
  })
  afterEach(async () => { vi.unstubAllGlobals(); await app.close() })

  const post = (url: string, payload: unknown, headers: Record<string, string> = owner) => app.inject({ method: 'POST', url, payload: payload as object, headers })

  it('lists only the services that sign in here, never a secret', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connectors', headers: owner })
    const codes = res.json().data.connectors.map((row: { code: string }) => row.code)
    expect(codes).toEqual(['github', 'gmail', 'notion', 'slack'])
    expect(res.body).not.toContain('secret')
    expect((await app.inject({ method: 'GET', url: '/api/connectors' })).statusCode).toBe(401)
  })

  it('signs in through the service, hands the token over once, to the account that asked', async () => {
    const started = (await post('/api/connectors/start', { connector: 'github' })).json().data
    const consent = new URL(started.authorize_url)
    expect(consent.origin + consent.pathname).toBe('https://github.com/login/oauth/authorize')
    const state = consent.searchParams.get('state')!
    expect(state.startsWith('harness_')).toBe(true)
    expect(consent.searchParams.get('redirect_uri')).toBe('https://www.autonomous.ai/connector/callback')
    expect(consent.searchParams.get('scope')).toBe('repo read:user')
    expect((await post('/api/connectors/poll', { pickup_code: started.pickup_code })).json().data.status).toBe('pending')

    // The Autonomous web callback page, for an anonymous browser: no token in the answer.
    const back = await post('/api/connectors/callback', { code: 'code-1', state }, {})
    expect(back.json().data).toEqual({ connector: 'github' })
    const exchange = fetched.find(call => call.url.includes('access_token'))!
    expect(String(exchange.init.body)).toContain('client_secret=gh-secret')
    expect(String(exchange.init.body)).toContain('redirect_uri=https%3A%2F%2Fwww.autonomous.ai%2Fconnector%2Fcallback')

    expect((await post('/api/connectors/poll', { pickup_code: started.pickup_code }, { authorization: 'Bearer stranger' })).json().data.status).toBe('expired')
    const ready = (await post('/api/connectors/poll', { pickup_code: started.pickup_code })).json().data
    expect(ready).toMatchObject({ status: 'ready', access_token: 'gho-1', account_name: 'octo',
      mcp_entry: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer gho-1' } } })
    expect(JSON.stringify(ready)).not.toContain('gh-secret')
    expect((await post('/api/connectors/poll', { pickup_code: started.pickup_code })).json().data.status).toBe('expired')
    // Nothing of the sign-in is left in Redis; the account's sign-in is kept for renewing.
    expect(mocks.store.size).toBe(0)
    expect(mocks.rows.get('owner/github')).toMatchObject({ accountName: 'octo', accessToken: 'gho-1', tokenType: 'bearer' })
    const listed = (await app.inject({ method: 'GET', url: '/api/connectors', headers: owner })).json().data.connectors
    expect(listed.find((row: { code: string }) => row.code === 'github')).toMatchObject({ status: 'connected', account_name: 'octo' })
    const theirs = (await app.inject({ method: 'GET', url: '/api/connectors', headers: { authorization: 'Bearer stranger' } })).json().data.connectors
    expect(theirs.find((row: { code: string }) => row.code === 'github').status).toBe('not_connected')
  })

  it('takes a callback once, refuses another\'s state, and says when the service said no', async () => {
    const started = (await post('/api/connectors/start', { connector: 'github' })).json().data
    const state = new URL(started.authorize_url).searchParams.get('state')!
    expect((await post('/api/connectors/callback', { code: 'x', state: 'grid_abc' }, {})).statusCode).toBe(400)
    expect((await post('/api/connectors/callback', { error: 'access_denied', state }, {})).statusCode).toBe(200)
    expect((await post('/api/connectors/callback', { code: 'again', state }, {})).statusCode).toBe(410)
    expect((await post('/api/connectors/poll', { pickup_code: started.pickup_code })).json().data)
      .toEqual({ status: 'failed', connector: 'github', error: 'The sign-in was cancelled.' })
  })

  it('sends Google\'s offline consent, PKCE where configured, and client credentials as Basic when asked', async () => {
    const google = new URL((await post('/api/connectors/start', { connector: 'gmail' })).json().data.authorize_url)
    expect(google.searchParams.get('access_type')).toBe('offline')
    expect(google.searchParams.get('code_challenge')).toBeNull()
    const notion = new URL((await post('/api/connectors/start', { connector: 'notion' })).json().data.authorize_url)
    expect(notion.searchParams.get('code_challenge_method')).toBe('S256')
    // Signed in to Gmail: a refresh token Google gave once, kept here.
    const gmail = (await post('/api/connectors/start', { connector: 'gmail' })).json().data
    answer = () => Response.json({ access_token: 'ya29-1', expires_in: 3600, refresh_token: 'refresh-held' })
    await post('/api/connectors/callback', { code: 'c', state: new URL(gmail.authorize_url).searchParams.get('state') }, {})
    answer = () => Response.json({ access_token: 'ya29-2', expires_in: 3600 })
    const renewed = (await post('/api/connectors/refresh', { connector: 'gmail' })).json().data
    expect(renewed).toMatchObject({ access_token: 'ya29-2', refresh_token: 'refresh-held', refresh: true })
    const call = fetched.at(-1)!
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Basic ' + Buffer.from('g-client:g-secret').toString('base64'))
    expect(String(call.init.body)).toContain('refresh_token=refresh-held')
    expect(String(call.init.body)).not.toContain('g-secret')
  })

  it('a revoked refresh token asks for connecting again; disconnect forgets; an unknown service is refused', async () => {
    const gmail = (await post('/api/connectors/start', { connector: 'gmail' })).json().data
    answer = () => Response.json({ access_token: 'ya29-1', expires_in: 3600, refresh_token: 'r' })
    await post('/api/connectors/callback', { code: 'c', state: new URL(gmail.authorize_url).searchParams.get('state') }, {})
    answer = () => Response.json({ error: 'invalid_grant' }, { status: 400 })
    const revoked = await post('/api/connectors/refresh', { connector: 'gmail' })
    expect([revoked.statusCode, revoked.json().error.code]).toEqual([401, 'INVALID_GRANT'])
    expect((await post('/api/connectors/refresh', { connector: 'gmail' }, { authorization: 'Bearer stranger' })).json().error.code).toBe('NOT_CONNECTED')
    expect((await post('/api/connectors/disconnect', { connector: 'gmail' })).json().data).toEqual({ connector: 'gmail', disconnected: true })
    expect(mocks.rows.size).toBe(0)
    expect((await post('/api/connectors/start', { connector: 'linear' })).statusCode).toBe(404)
    expect((await post('/api/connectors/start', { connector: '../x' })).statusCode).toBe(404)
  })

  it('reads token_field and mcp_url from `extra`, where Grid\'s config keeps them (Slack\'s user token)', async () => {
    const started = (await post('/api/connectors/start', { connector: 'slack' })).json().data
    answer = () => Response.json({ ok: true, access_token: 'xoxb-bot', authed_user: { access_token: 'xoxp-user' } })
    await post('/api/connectors/callback', { code: 'c', state: new URL(started.authorize_url).searchParams.get('state') }, {})
    const ready = (await post('/api/connectors/poll', { pickup_code: started.pickup_code })).json().data
    expect(ready).toMatchObject({ access_token: 'xoxp-user', mcp_entry: { url: 'https://mcp.slack.com/mcp', headers: { Authorization: 'Bearer xoxp-user' } } })
    expect(ready).toMatchObject({ transport: 'mcp', rest_entry: null })
  })

  it('hands a REST-only service\'s tools over verbatim, the token not filled in, on poll and refresh (Grid\'s rest_entry)', async () => {
    const tools = { auth: { in: 'header', name: 'Authorization', format: 'Bearer {access_token}' },
      tools: [{ name: 'gmail_identity', request: { method: 'GET', url: 'https://www.googleapis.com/oauth2/v3/userinfo' } }] }
    expect(mocks.appRows.get('gmail')!.extra).toEqual({ rest_entry: tools, transport: 'rest' })
    const listed = (await app.inject({ method: 'GET', url: '/api/connectors', headers: owner })).json().data.connectors
    expect(Object.fromEntries(listed.map((row: { code: string, transport: string }) => [row.code, row.transport]))).toMatchObject({ gmail: 'rest', github: 'mcp', notion: '' })
    const started = (await post('/api/connectors/start', { connector: 'gmail' })).json().data
    answer = () => Response.json({ access_token: 'ya29.a', refresh_token: 'r1', expires_in: 3600 })
    await post('/api/connectors/callback', { code: 'c', state: new URL(started.authorize_url).searchParams.get('state') }, {})
    const ready = (await post('/api/connectors/poll', { pickup_code: started.pickup_code })).json().data
    expect(ready).toMatchObject({ transport: 'rest', rest_entry: tools })
    expect(ready.mcp_entry).toBeUndefined()
    expect(JSON.stringify(ready.rest_entry)).not.toContain('ya29')
    answer = () => Response.json({ access_token: 'ya29.b', expires_in: 3600 })
    const renewed = (await post('/api/connectors/refresh', { connector: 'gmail' })).json().data
    expect(renewed).toMatchObject({ access_token: 'ya29.b', transport: 'rest', rest_entry: tools })
  })

  it('keeps the apps in connector_apps; a disabled one is not served', async () => {
    const github = mocks.appRows.get('github')!
    expect(github).toMatchObject({ clientId: 'gh-client', clientSecret: 'gh-secret', enabled: true })
    expect(mocks.appRows.has('linear')).toBe(false)
    expect(mocks.appRows.get('slack')!.extra).toEqual({ token_field: 'authed_user.access_token', mcp_url: 'https://mcp.slack.com/mcp' })
    mocks.appRows.set('github', { ...github, enabled: false }); resetConfig()
    expect((await post('/api/connectors/start', { connector: 'github' })).statusCode).toBe(404)
  })

  it('stores only hashes of the state and the pickup code', async () => {
    const started = (await post('/api/connectors/start', { connector: 'github' })).json().data
    const state = new URL(started.authorize_url).searchParams.get('state')!
    const keys = [...mocks.store.keys()].join()
    expect(keys).not.toContain(state)
    expect(keys).not.toContain(started.pickup_code)
    expect(keys).toContain(createHash('sha256').update(started.pickup_code).digest('hex'))
  })
})
