import { describe, expect, it } from 'vitest'
import { launch as claude } from '../claude/launch.js'
import { launch as codex } from '../codex/launch.js'
import { screenArgs, screenEnvironment, screenEnvPrefix, screenPrelude, screenVariables } from './launchScreen.js'

describe('launchScreen', () => {
  it('gives Codex its transcript setting as argv, and nothing else', () => {
    expect(screenArgs(codex)).toEqual(['-c', 'tui.fullscreen_transcript=false'])
    expect(screenPrelude(codex)).toBe('')
    expect(screenEnvPrefix(codex)).toEqual([])
    expect(screenEnvironment(codex, { HOME: '/home/a' })).toEqual({ HOME: '/home/a' })
  })

  it('leaves Claude Code\'s screen to the person\'s own setting', () => {
    expect(claude.screen).toBeUndefined()
    expect(screenArgs(claude)).toEqual([])
    expect(screenPrelude(claude)).toBe('')
    expect(screenEnvPrefix(claude)).toEqual([])
    const inherited = { HOME: '/home/a', CLAUDE_CODE_NO_FLICKER: '1' }
    expect(screenEnvironment(claude, inherited)).toEqual(inherited)
  })

  it('adds nothing for an engine that declares no screen, and never writes a name a shell cannot take', () => {
    expect(screenArgs(undefined)).toEqual([])
    expect(screenPrelude(undefined)).toBe('')
    expect(screenEnvPrefix(undefined)).toEqual([])
    const odd = { screen: { environment: { 'BAD NAME': 'x', GOOD: "it's" }, clearEnvironment: ['ALSO;BAD'] } }
    expect(screenPrelude(odd)).toBe(`export GOOD='it'"'"'s'\n`)
    expect(screenEnvPrefix(odd)).toEqual(['/usr/bin/env', "GOOD=it's"])
  })

  it('gives the same variables as an environment, for a Windows launch with no /usr/bin/env', () => {
    expect(screenVariables({ screen: { environment: { 'BAD NAME': 'x', GOOD: "it's" } } })).toEqual({ GOOD: "it's" })
    expect(screenVariables(codex)).toEqual({})
    expect(screenVariables(undefined)).toEqual({})
  })
})
