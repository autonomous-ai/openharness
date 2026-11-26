/**
 * Claude Code's marketplace as the CLI builds carry it inside cli.js (scripts/lib/claudePluginBundle.mjs): the
 * repository's marketplace and the files Claude Code installs of its two plugins, each `plugin.json` at the build's
 * version and the hash of its plugin's files.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ensurePluginFolder } from './pluginFolder.js'

// @ts-expect-error — plain ESM with no declaration file
const { readClaudePluginBundle } = await import('../../scripts/lib/claudePluginBundle.mjs') as {
  readClaudePluginBundle: (version: string, root?: string) => string
}

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const MANIFESTS = ['plugins/harness-device/.claude-plugin/plugin.json', 'plugins/harness/.claude-plugin/plugin.json']

type Bundle = { files: Record<string, string>, executable: string[] }
const bundle = (version: string, root?: string): Bundle => JSON.parse(readClaudePluginBundle(version, root)) as Bundle
const manifest = (files: Record<string, string>, key: string): Record<string, unknown> =>
  JSON.parse(files[key]!) as Record<string, unknown>

/** Every file under [folder] of the repository [root], by its posix path from the root. */
const listing = (root: string, folder: string): string[] =>
  readdirSync(join(root, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))

const temps: string[] = []
afterEach(() => {
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true })
})
const aTemp = (): string => {
  const temp = mkdtempSync(join(tmpdir(), 'claude-plugin-bundle-'))
  temps.push(temp)
  return temp
}

/** A repository root of its own: copies of the marketplace and the two plugins' folders. */
function aRoot(): string {
  const root = aTemp()
  for (const path of ['.claude-plugin/marketplace.json', 'plugins/harness-device', 'plugins/harness']) {
    cpSync(join(REPO, path), join(root, path), { recursive: true })
  }
  return root
}

/** [text] written at [path] in [root], its folders made. */
function put(root: string, path: string, text: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

describe('Claude Code\'s marketplace inside cli.js', () => {
  it('carries the marketplace and each plugin\'s files, and nothing else', () => {
    const expected = [
      '.claude-plugin/marketplace.json',
      'plugins/harness-device/.claude-plugin/plugin.json',
      ...listing(REPO, 'plugins/harness-device/hooks'),
      'plugins/harness-device/README.md',
      'plugins/harness/.claude-plugin/plugin.json',
      'plugins/harness/.mcp.json',
      ...listing(REPO, 'plugins/harness/skills'),
      ...listing(REPO, 'plugins/harness/assets'),
      'plugins/harness/README.md',
    ].sort()
    const keys = Object.keys(bundle('1.2.3').files)
    expect(keys).toEqual(expected)
    for (const key of keys) {
      expect(key.startsWith('plugins/harness-device/test/')).toBe(false)
      expect(key).not.toMatch(/\/\.(codex|cursor)-plugin\//)
    }
  })

  it('the marketplace is the repository\'s own', () => {
    const text = bundle('1.2.3').files['.claude-plugin/marketplace.json']!
    expect(text).toBe(readFileSync(join(REPO, '.claude-plugin/marketplace.json'), 'utf8'))
    const marketplace = JSON.parse(text) as { name: string, plugins: object[] }
    expect(marketplace.name).toBe('openharness')
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({ name: 'harness', source: './plugins/harness' }))
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({ name: 'harness-device', source: './plugins/harness-device' }))
  })

  it('each file but a plugin.json is the checkout\'s own text', () => {
    for (const [key, text] of Object.entries(bundle('1.2.3').files)) {
      if (!MANIFESTS.includes(key)) expect(text, key).toBe(readFileSync(join(REPO, key), 'utf8'))
    }
  })

  it('each plugin.json carries the build\'s version and the hash of its own files', () => {
    const { files } = bundle('1.2.3')
    for (const key of MANIFESTS) {
      const own = JSON.parse(readFileSync(join(REPO, key), 'utf8')) as Record<string, unknown>
      const carried = manifest(files, key)
      expect(carried.version, key).toMatch(/^1\.2\.3\+[0-9a-f]{8}$/)
      expect(carried).toEqual({ ...own, version: carried.version })
      expect(files[key]).toBe(`${JSON.stringify(carried, null, 2)}\n`)
    }
    expect(bundle('1.2.3')).toEqual(bundle('1.2.3'))

    const root = aRoot()
    const before = bundle('1.2.3', root).files
    const device = join(root, 'plugins/harness-device/hooks/device.js')
    writeFileSync(device, `${readFileSync(device, 'utf8')} `)
    const after = bundle('1.2.3', root).files
    expect(manifest(after, MANIFESTS[0]!).version).not.toBe(manifest(before, MANIFESTS[0]!).version)
    expect(manifest(after, MANIFESTS[1]!).version).toBe(manifest(before, MANIFESTS[1]!).version)
  })

  it('a dev version is made semver as the extension\'s is', () => {
    const { files } = bundle('0.6.66-dev.0123456')
    for (const key of MANIFESTS) expect(manifest(files, key).version, key).toMatch(/^0\.6\.66-dev\.g0123456\+[0-9a-f]{8}$/)
  })

  it('the harness plugin carries Claude Code\'s .mcp.json, not Cursor\'s mcp.json', () => {
    const { files } = bundle('1.2.3')
    expect(files['plugins/harness/.mcp.json']).toBe(readFileSync(join(REPO, 'plugins/harness/.mcp.json'), 'utf8'))
    expect(Object.keys(files)).not.toContain('plugins/harness/mcp.json')
  })

  it('hooks/asked alone is executable, as in the checkout', () => {
    const { files, executable } = bundle('1.2.3')
    expect(executable).toEqual(['plugins/harness-device/hooks/asked'])
    if (process.platform === 'win32') return
    for (const key of Object.keys(files).filter((key) => key !== '.claude-plugin/marketplace.json')) {
      expect((statSync(join(REPO, key)).mode & 0o100) !== 0, key).toBe(executable.includes(key))
    }
  })

  it('the folder writer takes every key the build carries', () => {
    const { files, executable } = bundle('1.2.3')
    expect(ensurePluginFolder(join(aTemp(), 'claude-marketplace'), files, executable)).toBe('written')
  })

  it('a name the folder would not take, or a file that is not text, fails the build', () => {
    const spaced = aRoot()
    put(spaced, 'plugins/harness-device/hooks/my hook', '#!/bin/sh\n')
    expect(() => readClaudePluginBundle('1.2.3', spaced)).toThrow(/takes/)
    const binary = aRoot()
    put(binary, 'plugins/harness/assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]))
    expect(() => readClaudePluginBundle('1.2.3', binary)).toThrow(/text/)
  })

  it('a build run from another folder is the same bytes', () => {
    const script = `const { readClaudePluginBundle } = await import(${JSON.stringify(new URL('../../scripts/lib/claudePluginBundle.mjs', import.meta.url).href)})
process.stdout.write(readClaudePluginBundle('1.2.3'))`
    const elsewhere = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: tmpdir(), encoding: 'utf8' })
    expect(elsewhere).toBe(readClaudePluginBundle('1.2.3'))
  })

  it('both builds inline it', () => {
    for (const build of ['build.mjs', 'build-bundle.mjs']) {
      expect(readFileSync(new URL(`../../${build}`, import.meta.url), 'utf8'))
        .toMatch(/__CLAUDE_PLUGIN__: JSON\.stringify\(readClaudePluginBundle\(version\)\)/)
    }
  })
})
