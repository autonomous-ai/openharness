import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CompanionIntelligence, type CompanionRuntime } from '../application/intelligence.js'
import { encodeRuntimeProfile } from '../../../cli/src/lib/runtimeProfile.js'
import { MemoryError } from './types.js'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'memory-launch-authorization-')) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })

// These are local executable fixtures, never the installed CLIs or a model endpoint.
it.each(['claude', 'codex'] as const)('%s rechecks account, model and owner after its version probe', async engine => {
  for (const change of ['account', 'model', 'owner', 'unchanged'] as const) {
    const binary = join(directory, `${engine}-${change}`)
    const probing = `${binary}.probing`, release = `${binary}.release`, launched = `${binary}.launched`
    const version = engine === 'claude' ? '2.1.286 (Claude Code)' : 'codex-cli 0.159.0'
    const events = engine === 'claude'
      ? [{ type: 'result', subtype: 'success', result: '{"proposals":[]}' }]
      : [{ type: 'item.completed', item: { type: 'agent_message', text: '{"proposals":[]}' } }, { type: 'turn.completed' }]
    writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  fs.writeFileSync(${JSON.stringify(probing)}, 'ready');
  const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) {
    clearInterval(timer); console.log(${JSON.stringify(version)}); process.exit(0);
  } }, 5);
} else {
  fs.writeFileSync(${JSON.stringify(launched)}, 'started');
  process.stdin.resume();
  process.stdin.on('end', () => { for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event)); });
}
`, { mode: 0o700 })
    vi.stubEnv(engine === 'claude' ? 'CLAUDE_PATH' : 'CODEX_PATH', binary)
    let account = 'original-native-account', owner = 'original-owner'
    let runtime: CompanionRuntime = { agentId: 'collection', sessionId: 'conversation', engine, stopped: false,
      codexHome: join(directory, 'synthetic-account'),
      profile: encodeRuntimeProfile({ sessionId: 'collection', engine, model: 'original-model', effort: 'high' }) }
    const brain = new CompanionIntelligence({ enabled: () => true, current: () => runtime,
      directory, stateFile: join(directory, `${engine}-${change}.json`), accountIdentity: async () => account })
    const contextKey = (await brain.extractionStatus()).contextKey!
    const options = { timeoutMs: 3000, signal: new AbortController().signal, contextKey,
      assertAuthorized: () => { if (owner !== 'original-owner') throw new MemoryError('inference_cancelled') } }
    let earlyResult: unknown
    const pending = brain.extract('synthetic source text', options).catch(error => error).then(result => {
      earlyResult = result
      return result
    })
    let result
    try {
      await vi.waitFor(() => { expect(earlyResult).toBeUndefined(); expect(existsSync(probing)).toBe(true) }, { interval: 5, timeout: 4000 })
      if (change === 'account') account = 'replacement-native-account'
      if (change === 'owner') owner = 'replacement-owner'
      if (change === 'model') runtime = { ...runtime,
        profile: encodeRuntimeProfile({ sessionId: 'collection', engine, model: 'replacement-model', effort: 'high' }) }
    } finally {
      writeFileSync(release, 'continue')
      result = await pending
    }
    expect(existsSync(launched), change).toBe(change === 'unchanged')
    if (change === 'unchanged') expect(result).toBe('{"proposals":[]}')
    else {
      expect(result).toBeInstanceOf(MemoryError)
      expect(result.code).toBe(change === 'owner' ? 'inference_cancelled' : 'inference_context_changed')
    }
  }
}, 15_000)
