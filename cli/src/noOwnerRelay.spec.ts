/**
 * No owner subscription relay (anh Dee, 2026-11-07, Swarm v3, task #4137): every agent runs under its own person's login
 * and settings, and nothing spends the machine owner's Claude or ChatGPT subscription for someone else. A Harness Team
 * account's launches are built by the core with what its composition root hands them (core/main.ts), so that is where a
 * relay would come back: no relay launch wired in, no relay provider or token named, and nothing written into an engine's
 * home for one (a relay `auth.json` or a model list fetched through it).
 *
 * Read from the code itself, every string and name in every source file the CLI ships (tests aside).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const CLI = resolve(__dirname, '..')

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

/** The relay's Codex provider and model-list route, and the launch the core took from it. */
const STRING_MARKERS = ['harness_owner', 'model_provider=harness', '/codex/models?client_version']
const NAME_MARKERS = new Set(['ownerRelay', 'teamRelayLaunch', 'realTeamRelayLaunch', 'claudeRelayEnv', 'codexRelayArgs', 'codexRelayEnv', 'prepareCodexHome'])
/** A model list written into a Codex home: the engine's own to write, read by its reader (engines/codex). */
const ENGINE_HOME_WRITE = 'models_cache.json'

function relayIn(path: string): string[] {
  const text = readFileSync(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const where = (node: ts.Node) => `${relative(CLI, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
  const engines = relative(CLI, path).startsWith(`src${sep}engines${sep}`)
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const marker of STRING_MARKERS) if (node.text.includes(marker)) found.push(`${where(node)} '${marker}'`)
      if (!engines && node.text.includes(ENGINE_HOME_WRITE)) found.push(`${where(node)} '${ENGINE_HOME_WRITE}'`)
    } else if (ts.isIdentifier(node) && NAME_MARKERS.has(node.text)) {
      found.push(`${where(node)} ${node.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('no owner subscription relay (#4137)', () => {
  it('wires no relay into a launch, names none of its providers, and writes nothing into an engine home for it', () => {
    expect(sources().flatMap(relayIn)).toEqual([])
  })

  it('the Team account\'s launches are built with no relay: the composition root hands the core none', () => {
    const main = readFileSync(join(CLI, 'src', 'core', 'main.ts'), 'utf8')
    expect(main).not.toMatch(/ownerRelay|team\/relay\.js/)
  })
})
