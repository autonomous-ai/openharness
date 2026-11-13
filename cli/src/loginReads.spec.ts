/**
 * Harness never reads a Claude or ChatGPT login (anh Dee, 2026-11-07): every agent runs under its own
 * person's login and settings, and quota comes only from the CLIs' own reports (task #4137). So no shipped code names
 * a sign-in: Claude Code's credentials file or Keychain item, the sign-in fields of its config, Codex's `auth.json`, or
 * the vendors' usage endpoints that only a stored token can call.
 *
 * Read from the code itself, every string and every name in every source file the CLI ships (tests aside): a reader
 * added anywhere, in any spelling these markers catch, fails here. When this fails, ask the CLI that owns the login
 * (`claude auth status`, `codex login status`, the status line, `codex app-server`); do not widen the rule.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const CLI = resolve(__dirname, '..')

/** Text in a string that names a sign-in or an endpoint only a sign-in can call. */
const STRING_MARKERS = [
  '.credentials.json',
  'Claude Code-credentials',
  'find-generic-password',
  'claudeAiOauth',
  'oauthAccount',
  'api/oauth/usage',
  'wham/usage',
  'auth.json',
]
/** A field of Claude Code's stored sign-in, read by name. Generic token names are Harness's own sign-in's too. */
const NAME_MARKERS = new Set(['claudeAiOauth', 'oauthAccount'])

/** Grok keeps its own sign-in in GROK_HOME's `auth.json`; it is neither Claude's nor ChatGPT's. */
const isGrok = (text: string, at: number) => /GROK/.test(text.slice(Math.max(0, at - 400), at + 400))

function sources(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', '__fixtures__', 'fixtures', '__snapshots__', 'testing'].includes(entry.name)) walk(path)
        continue
      }
      if (!/\.(ts|mjs)$/.test(entry.name) || /\.(spec|test)\.ts$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue
      found.push(path)
    }
  }
  walk(join(CLI, 'src'))
  walk(join(CLI, 'hook'))
  return found
}

function loginReadsIn(path: string): string[] {
  const text = readFileSync(path, 'utf8')
  // A marker in a string or a name is in the file's text too, so a file without one in its text has none to find: only
  // the few that do are parsed. Parsing all of them took 4.5 s here and passed the 5 s limit on a busy CI runner.
  if (!STRING_MARKERS.some(marker => text.includes(marker)) && ![...NAME_MARKERS].some(name => text.includes(name))) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const where = (node: ts.Node) => `${relative(CLI, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const marker of STRING_MARKERS) {
        if (!node.text.includes(marker)) continue
        if (marker === 'auth.json' && isGrok(text, node.getStart())) continue
        found.push(`${where(node)} '${marker}'`)
      }
    } else if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && NAME_MARKERS.has(node.text)) {
      found.push(`${where(node)} ${node.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('no code path reads a Claude or ChatGPT login (#4137)', () => {
  it('names no credentials file, Keychain item, sign-in field or token-only usage endpoint', () => {
    expect(sources().flatMap(loginReadsIn)).toEqual([])
  })

  it('catches a reader in any of the spellings it looks for', () => {
    const probe = (code: string) => {
      const source = ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, true)
      let hits = 0
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          if (STRING_MARKERS.some(marker => node.text.includes(marker) && !(marker === 'auth.json' && isGrok(code, node.getStart())))) hits++
        } else if (ts.isIdentifier(node) && NAME_MARKERS.has(node.text)) hits++
        ts.forEachChild(node, visit)
      }
      visit(source)
      return hits
    }
    expect(probe("readFile(join(home, '.claude', '.credentials.json'))")).toBe(1)
    expect(probe('execFile(`security`, [`find-generic-password`, `-s`, svc])')).toBe(1)
    expect(probe("const t = JSON.parse(raw).claudeAiOauth.accessToken")).toBe(1)
    expect(probe("readFileSync(join(process.env.CODEX_HOME, 'auth.json'))")).toBe(1)
    expect(probe("copyFile(join(env.GROK_HOME, 'auth.json'), target)")).toBe(0)
    expect(probe("fetch(`https://chatgpt.com/backend-api/wham/usage`)")).toBe(1)
  })
})
