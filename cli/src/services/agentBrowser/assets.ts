/**
 * The files the agent browser's image is built from (cli/assets/browser/). The release bundle carries each inside
 * cli.js (a `define` per file in build-bundle.mjs and build.mjs): the installed CLI is cli.js alone, with nothing
 * beside it to read. A dev checkout and the tests read the files themselves (src/services/agentBrowser/ and
 * dist/services/agentBrowser/ are both three levels down).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

declare const __BROWSER_CONTAINERFILE__: string
declare const __BROWSER_ENTRYPOINT__: string
declare const __BROWSER_POLICY__: string
declare const __BROWSER_TOOLS_JSON__: string
declare const __BROWSER_TOOLS__: string
declare const __BROWSER_TOOLS_LIB__: string

/** The Containerfile installs exactly this version; the tool server uses only its public API. */
export const PLAYWRIGHT_CORE_VERSION = '1.58.2'

function asset(bundled: string | undefined, name: string): string {
  return bundled ?? readFileSync(new URL(`../../../assets/browser/${name}`, import.meta.url), 'utf8')
}

/** File name → content, for every file of the image's build context. */
export function browserContextFiles(): Record<string, string> {
  return {
    'Containerfile': asset(typeof __BROWSER_CONTAINERFILE__ === 'string' ? __BROWSER_CONTAINERFILE__ : undefined, 'Containerfile'),
    'entrypoint.sh': asset(typeof __BROWSER_ENTRYPOINT__ === 'string' ? __BROWSER_ENTRYPOINT__ : undefined, 'entrypoint.sh'),
    'policy.json': asset(typeof __BROWSER_POLICY__ === 'string' ? __BROWSER_POLICY__ : undefined, 'policy.json'),
    'browser-tools.json': asset(typeof __BROWSER_TOOLS_JSON__ === 'string' ? __BROWSER_TOOLS_JSON__ : undefined, 'browser-tools.json'),
    'browser-tools.mjs': asset(typeof __BROWSER_TOOLS__ === 'string' ? __BROWSER_TOOLS__ : undefined, 'browser-tools.mjs'),
    'browser-tools-lib.mjs': asset(typeof __BROWSER_TOOLS_LIB__ === 'string' ? __BROWSER_TOOLS_LIB__ : undefined, 'browser-tools-lib.mjs'),
  }
}

/** Names the image these files build: SHA-256 over every name and content, first 12 hex characters. */
export function browserAssetsHash(): string {
  const files = browserContextFiles()
  const hash = createHash('sha256')
  for (const name of Object.keys(files).sort()) hash.update(`${name}\0${files[name]}\0`)
  return hash.digest('hex').slice(0, 12)
}
