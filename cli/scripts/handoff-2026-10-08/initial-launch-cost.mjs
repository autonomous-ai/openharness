// Pass a bundled reconciler module; every probe and row belongs to this process.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'initial-launch-cost-'));
try {
  for (const name of Object.keys(process.env)) if (name.startsWith('HARNESSD_')) delete process.env[name];
  for (const name of ['CLAUDE_PROJECTS_DIR', 'GROK_HOME', 'COPILOT_HOME', 'CURSOR_HOME', 'CURSOR_CONFIG_DIR',
    'CURSOR_DATA_DIR', 'HERMES_HOME', 'PI_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR',
    'COMMANDCODE_HOME', 'AGY_HOME', 'AGY_CONFIG_DIR', 'OPENCODE_DB', 'KILO_DB', 'XDG_CONFIG_HOME',
    'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMUX', 'TMUX_PANE']) delete process.env[name];
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    'ZDOTDIR', 'HARNESS_AUTH_DIR', 'DSH_DIR', 'HARNESS_HOOK_ROUTES_DIR', 'TMUX_TMPDIR']) {
    process.env[name] = join(root, name);
    mkdirSync(process.env[name]);
  }
  const { TerminalAgentReconciler } = await import(pathToFileURL(process.argv[2]).href);
  const runtime = { backend: 'tmux', paneId: '%fixture' };
  const current = { agentId: 'fixture', engine: 'codex', sessionId: '', active: true,
    processIdentity: null, launch: { state: 'starting' }, runtimes: [runtime], cwd: '/fixture/project' };
  const snapshot = { processTableAvailable: true, agents: [], ambiguousPlacements: new Set(),
    targets: [{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime, rootPid: 1, cwd: current.cwd }] } }] };
  const reconciler = new TerminalAgentReconciler({ current: () => [current], backends: [], backendOrder: ['tmux'],
    probe: async () => snapshot, onObserved() {}, onDiscovered() {}, onRemoved() {}, onDormant() {} });
  const count = 10000, cpu = process.cpuUsage(), rss = process.memoryUsage().rss, began = performance.now();
  for (let n = 0; n < count; n++) await reconciler.trigger();
  const elapsedMs = performance.now() - began, used = process.cpuUsage(cpu);
  reconciler.stop();
  console.log(JSON.stringify({ count, elapsedMs, cpuMs: (used.user + used.system) / 1000,
    rssDeltaMiB: (process.memoryUsage().rss - rss) / 1048576 }));
} finally { rmSync(root, { recursive: true, force: true }); }
