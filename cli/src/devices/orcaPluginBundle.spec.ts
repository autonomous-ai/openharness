/**
 * Orca's plugin as the CLI builds carry it inside cli.js (scripts/lib/orcaPluginBundle.mjs): its manifest at the
 * build's version and its sources that are not tests, each by its path in the plugin's folder.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureOrcaPluginFolder } from './orcaPluginFolder.js'

// @ts-expect-error — plain ESM with no declaration file
const { readOrcaPluginBundle } = await import('../../scripts/lib/orcaPluginBundle.mjs') as {
  readOrcaPluginBundle: (version: string, root?: string) => string
}

const PLUGIN = new URL('../../../plugins/harness-device-orca/', import.meta.url)

/** Orca 1.4.262's own check of a manifest's version (out/shared/plugins/manifest/plugin-manifest.js, SEMVER_RE). */
const ORCA_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const files = (version: string): Record<string, string> => JSON.parse(readOrcaPluginBundle(version)) as Record<string, string>
const manifest = (version: string): Record<string, unknown> => JSON.parse(files(version)['orca-plugin.json']!) as Record<string, unknown>

const temps: string[] = []
afterEach(() => {
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true })
})
const aTemp = (): string => {
  const temp = mkdtempSync(join(tmpdir(), 'orca-plugin-bundle-'))
  temps.push(temp)
  return temp
}

/** A plugin's folder of its own holding a manifest and [paths], each under src/. */
function aPlugin(paths: string[]): string {
  const root = aTemp()
  writeFileSync(join(root, 'orca-plugin.json'), '{"id":"harness-device","version":"0.0.1"}\n')
  for (const path of paths) {
    mkdirSync(dirname(join(root, 'src', path)), { recursive: true })
    writeFileSync(join(root, 'src', path), 'export {}\n')
  }
  return root
}

describe('Orca\'s plugin inside cli.js', () => {
  it('carries the manifest and each source that is not a test, and nothing else', () => {
    const src = fileURLToPath(new URL('src/', PLUGIN))
    const sources = readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      .map((entry) => ['src', ...relative(src, join(entry.parentPath, entry.name)).split(sep)].join('/'))
    const keys = Object.keys(files('1.2.3'))
    expect(keys.sort()).toEqual(['orca-plugin.json', ...sources].sort())
    for (const key of keys) {
      expect(key).not.toMatch(/\.test\.tsx?$/)
      expect(key).not.toMatch(/(^|\/)(tsconfig\.json|README\.md)$/)
      expect(key.startsWith('.orca/')).toBe(false)
    }
    const shipped = manifest('1.2.3') as { main: string, contributes: { panels: { entry: string }[] } }
    expect(keys).toContain(shipped.main)
    for (const panel of shipped.contributes.panels) expect(keys).toContain(panel.entry)
  })

  it('carries only the sources that are .ts or .tsx and not tests', () => {
    const root = aPlugin(['worker.ts', 'panel.tsx', 'views/list.ts', 'worker.test.ts', 'panel.test.tsx', 'NOTES.md', 'data.json', '.DS_Store'])
    expect(Object.keys(JSON.parse(readOrcaPluginBundle('1.2.3', root)) as object).sort())
      .toEqual(['orca-plugin.json', 'src/panel.tsx', 'src/views/list.ts', 'src/worker.ts'])
  })

  it('a name the plugin\'s folder would not take fails the build', () => {
    for (const name of ['my worker.ts', 'wörker.ts', 'a+b.ts', 'panel (copy)/view.ts']) {
      expect(ensureOrcaPluginFolder(join(aTemp(), 'orca-plugin'), { [`src/${name}`]: '' }), name).toEqual({ failed: 'EINVAL' })
      const root = aPlugin([name])
      expect(() => readOrcaPluginBundle('1.2.3', root), name).toThrow(/takes/)
    }
    expect(Object.keys(JSON.parse(readOrcaPluginBundle('1.2.3', aPlugin(['a-b_c.d.ts']))) as object)).toContain('src/a-b_c.d.ts')
  })

  it('the plugin\'s folder takes every key the build carries', () => {
    expect(ensureOrcaPluginFolder(join(aTemp(), 'orca-plugin'), files('1.2.3'))).toBe('written')
  })

  it('each source is the file\'s own text', () => {
    for (const [key, text] of Object.entries(files('1.2.3'))) {
      if (key !== 'orca-plugin.json') expect(text).toBe(readFileSync(new URL(key, PLUGIN), 'utf8'))
    }
  })

  it('the manifest carries the build\'s version and is otherwise the file\'s', () => {
    const own = JSON.parse(readFileSync(new URL('orca-plugin.json', PLUGIN), 'utf8')) as Record<string, unknown>
    expect(manifest('1.2.3')).toEqual({ ...own, version: '1.2.3' })
    expect(manifest('1.2.3')).toMatchObject({ id: 'harness-device', engines: { orca: '>=1.4.248' } })
    expect(files('1.2.3')['orca-plugin.json']).toBe(`${JSON.stringify({ ...own, version: '1.2.3' }, null, 2)}\n`)
    expect(manifest('0.0.0-dev.0123456').version).toBe('0.0.0-dev.g0123456')
  })

  it('Orca\'s version pattern takes every label a build makes', () => {
    for (const version of ['0.6.66', '0.6.66-dev.3e5b290ede', '0.6.66-dev.0123456.dirty', '0.0.0-dev.box-e2e']) {
      expect(manifest(version).version).toMatch(ORCA_SEMVER)
    }
  })

  it('a build run from another folder is the same bytes', () => {
    const script = `const { readOrcaPluginBundle } = await import(${JSON.stringify(new URL('../../scripts/lib/orcaPluginBundle.mjs', import.meta.url).href)})
process.stdout.write(readOrcaPluginBundle('1.2.3'))`
    const elsewhere = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: tmpdir(), encoding: 'utf8' })
    expect(elsewhere).toBe(readOrcaPluginBundle('1.2.3'))
  })

  it('both builds inline it', () => {
    for (const build of ['build.mjs', 'build-bundle.mjs']) {
      expect(readFileSync(new URL(`../../${build}`, import.meta.url), 'utf8'))
        .toMatch(/__ORCA_PLUGIN__: JSON\.stringify\(readOrcaPluginBundle\(version\)\)/)
    }
  })
})
