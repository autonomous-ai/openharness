import { expect, it } from 'vitest'
import { AGY_HOOK_SETTINGS } from '../engines/agy/contract.js'
import { hooks as claudeHooks } from '../engines/claude/hookContract.js'
import { hooks as codexHooks } from '../engines/codex/hookContract.js'
import { GROK_HOOK_SETTINGS } from '../engines/grok/contract.js'

const { installOutcome } = await import('../../e2e/harness/daemon.js' as string) as { installOutcome: (engine: 'claude' | 'codex') => RegExp }
const said = (template: string) => template.replaceAll('{file}', '/root/home/.grok/hooks.json')

// A daemon under test installs other engines' hooks too, and the wait for Codex's ended on Grok's or Agy's "fix the
// file" line, before Codex's own install had said anything.
it.each(['claude', 'codex'] as const)('ends the wait for %s on no line of another engine\'s install', (engine) => {
  const others = [GROK_HOOK_SETTINGS.messages, AGY_HOOK_SETTINGS.messages, (engine === 'claude' ? codexHooks : claudeHooks).settings.messages]
  for (const line of others.flatMap((messages) => Object.values(messages).flat()).map(said)) {
    expect(installOutcome(engine).test(line), line).toBe(false)
  }
})

it('ends the wait for Codex on its own malformed file', () => {
  expect(installOutcome('codex').test('[hooks] Codex hooks file is invalid JSON; leaving it unchanged: /root/home/.codex/hooks.json')).toBe(true)
})
