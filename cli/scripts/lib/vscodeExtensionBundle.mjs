import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../../../plugins/harness-device-vscode/', import.meta.url)

/** A build's version as the extension's: a dev label's all-digit part with a leading zero is no semver, so it gets a letter. */
export function extensionVersion(version) {
  return version.replace(/^([^-+]*-)([^+]*)/, (_, head, prerelease) =>
    head + prerelease.split('.').map((part) => /^0\d+$/.test(part) ? `g${part}` : part).join('.'))
}

/** JSON of { manifest, main }: package.json's text with `version` set, and the extension bundled to one CommonJS file. */
export async function readVscodeExtensionBundle(version) {
  const manifest = { ...JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')), version: extensionVersion(version) }
  const built = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('src/extension.ts', ROOT))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // VS Code 1.75, the oldest the manifest allows, runs extensions on Node 16.
    target: 'node16',
    external: ['vscode'],
    write: false,
    logLevel: 'warning',
  })
  return JSON.stringify({ manifest: JSON.stringify(manifest, null, 2), main: built.outputFiles[0].text })
}
