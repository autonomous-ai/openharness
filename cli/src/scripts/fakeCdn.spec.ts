import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
// @ts-expect-error: plain ESM with no declaration file
const cdn = await import('../../scripts/windows-cli-e2e/fake-cdn.mjs') as {
  objectFor: (host: string, url: string) => { object?: string; bad?: boolean } | null
  route: (host: string, url: string, has: (object: string) => boolean) => { action: string; object?: string }
  stagingLayout: (args: { version: string; ptyVersion: string; nodeVersion: string; prefix?: string }) => Record<string, any>
  layoutLines: (layout: object) => string[]
  stagePtyManifest: (dryRun: object, prefix: string, platforms?: string[]) => Record<string, any>
  createHandler: (args: { root: string; scheme?: string; forward?: (req: http.IncomingMessage, res: http.ServerResponse, to: { host: string }) => void; log?: (line: string) => void }) => Handler
  onlyTo: (server: http.Server, bind: string) => http.Server
  forwardTo: (req: { method: string }, res: object, to: { scheme: string; host: string; say: (line: string) => void }) => void
}

const dirs: string[] = []
const servers: http.Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const sha = 'b'.repeat(64)
const CDN = 'cdn.autonomous.ai'
const STORAGE = 'storage.googleapis.com'

describe('which bucket object a request to the fake CDN names', () => {
  it('reads the CDN at the bucket root and the storage host under /<bucket>/', () => {
    expect(cdn.objectFor(CDN, '/harness/staging/cli/install.ps1?x=1')).toEqual({ object: 'harness/staging/cli/install.ps1' })
    expect(cdn.objectFor(`${STORAGE}:443`, '/s3-autonomous-upgrade-3/harness/staging/cli/metadata.json')).toEqual({ object: 'harness/staging/cli/metadata.json' })
    expect(cdn.objectFor(STORAGE, '/other-bucket/harness/staging/cli/metadata.json')).toBeNull()
    expect(cdn.objectFor('example.com', '/harness/staging/cli/install.ps1')).toBeNull()
  })

  it('refuses a path that could leave the root or step out of harness/staging/', () => {
    for (const url of ['/harness/staging/../cli/metadata.json', '/harness/staging/%2e%2e/x', '/harness/staging/a%5Cb', '/%E0%A4%A', '/harness/./staging/x']) {
      expect(cdn.objectFor(CDN, url)).toEqual({ bad: true })
    }
  })
})

describe('the fake CDN routes', () => {
  const has = (objects: string[]) => (object: string) => objects.includes(object)

  it('serves what was staged, and never forwards a staging path it does not have', () => {
    expect(cdn.route(CDN, '/harness/staging/cli/install.ps1', has(['harness/staging/cli/install.ps1']))).toEqual({ action: 'local', object: 'harness/staging/cli/install.ps1' })
    expect(cdn.route(CDN, '/harness/staging/pty/metadata.json', has([]))).toEqual({ action: 'missing', object: 'harness/staging/pty/metadata.json' })
    expect(cdn.route(STORAGE, '/s3-autonomous-upgrade-3/harness/staging', has([]))).toEqual({ action: 'missing', object: 'harness/staging' })
  })

  it('serves Node from its official path when staged, and forwards everything else to the real host', () => {
    const node = 'harness/runtime/node/v22.23.2/node-v22.23.2-win-arm64.zip'
    expect(cdn.route(STORAGE, `/s3-autonomous-upgrade-3/${node}`, has([node]))).toEqual({ action: 'local', object: node })
    expect(cdn.route(STORAGE, '/s3-autonomous-upgrade-3/harness/cli/metadata.json', has([]))).toEqual({ action: 'forward' })
    expect(cdn.route(STORAGE, '/download/storage/v1/b/x/o/y', has([]))).toEqual({ action: 'forward' })
    expect(cdn.route(CDN, '/harness/stagingx/cli/metadata.json', has([]))).toEqual({ action: 'forward' })
  })
})

