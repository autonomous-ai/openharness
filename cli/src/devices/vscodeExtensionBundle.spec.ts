/**
 * The VS Code extension as the CLI builds carry it inside cli.js (scripts/lib/vscodeExtensionBundle.mjs): its
 * manifest at the build's version and its one bundled file, which `enable` packs into a .vsix (vscodeExtension.ts).
 */
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { describe, expect, it } from 'vitest'
import { packVsix, type VscodeExtensionFiles } from './vscodeExtension.js'

// @ts-expect-error — plain ESM with no declaration file
const { extensionVersion, readVscodeExtensionBundle } = await import('../../scripts/lib/vscodeExtensionBundle.mjs') as {
  extensionVersion: (version: string) => string
  readVscodeExtensionBundle: (version: string) => Promise<string>
}

/** The names of a zip's entries, in order, from its local headers. */
function zipNames(zip: Buffer): string[] {
  const names: string[] = []
  let at = 0
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const csize = zip.readUInt32LE(at + 18)
    const nlen = zip.readUInt16LE(at + 26)
    names.push(zip.subarray(at + 30, at + 30 + nlen).toString('utf8'))
    at += 30 + nlen + csize
  }
  return names
}

describe('the VS Code extension inside cli.js', () => {
  let bundle: VscodeExtensionFiles | undefined
  const built = async (): Promise<VscodeExtensionFiles> => {
    bundle ??= JSON.parse(await readVscodeExtensionBundle('1.2.3')) as VscodeExtensionFiles
    return bundle
  }

  it('a dev label whose sha is digits with a leading zero gets a letter; any other version is as it was', () => {
    expect(extensionVersion('0.6.60-dev.0123456.dirty')).toBe('0.6.60-dev.g0123456.dirty')
    for (const same of ['0.6.60', '0.6.60-dev.3e5b290ede', '0.6.60-dev.1234567', '0.0.0-dev.box-e2e']) expect(extensionVersion(same)).toBe(same)
  })

  it('the manifest carries the build\'s version and names the file it ships', async () => {
    const manifest = JSON.parse((await built()).manifest) as Record<string, unknown>
    expect(manifest).toMatchObject({ name: 'harness-device', publisher: 'autonomous-ai', version: '1.2.3', main: './extension.js' })
    expect(manifest).not.toHaveProperty('contributes')
  }, 60_000)

  it('a dev build\'s manifest carries its version with the letter', async () => {
    const manifest = JSON.parse(await readVscodeExtensionBundle('0.0.0-dev.0123456')) as VscodeExtensionFiles
    expect((JSON.parse(manifest.manifest) as { version: string }).version).toBe('0.0.0-dev.g0123456')
  }, 60_000)

  it('the bundle is one CommonJS file that requires vscode and Node\'s own modules, and nothing else', async () => {
    const { main } = await built()
    expect(main).toContain('module.exports')
    expect(main).not.toMatch(/^\s*(import|export)\s/m)
    const required = [...main.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!)
    expect(required).toContain('vscode')
    expect(required.filter((name) => name !== 'vscode' && !isBuiltin(name))).toEqual([])
  }, 60_000)

  it('packed, it is the four entries', async () => {
    expect(zipNames(packVsix(await built())))
      .toEqual(['extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json', 'extension/extension.js'])
  }, 60_000)

  it('both builds inline it', () => {
    for (const build of ['build.mjs', 'build-bundle.mjs']) {
      expect(readFileSync(new URL(`../../${build}`, import.meta.url), 'utf8'))
        .toMatch(/__VSCODE_EXTENSION__: JSON\.stringify\(await readVscodeExtensionBundle\(version\)\)/)
    }
  })
})
