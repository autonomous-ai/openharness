/**
 * The daemon's shape, checked: master, core, services (cli/AGENTS.md). People and their coding agents
 * build features in parallel on it, and a rule nobody checks is a rule the next change breaks quietly.
 * So the boundaries are tests: a service reaches the core only through `core/api.ts`, the core never
 * reaches into a service, the master holds no feature code, and the two files every change used to land
 * in — `runForeground` and the socket's request switch — may not grow back.
 *
 * When this fails, the message says where the code belongs. Move it there; do not widen the rule.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = __dirname

interface Import {
  file: string
  from: string
  typeOnly: boolean
}

/** Every import and re-export in a folder's source (not its tests), and whether it is types only. */
function importsIn(folder: string): Import[] {
  const found: Import[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) continue
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      for (const statement of source.statements) {
        if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          let typeOnly = false
          if (ts.isImportDeclaration(statement)) {
            const clause = statement.importClause
            const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null
            typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every((element) => element.isTypeOnly)))
          } else {
            typeOnly = statement.isTypeOnly
          }
          found.push({ file: relative(SRC, path), from: statement.moduleSpecifier.text, typeOnly })
        }
      }
    }
  }
  walk(join(SRC, folder))
  return found
}

/** The lines `runForeground` spans in cli.ts. */
function runForegroundLines(): number {
  const lines = readFileSync(join(SRC, 'cli.ts'), 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith('async function runForeground('))
  const end = lines.findIndex((line, index) => index > start && line === '}')
  return end - start
}

/**
 * The most each may grow to. Today's size and a little room for wiring. Raising a budget needs a reason
 * a reviewer agrees with; the usual one is wrong, and the code belongs in a module or a service.
 */
const RUN_FOREGROUND_BUDGET = 2_700
const BACKEND_SOCKET_BUDGET = 3_600

/** Exceptions, each with its reason. Keep this short. */
const SERVICE_MAY_IMPORT: Record<string, string> = {
  // The search process builds, in its own process, the core API search runs on; this reader is a pure
  // function of a session row, the same one the core hands search through CoreApi.
  'services/searchProcess.ts → ../core/transcripts/databaseHistory.js': 'the core API search runs on, built in its own process',
  // A pure function of a session row. Move it out of registry.ts when workspaces leaves the core's process.
  'services/workspaces.ts → ../lib/registry.js': 'sessionDisplayTitle, a pure helper',
}

describe('the daemon\'s shape', () => {
  it('a service reaches the core only through core/api.ts: never a core module, the registry, cli.ts or the socket', () => {
    const wrong = importsIn('services').filter(({ file, from, typeOnly }) => {
      if (SERVICE_MAY_IMPORT[`${file} → ${from}`]) return false
      if (/(^|\/)core\//.test(from)) return from !== '../core/api.js'
      if (/(^|\/)(cli|backendSocket|localWsServer)\.js$/.test(from)) return true
      if (/(^|\/)lib\/registry\.js$/.test(from)) return !typeOnly
      return false
    }).map(({ file, from }) => `${file} imports ${from}`)
    expect(wrong, 'A service may use the core only through CoreApi (src/core/api.ts). If CoreApi lacks it, add it there in its own change (src/services/AGENTS.md).').toEqual([])
  })

  it('the core never reaches into a service, cli.ts or the socket, but for types', () => {
    const wrong = importsIn('core').filter(({ from, typeOnly }) =>
      /(^|\/)services\//.test(from) || (/(^|\/)(cli|backendSocket|localWsServer)\.js$/.test(from) && !typeOnly))
      .map(({ file, from }) => `${file} imports ${from}`)
    expect(wrong, 'The core calls services only through CorePorts, and is handed the socket\'s pieces as dependencies (src/core/AGENTS.md).').toEqual([])
  })

  it('the master holds no feature code: Node itself, its own folder, and the log trimmer', () => {
    const wrong = importsIn('harnessd').filter(({ from }) => !from.startsWith('node:') && !from.startsWith('./') && from !== '../lib/log.js')
      .map(({ file, from }) => `${file} imports ${from}`)
    expect(wrong, 'The master is the one process that must not fail: no feature code in it (src/harnessd/AGENTS.md).').toEqual([])
  })

  it('runForeground and the socket\'s request switch do not grow back', () => {
    const runForeground = runForegroundLines()
    const backendSocket = readFileSync(join(SRC, 'backendSocket.ts'), 'utf8').split('\n').length
    expect(runForeground, `runForeground is ${runForeground} lines, over its ${RUN_FOREGROUND_BUDGET}: it wires modules together. Put behaviour in a core module (src/core/) or a service (src/services/).`).toBeLessThanOrEqual(RUN_FOREGROUND_BUDGET)
    expect(backendSocket, `backendSocket.ts is ${backendSocket} lines, over its ${BACKEND_SOCKET_BUDGET}: it is transport. A request's handler is one call into a module or a service.`).toBeLessThanOrEqual(BACKEND_SOCKET_BUDGET)
  })

  it('finds what it checks: imports of every kind, in every folder', () => {
    const services = importsIn('services')
    expect(services.some(({ from, typeOnly }) => from === '../core/api.js' && typeOnly)).toBe(true)
    expect(services.some(({ from, typeOnly }) => from === '../core/api.js' && !typeOnly)).toBe(true)
    expect(importsIn('core').some(({ from, typeOnly }) => /backendSocket\.js$/.test(from) && typeOnly)).toBe(true)
    expect(importsIn('harnessd').some(({ from }) => from.startsWith('node:'))).toBe(true)
    expect(runForegroundLines()).toBeGreaterThan(1_000)
    for (const exception of Object.keys(SERVICE_MAY_IMPORT)) {
      const [file, from] = exception.split(' → ')
      expect(services.some((found) => found.file === file && found.from === from), `${exception} is no longer needed: remove it`).toBe(true)
    }
  })
})
