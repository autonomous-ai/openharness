/** Synthetic browser-review fixture. No bridge, tmux, live inventory or model calls. */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createViewer } from '../viewer.mjs'
import { mergeRows } from '../lib/inventory.mjs'
const workspace = await mkdtemp(join(tmpdir(), 'harness-monitor-preview-'))
process.env.HARNESS_MONITOR_CONFIG = join(workspace, 'policy.jsonc')
process.env.HARNESS_MONITOR_STATE = join(workspace, 'state')
const names = ['Replace Harness menu icon', 'Clarify completed-task form logic', 'Local debug', 'Ship workspace search', 'Review terminal reconnect', 'Add project browser', 'Render report', 'Fix session recovery']
const activities = ['working', 'needsInput', 'done', 'idle', 'working', 'idle', 'failed', 'idle']
const engines = ['codex', 'claude', 'opencode', 'cursor']
const rows = Array.from({ length: Number(process.env.PREVIEW_ROWS || 24) }, (_, i) => mergeRows([{
  id: 'session-' + i, sessionId: 'conversation-' + i, name: names[i % names.length] + (i > 7 ? ' ' + (i + 1) : ''),
  engine: engines[i % engines.length], status: i % 7 === 6 ? 'stopped' : 'active',
  terminal: { available: true }, resumeMode: 'conversation', launch: { state: 'ready' },
  project: { name: i % 2 ? 'openharness' : 'autonomous-harness', cwd: i === 0 ? '/home/demo/code/openharness' : '/home/demo/worktrees/feature-' + i, branch: i % 3 ? 'fix/session-recovery' : 'main' },
  selectedModel: ['gpt-6', 'claude-sonnet-4-6', 'muse-spark-1.3-contributor-free', 'auto'][i % 4],
  createdAt: new Date(Date.now() - 86400000 * 3).toISOString(), updatedAt: new Date(Date.now() - i * 85000).toISOString(),
  tokenUsage: { totalTokens: i % 3 ? 578000 : 3500000, inputTokens: i % 3 ? 420000 : 3200000, outputTokens: i % 3 ? 158000 : 300000, cachedTokens: i % 3 ? 190000 : 2100000, updatedAt: new Date().toISOString() },
  monitor: { activity: activities[i % activities.length], activityKnown: true, cpu: [126, 3, 0, 12, 64, 0][i % 6], rssBytes: (i % 6 + 1) * 460 * 1024 ** 2, pid: 3400 + i, processCount: 2, gpuPercent: i === 0 ? null : i % 2 ? 6 : i % 6 ? 0 : 24, gpuMemoryBytes: i % 2 ? 2400000000 : null, workspaceBytes: (i % 3 + 1) * 1700000000, workspacePath: '/home/demo/project-' + (i % 3), transcriptBytes: 2400000, sessionBytes: (i + 1) * 4000000, sampledAt: new Date().toISOString(), processes: [{ pid: 3400 + i, parent: 1, cpuPercent: [126, 3, 0, 12, 64, 0][i % 6], memoryBytes: (i % 6 + 1) * 460 * 1024 ** 2 - 80000000 }, { pid: 4400 + i, parent: 3400 + i, cpuPercent: 0, memoryBytes: 80000000 }] },
}], { machine: { machineId: i % 2 ? 'office' : 'm2', name: i % 2 ? 'Linux · 4090' : 'MacBook Pro' }, local: false, online: i % 17 !== 16 })[0])
const viewer = createViewer({ workspace, port: Number(process.env.PREVIEW_PORT || 0), intervalMs: 3000,
  collect: async () => ({ rows, shared: [{ id: 'shared-codex', name: 'Shared Codex server', machine: 'MacBook Pro', machineId: 'm2', agentIds: ['session-0', 'session-4'], online: true, cpu: 2, rssBytes: 340000000, gpuPercent: 0 }], problems: [], machines: [] }),
  verbs: { stop: async row => {
    Object.assign(row, { state: 'stopped', live: false, activity: 'stopped', canStop: false, cpu: 0, rssBytes: 0 })
    return { ok: true, action: 'stop', id: row.id, name: row.name }
  }, previewDelete: async row => ({ ok: true, id: row.id, reviewId: 'synthetic-delete', choices: {
    sessionData: { available: true, bytes: row.sessionBytes, paths: ['/home/demo/.codex/sessions/' + row.sessionId + '.jsonl'], sharedStore: row.engine === 'opencode' },
    worktreeData: { available: row.agentId !== 'session-0', bytes: row.agentId === 'session-0' ? null : 3200000000,
      path: row.cwd, mainPath: '/home/demo/code/openharness',
      branch: 'feature/storage', dirty: row.agentId === 'session-1', changes: [' M src/app.ts', '?? draft.txt'],
      reason: row.agentId === 'session-0' ? 'No separate worktree. Main project folder — protected.' : '' },
  } }),
  deleteHarness: async (row, { choices }) => {
    if (choices.sessionData) rows.splice(rows.indexOf(row), 1)
    else Object.assign(row, { state: 'stopped', live: false, activity: 'stopped', canStop: false, workspaceBytes: null })
    return { ok: true, id: row.id, deleted: true, sessionDeleted: choices.sessionData, worktreeDeleted: choices.worktreeData }
  },
  inspectWorkspace: async row => ({ ok: true, id: row.id, workspace: { kind: row.agentId === 'session-0' ? 'main' : 'worktree',
    path: row.cwd, ...(row.agentId === 'session-0' ? {} : { worktreePath: row.cwd }),
    mainPath: '/home/demo/code/openharness', canDelete: row.agentId !== 'session-0',
    reason: row.agentId === 'session-0' ? 'No separate worktree. Main project folder — protected.' : 'Choose Worktree data in Delete to review cleanup.' } }),
  worktreeAction: async (row, options) => options?.reviewId
    ? { ok: true, id: row.id, deleted: true }
    : { ok: true, id: row.id, reviewId: 'synthetic-worktree', worktree: { path: '/home/demo/worktrees/feature', main: '/home/demo/code/openharness', branch: 'feature/storage', bytes: 3200000000, dirty: true, changes: [' M src/app.ts', '?? draft.txt'] } },
  open: async () => ({ ok: false, detail: 'Use the host integration fixture to open.' }) },
})
console.log('Synthetic preview: http://127.0.0.1:' + await viewer.start())
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => viewer.close().then(() => process.exit(0)))