describe('the staging layout the stage writes', () => {
  const layout = cdn.stagingLayout({ version: '0.4.18-staging.1', ptyVersion: '0.1.0', nodeVersion: '22.23.2' })

  it('puts the CLI and the pty under harness/staging/<kind>/<version>/, and Node at its official versioned path', () => {
    expect(layout.cli['cli.js']).toEqual({ object: 'harness/staging/cli/0.4.18-staging.1/cli.js', url: 'https://cdn.autonomous.ai/harness/staging/cli/0.4.18-staging.1/cli.js' })
    expect(layout.pty['win32-arm64'].url).toBe('https://cdn.autonomous.ai/harness/staging/pty/0.1.0/harness-pty-0.1.0-win32-arm64.zip')
    expect(layout.node['win32-arm64']).toEqual({
      object: 'harness/runtime/node/v22.23.2/node-v22.23.2-win-arm64.zip',
      url: 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/runtime/node/v22.23.2/node-v22.23.2-win-arm64.zip',
    })
    expect(layout.manifests).toEqual({ cli: 'harness/staging/cli/metadata.json', pty: 'harness/staging/pty/metadata.json', runtime: 'harness/staging/runtime/metadata.json' })
    expect(layout.installScript.url).toBe('https://cdn.autonomous.ai/harness/staging/cli/install.ps1')
  })

  it('has install.ps1 read the manifests where upload-install-ps1.sh points the staging copy', () => {
    const printed = spawnSync('bash', [join(process.cwd(), 'scripts', 'upload-install-ps1.sh'), '--print'], { encoding: 'utf8', env: { ...process.env, STAGING_PREFIX: 'harness/staging' } })
    expect(printed.status).toBe(0)
    expect(printed.stdout.split('\n')).toContain(`$HarnessManifestBase = '${layout.manifestBase}'`)
  })

  it('hands the shell one name=value line per path', () => {
    const lines = cdn.layoutLines(layout)
    expect(lines).toContain('cli_cli_js_object=harness/staging/cli/0.4.18-staging.1/cli.js')
    expect(lines).toContain('pty_win32_arm64_object=harness/staging/pty/0.1.0/harness-pty-0.1.0-win32-arm64.zip')
    expect(lines).toContain('node_win32_x64_object=harness/runtime/node/v22.23.2/node-v22.23.2-win-x64.zip')
    expect(lines).toContain('installScript_object=harness/staging/cli/install.ps1')
    expect(lines.every((line) => /^[A-Za-z0-9_]+=\S+$/.test(line))).toBe(true)
  })

  it('moves the dry run pty entries to their staging address, bytes unchanged, and keeps only the platforms staged', () => {
    const dryRun = { pty: {
      'win32-x64': { version: '0.1.0', url: 'https://cdn.autonomous.ai/harness/pty/0.1.0/harness-pty-0.1.0-win32-x64.zip', sha256: sha, size: 10 },
      'win32-arm64': { version: '0.1.0', url: 'https://cdn.autonomous.ai/harness/pty/0.1.0/harness-pty-0.1.0-win32-arm64.zip', sha256: sha, size: 11 },
    } }
    expect(cdn.stagePtyManifest(dryRun, 'harness/staging', ['win32-arm64'])).toEqual({ pty: {
      'win32-arm64': { version: '0.1.0', url: 'https://cdn.autonomous.ai/harness/staging/pty/0.1.0/harness-pty-0.1.0-win32-arm64.zip', sha256: sha, size: 11 },
    } })
    expect(Object.keys(cdn.stagePtyManifest(dryRun, 'harness/staging').pty)).toEqual(['win32-x64', 'win32-arm64'])
    expect(() => cdn.stagePtyManifest({ pty: {} }, 'harness/staging', ['win32-arm64'])).toThrow(/no pty win32-arm64/)
  })
})

