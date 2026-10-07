/**
 * Every slot BackendSocket calls into the core through is bound by the composition root (core/main.ts) — the
 * core boundary's step 14 (docs/design/2026-10-03-harnessd.md). A slot left null answers its requests
 * UNSUPPORTED or does nothing at all, and nothing says so: that is how `onLocalClient` came to be
 * declared and never wired. The bindings stay where start-up puts them (startupOrder.spec.ts pins that
 * order); this proves none is missing, and that a new slot cannot be added without binding it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname)

/** Slots left unbound on purpose, and why. */
const NOT_BOUND_ON_PURPOSE: Record<string, string> = {
  onLocalClient: 'declared and never wired (the design doc\'s "Found while mapping")',
}

/** BackendSocket's public slots: properties that start null, and optional callbacks. */
function socketSlots(): string[] {
  const file = ts.createSourceFile('backendSocket.ts', readFileSync(join(SRC, 'backendSocket.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const slots: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'BackendSocket') {
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue
        if (member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ReadonlyKeyword)) continue
        const startsNull = member.initializer?.kind === ts.SyntaxKind.NullKeyword
        const optionalCallback = !!member.questionToken && !member.initializer && !!member.type && ts.isFunctionTypeNode(member.type)
        if (startsNull || optionalCallback) slots.push(member.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return slots.sort()
}

/** What the composition root assigns on the socket: `backend.<slot> =`. */
function boundInCli(): Set<string> {
  const cli = readFileSync(join(SRC, 'core', 'main.ts'), 'utf8')
  return new Set([...cli.matchAll(/\bbackend\.([A-Za-z]+)\s*=(?!=)/g)].map((match) => match[1]))
}

describe('the socket\'s slots into the core', () => {
  it('are all bound by the composition root, but for the few left unbound on purpose', () => {
    const bound = boundInCli()
    const unbound = socketSlots().filter((slot) => !bound.has(slot))
    expect(unbound).toEqual(Object.keys(NOT_BOUND_ON_PURPOSE).sort())
  })

  it('found by reading the class, so a new slot cannot slip past', () => {
    const slots = socketSlots()
    // Both kinds: one that starts null, and an optional callback with no initializer.
    expect(slots).toContain('onCreateAgent')
    expect(slots).toContain('onOutboundCommander')
    // Dozens, and fewer as requests move into the services that answer them (core/serviceHost.ts).
    expect(slots.length).toBeGreaterThan(30)
    for (const name of Object.keys(NOT_BOUND_ON_PURPOSE)) expect(slots, name).toContain(name)
  })
})
