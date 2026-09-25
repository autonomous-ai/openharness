import { PROCESS_ENGINES } from '../engines/types.js'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DshManifestSchema, dshSupportedEngines, dshTier, dshVerdictPath, dshViewerName, expandDshValue, parseDshManifest, readDshManifest , isViewerPackage, dshEngine, viewerUse} from './manifest.js'

const STARTER = fileURLToPath(new URL('../../../store/starter', import.meta.url))

describe('parseDshManifest', () => {
  it('accepts the starter fixture, which is also what the JSON Schema accepts', () => {
    const result = parseDshManifest(readFileSync(`${STARTER}/harness.json`, 'utf8'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.id).toBe('autonomous/starter')
    expect(result.manifest.engine).toBe('claude')
    expect(dshTier(result.manifest)).toBe(0)
    expect(dshVerdictPath(result.manifest)).toBe('.harness/verdict.json')
  })

  it('reads it off a directory too', () => {
    expect(readDshManifest(STARTER).ok).toBe(true)
    expect(readDshManifest('/nonexistent/dir').ok).toBe(false)
  })

  const base = { spec: 1, id: 'acme/thing', name: 'Thing', engine: 'codex' }

  it('treats the engine as a default and keeps spec-1 manifests compatible', () => {
    const engines = dshSupportedEngines(DshManifestSchema.parse(base))
    expect(engines[0]).toBe('codex')
    expect(new Set(engines)).toEqual(new Set(PROCESS_ENGINES))
    const legacy = { ...base, agent: { env: { DSH_SUPPORTED_ENGINES: 'claude,codex' }, args: ['--add-dir', '/tmp'] } }
    expect(parseDshManifest(JSON.stringify(legacy)).ok).toBe(true)
    expect(dshSupportedEngines(DshManifestSchema.parse(legacy))).toEqual(engines)
  })

  it('refuses paths that leave the harness', () => {
    for (const bad of ['../outside', '/abs/path', 'a/../../b']) {
      const result = parseDshManifest(JSON.stringify({ ...base, workspace: { template: bad } }))
      expect(result.ok, bad).toBe(false)
    }
    expect(parseDshManifest(JSON.stringify({ ...base, agent: { skills: ['skills', 'more/skills'] } })).ok).toBe(true)
  })

  it('refuses an unknown spec, a bad id, an unknown engine and unknown keys', () => {
    expect(parseDshManifest(JSON.stringify({ ...base, spec: 2 })).ok).toBe(false)
    expect(parseDshManifest(JSON.stringify({ ...base, id: 'NoSlash' })).ok).toBe(false)
    expect(parseDshManifest(JSON.stringify({ ...base, id: 'Acme/Thing' })).ok).toBe(false)
    expect(parseDshManifest(JSON.stringify({ ...base, engine: 'gpt' })).ok).toBe(false)
    expect(parseDshManifest(JSON.stringify({ ...base, extra: true })).ok).toBe(false)
    expect(parseDshManifest('not json').ok).toBe(false)
  })

  it('tiers by what ships', () => {
    const verdictOnly = parseDshManifest(JSON.stringify({ ...base, verdict: '.harness/verdict.json' }))
    const withViewer = parseDshManifest(JSON.stringify({ ...base, viewer: { command: 'x', url: 'http://127.0.0.1:${port}/' } }))
    expect(verdictOnly.ok && dshTier(verdictOnly.manifest)).toBe(1)
    expect(withViewer.ok && dshTier(withViewer.manifest)).toBe(2)
  })

  it('requires env keys to look like environment variables', () => {
    expect(parseDshManifest(JSON.stringify({ ...base, agent: { env: { 'lower-case': 'x' } } })).ok).toBe(false)
    expect(parseDshManifest(JSON.stringify({ ...base, agent: { env: { CIRCUIT_TOOLCHAIN: '${dsh}/toolchain' } } })).ok).toBe(true)
  })
})

describe('dshViewerName: what the viewer pane beside a harness is called', () => {
  const agent = (viewer?: Record<string, unknown>) => DshManifestSchema.parse({
    spec: 1, id: 'autonomous/blender', name: 'Blender', engine: 'claude', ...(viewer ? { viewer } : {}),
  })
  const names: Record<string, string> = { 'autonomous/model-viewer': ' 3D Viewer ' }
  const nameOf = (id: string) => names[id]

  it('is the shared viewer package’s own name', () => {
    expect(dshViewerName(agent({ use: 'autonomous/model-viewer' }), nameOf)).toBe('3D Viewer')
  })

  it('is the harness’s name and Viewer when it ships its own', () => {
    expect(dshViewerName(agent({ command: './viewer.sh', url: 'http://127.0.0.1:${port}/' }), nameOf)).toBe('Blender Viewer')
  })

  it('is null without a viewer, or when the used package’s name is not known here', () => {
    expect(dshViewerName(agent(), nameOf)).toBeNull()
    expect(dshViewerName(agent({ use: 'someone/unknown-viewer' }), nameOf)).toBeNull()
    expect(dshViewerName(agent({ use: 'autonomous/model-viewer' }), () => '   ')).toBeNull()
  })
})

describe('expandDshValue', () => {
  it('expands the three variables and leaves anything else alone', () => {
    const vars = { dsh: '/i/dsh', workspace: '/w', home: '/h' }
    expect(expandDshValue('${dsh}/toolchain:${workspace}/.claude:${home}', vars)).toBe('/i/dsh/toolchain:/w/.claude:/h')
    expect(expandDshValue('$HOME and ${other}', vars)).toBe('$HOME and ${other}')
  })
})

describe('legacy package identities', () => {
  it('accepts the ids a harness went by before, and only well-formed ones', () => {
    const base = { spec: 1, id: 'acme/solid', name: 'Solid', engine: 'codex' }
    expect(DshManifestSchema.safeParse({ ...base, formerly: ['acme/workshop'] }).success).toBe(true)
    expect(DshManifestSchema.safeParse({ ...base, formerly: ['Not An Id'] }).success).toBe(false)
    expect(DshManifestSchema.safeParse({ ...base, formerly: Array(9).fill('acme/x') }).success).toBe(false)
  })

})

describe('spec 1.1: package kinds and viewer.use', () => {
  const base = { spec: 1, id: 'acme/thing', name: 'Thing' }
  it('a viewer package has no engine and ships a viewer; an agent needs an engine', () => {
    const viewer = parseDshManifest(JSON.stringify({ ...base, kind: 'viewer', viewer: { command: 'viewer.sh', url: 'http://127.0.0.1:${port}/' } }))
    expect(viewer.ok).toBe(true)
    if (viewer.ok) {
      expect(isViewerPackage(viewer.manifest)).toBe(true)
      expect(dshEngine(viewer.manifest)).toBeNull()
      expect(dshTier(viewer.manifest)).toBe(2)
    }
    expect(parseDshManifest(JSON.stringify({ ...base, kind: 'viewer' })).ok).toBe(false)
    expect(parseDshManifest(JSON.stringify({ ...base, kind: 'viewer', engine: 'claude', viewer: { command: 'v', url: 'http://127.0.0.1:${port}/' } })).ok).toBe(false)
    expect(parseDshManifest(JSON.stringify(base)).ok).toBe(false)
    const withAgent = parseDshManifest(JSON.stringify({ ...base, kind: 'viewer', agent: { instructions: 'AGENTS.md' }, viewer: { command: 'v', url: 'http://127.0.0.1:${port}/' } }))
    expect(withAgent).toEqual({ ok: false, error: 'harness.json is not a spec-1 manifest: agent: a viewer package has no agent' })
  })

  it('says why a manifest could not be read: the file, the JSON, or the first issues with their paths', () => {
    const missing = readDshManifest('/nonexistent/dir')
    expect(!missing.ok && missing.error).toMatch(/^no harness\.json in \/nonexistent\/dir \(ENOENT: /)
    const notJson = parseDshManifest('{"spec": 1,')
    expect(!notJson.ok && notJson.error).toMatch(/^harness\.json is not JSON: \S/)
    expect(parseDshManifest('[]')).toEqual({ ok: false, error: expect.stringMatching(/^harness\.json is not a spec-1 manifest: \(root\): /) })
  })
  it('an agent may use a viewer package instead of shipping one, and may narrow its url and extensions', () => {
    const used = parseDshManifest(JSON.stringify({ ...base, engine: 'claude', viewer: { use: 'autonomous/cad-viewer', artifactExtensions: ['.step'] } }))
    expect(used.ok).toBe(true)
    if (used.ok) {
      expect(viewerUse(used.manifest)).toBe('autonomous/cad-viewer')
      expect(dshTier(used.manifest)).toBe(2)
    }
    expect(parseDshManifest(JSON.stringify({ ...base, engine: 'claude', viewer: { use: 'not an id' } })).ok).toBe(false)
    expect(parseDshManifest(JSON.stringify({ ...base, engine: 'claude', viewer: { use: 'a/b', command: 'x' } })).ok).toBe(false)
    const own = parseDshManifest(JSON.stringify({ ...base, engine: 'claude', viewer: { command: 'v.sh', url: 'http://127.0.0.1:${port}/' } }))
    expect(own.ok && viewerUse(own.manifest)).toBeNull()
  })
})
