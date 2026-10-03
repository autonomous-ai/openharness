import { describe, expect, it } from 'vitest'
import { PROCESS_ENGINES } from '../engines/types.js'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import { ambiguousAgentProcess, argvTokens, engineProcessMatchScore } from './tmux.js'

const ownership: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

function matches(args: string, executable = 'unidentified-launcher') {
  return Object.fromEntries(PROCESS_ENGINES.flatMap(engine => {
    const score = engineProcessMatchScore({ args, executable }, engine, ownership)
    return score > 0 ? [[engine, score]] : []
  }))
}

describe('process command prefixes', () => {
  it.each([
    'codex resume saved-thread',
    'env -i MODE=local codex resume saved-thread',
    'env MODE=local ori --model example --log-level debug codex',
    'ori --completions zsh --quiet codex',
    'node --require preload --loader loader --import setup --conditions custom --inspect-port 9229 codex',
    'node -- codex',
    'node --require "some package" "/fixture/path with spaces/codex"',
    "node --require '' '/fixture/path with spaces/codex'",
    'bun --unknown-flag codex',
    'python3.14 -m codex',
  ])('identifies only the executable in %s', args => {
    expect(matches(args)).toEqual({ codex: 3 })
    expect(matches(`${args} ${'claude hermes grok cursor-agent '.repeat(150)}`)).toEqual({ codex: 3 })
  })

  it.each([
    '', '   ', 'env', 'env -i MODE=local', 'ori', 'ori --model',
    'node', 'node --', 'node -m', 'node --require', 'node --import',
    'env "" codex', 'node "" codex', 'ori "" codex', 'python -m "" codex',
    'node --eval "codex"', 'bash -c "claude --resume example"',
    'python3 worker.py "codex and claude"',
  ])('does not invent an engine from an incomplete prefix or source text: %s', args => {
    expect(matches(args)).toEqual({})
  })

  it('keeps the eight-token Cursor boundary, including empty quoted arguments', () => {
    const entrypoint = '/fixture/cursor-agent/versions/123/index.js'
    const inside = `agent ${'"" '.repeat(6)}${entrypoint}`
    const outside = `agent ${'"" '.repeat(7)}${entrypoint}`
    expect(matches(inside, 'agent')).toEqual({ cursor: 3 })
    expect(matches(outside, 'agent')).toEqual({})
    expect(ambiguousAgentProcess({ executable: 'agent', args: inside }, ownership)).toBe(false)
    expect(ambiguousAgentProcess({ executable: 'agent', args: outside }, ownership)).toBe(true)
  })

  it('leaves complete argv parsing available to resume and permission callers', () => {
    const suffix = Array.from({ length: 300 }, (_, i) => `arg${i}`)
    const args = `node --require "path with spaces" '' codex ${suffix.join(' ')} --resume saved-thread`
    const expected = ['node', '--require', 'path with spaces', '', 'codex', ...suffix, '--resume', 'saved-thread']
    expect(argvTokens(args)).toEqual(expected)
    expect(matches('node codex')).toEqual({ codex: 3 })
    expect(argvTokens(args)).toEqual(expected)
  })
})