describe('the fake CDN server', () => {
  async function start(handler: Handler, bind?: string) {
    const server = http.createServer(handler)
    if (bind) cdn.onlyTo(server, bind)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as AddressInfo).port
  }
  const get = (port: number, host: string, path: string, method = 'GET') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
  function rootWith(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'fake-cdn-'))
    dirs.push(root)
    for (const [object, text] of Object.entries(files)) {
      mkdirSync(join(root, ...object.split('/').slice(0, -1)), { recursive: true })
      writeFileSync(join(root, ...object.split('/')), text)
    }
    return root
  }

  it('answers from the root, 404s an unstaged staging path, and forwards only what is not staging', async () => {
    const root = rootWith({ 'harness/staging/cli/install.ps1': "$HarnessManifestBase = 'x'\n" })
    const forwarded: string[] = []
    const handler = cdn.createHandler({
      root, log: () => {},
      forward: (req, res, to) => { forwarded.push(`${to.host}${req.url}`); res.writeHead(299).end('real') },
    })
    const port = await start(handler)
    expect(await get(port, CDN, '/harness/staging/cli/install.ps1')).toEqual({ status: 200, body: "$HarnessManifestBase = 'x'\n" })
    expect(await get(port, CDN, '/harness/staging/cli/install.ps1', 'HEAD')).toEqual({ status: 200, body: '' })
    expect((await get(port, STORAGE, '/s3-autonomous-upgrade-3/harness/staging/cli/metadata.json')).status).toBe(404)
    expect((await get(port, CDN, '/harness/staging/../../etc/passwd')).status).toBe(400)
    expect(await get(port, STORAGE, '/s3-autonomous-upgrade-3/harness/cli/metadata.json')).toEqual({ status: 299, body: 'real' })
    expect(forwarded).toEqual([`${STORAGE}/s3-autonomous-upgrade-3/harness/cli/metadata.json`])
  })

  function forwardingTo(forwarded: string[]) {
    return (req: http.IncomingMessage, res: http.ServerResponse, to: { host: string }) => { forwarded.push(`${req.method} ${to.host}${req.url}`); res.writeHead(299).end('real') }
  }

  it('refuses every method but GET and HEAD with 405 before routing, so nothing can write to the real bucket', async () => {
    const root = rootWith({ 'harness/staging/cli/install.ps1': 'x' })
    const forwarded: string[] = []
    const port = await start(cdn.createHandler({ root, log: () => {}, forward: forwardingTo(forwarded) }))
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS']) {
      expect((await get(port, STORAGE, '/s3-autonomous-upgrade-3/harness/cli/metadata.json', method)).status).toBe(405)
      expect((await get(port, STORAGE, '/upload/storage/v1/b/s3-autonomous-upgrade-3/o?name=harness/cli/metadata.json', method)).status).toBe(405)
      expect((await get(port, CDN, '/harness/staging/cli/install.ps1', method)).status).toBe(405)
    }
    expect(forwarded).toEqual([])
    expect(() => cdn.forwardTo({ method: 'PUT' }, {}, { scheme: 'https', host: STORAGE, say: () => {} })).toThrow(/refusing to forward PUT/)
  })

  it('answers 421 for any Host but the two it stands in for, and forwards none of them', async () => {
    const root = rootWith({ 'harness/staging/cli/install.ps1': 'x' })
    const forwarded: string[] = []
    const port = await start(cdn.createHandler({ root, log: () => {}, forward: forwardingTo(forwarded) }))
    for (const host of ['192.168.65.1', '192.168.65.1:443', 'localhost', '127.0.0.1', 'example.com', 'cdn.autonomous.ai.example.com', '']) {
      expect((await get(port, host, '/harness/staging/cli/install.ps1')).status).toBe(421)
      expect((await get(port, host, '/s3-autonomous-upgrade-3/harness/cli/metadata.json')).status).toBe(421)
    }
    expect(forwarded).toEqual([])
    expect((await get(port, 'CDN.Autonomous.AI:443', '/harness/staging/cli/install.ps1')).status).toBe(200)
    expect(await get(port, `${STORAGE}:443`, '/s3-autonomous-upgrade-3/harness/cli/metadata.json')).toEqual({ status: 299, body: 'real' })
    expect(forwarded).toEqual([`GET ${STORAGE}/s3-autonomous-upgrade-3/harness/cli/metadata.json`])
    expect(() => cdn.forwardTo({ method: 'GET' }, {}, { scheme: 'https', host: 'example.com', say: () => {} })).toThrow(/refusing to forward GET example.com/)
  })

  it('drops a connection made to any address but the one it serves', async () => {
    const handler: Handler = (_req, res) => res.end('ok')
    const refused = await start(handler, '127.0.0.2')
    await expect(get(refused, CDN, '/')).rejects.toThrow()
    const served = await start(handler, '127.0.0.1')
    expect(await get(served, CDN, '/')).toEqual({ status: 200, body: 'ok' })
  })
})
