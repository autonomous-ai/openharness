/** A small fleet with every state that matters: this computer, a linked machine, one still waiting
 *  to be linked, one offline, and one shared read-only. */
export const OWNER_MACHINES = [
  { machineId: 'a'.repeat(32), computerId: 'c1', name: 'Studio', hostname: 'studio.local', status: 'running', agentCount: 2, engine: 'claude', planName: 'Remote', authMode: 'remote', billingStatus: 'not_required', createdAt: '2026-08-01T10:00:00.000Z' },
  { machineId: 'b'.repeat(32), computerId: 'c2', name: 'Rack', hostname: 'rack', status: 'running', agentCount: 0, engine: 'claude', planName: 'Remote', authMode: 'remote', billingStatus: 'not_required', createdAt: '2026-08-02T10:00:00.000Z' },
  { machineId: 'c'.repeat(32), computerId: 'c3', name: null, hostname: 'loft', status: 'running', agentCount: 0, engine: 'claude', planName: null, authMode: 'remote', billingStatus: 'not_required', createdAt: '2026-08-03T10:00:00.000Z' },
  { machineId: 'd'.repeat(32), computerId: 'c4', name: 'Old laptop', hostname: 'old', status: 'offline', agentCount: 0, engine: 'claude', planName: null, authMode: 'remote', billingStatus: 'not_required', createdAt: '2026-08-04T10:00:00.000Z' },
  { machineId: 'e'.repeat(32), computerId: 'c5', name: 'Borrowed', hostname: 'borrowed', status: 'running', agentCount: 1, engine: 'codex', planName: null, authMode: 'remote', billingStatus: 'not_required', createdAt: '2026-08-05T10:00:00.000Z' },
];

const harness = (id, name, engine, project, branch, open, createdAt, extra = {}) => ({
  id, sessionId: `s-${id}`, name, title: `${name} title`, status: open ? 'active' : 'offline', engine,
  createdAt, updatedAt: '2026-09-20T12:00:00.000Z',
  project: project ? { name: project, cwd: `/w/${project}`, root: `/w/${project}`, remote: `github.com/acme/${project}`, branch } : null,
  ...extra,
});

export const STUDIO_ROSTER = [
  harness('h1', 'board fab check', 'claude', 'circuit', 'main', true, '2026-09-18T09:00:00.000Z', { dsh: 'autonomous/autonomous-circuit', dshName: 'Autonomous Circuit' }),
  harness('h2', 'deck', 'claude', 'keynote', 'main', true, '2026-09-19T09:00:00.000Z'),
  harness('h3', 'old thing', 'codex', 'circuit', 'main', false, '2026-09-01T09:00:00.000Z'),
];

export const RACK_ROSTER = [
  harness('h4', 'training run', 'codex', 'circuit', 'gpu', true, '2026-09-19T18:00:00.000Z'),
];

/** The reads a collector makes, answered from memory. */
export function fakeReads({ machines = OWNER_MACHINES, rosters = {}, peers = [], shares = [], totals = null, record = {} } = {}) {
  return {
    machines: async () => ({ ok: true, machines, stale: false }),
    account: async () => ({ ok: true, user: { email: 'someone@example.com', name: 'Someone' } }),
    daemon: async () => ({ ok: true, status: { machineId: 'a'.repeat(32), version: '0.2.0', connected: true, uptimeSec: 60 } }),
    peers: async () => peers,
    shares: async () => ({ ok: true, machines: shares }),
    password: async () => true,
    totals: async () => totals,
    record: async () => ({ nicknames: {}, notes: {}, groups: {}, ...record }),
    roster: async machineId => (rosters[machineId]
      ? { ok: true, harnesses: rosters[machineId] }
      : { ok: false, needsLink: true, error: 'This machine is not linked from this computer yet.' }),
  };
}
