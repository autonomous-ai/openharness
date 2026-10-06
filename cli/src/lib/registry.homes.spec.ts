import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

let root: string | undefined
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); if (root) rmSync(root, { recursive: true, force: true }) })

it('repairs a child-overwritten parent from an adopted Codex home before the login shell is read', async () => {
  // Found by QA on a quiet machine: restart searched only the default home and discarded this parent binding.
  root = mkdtempSync(join(tmpdir(), 'registry-homes-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.stubEnv('CODEX_HOME', join(root, 'daemon-codex'))
  const moved = join(root, 'moved-codex')
  const sessions = join(moved, 'sessions', '2026', '10', '06')
  mkdirSync(sessions, { recursive: true })
  const parentId = '019f7f1b-195d-70f2-861b-de5d54a3e141'
  const childId = '019f8dae-e5f4-7c11-90d1-600854063b2c'
  const parent = join(sessions, `rollout-${parentId}.jsonl`), child = join(sessions, `rollout-${childId}.jsonl`)
  writeFileSync(parent, JSON.stringify({ type: 'session_meta', payload: { id: parentId, source: 'cli' } }) + '\n')
  writeFileSync(child, JSON.stringify({ type: 'session_meta', payload: { id: childId,
    source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
  } }) + '\n')
  writeFileSync(join(root, 'engine-homes.json'), JSON.stringify({ claude: [], codex: [moved] }))
  writeFileSync(join(root, 'registry.json'), JSON.stringify([{
    launcherId: 'agent', sessionId: parentId, engine: 'codex', transcriptPath: child,
    projectDir: 'project', cwd: root, tmuxPane: '%8', processIdentity: null,
    registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }]), { mode: 0o600 })
  vi.resetModules()
  const { registry } = await import('./registry.js')
  registry.load()
  expect(registry.get(parentId)?.transcriptPath).toBe(parent)
  expect(JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))[0].transcriptPath).toBe(parent)
})
