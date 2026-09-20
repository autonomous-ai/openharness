import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollector, machineName, projectKey, projectsOf } from '../lib/snapshot.mjs';
import { fakeReads, OWNER_MACHINES, RACK_ROSTER, STUDIO_ROSTER } from './fixtures.mjs';

const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32), D = 'd'.repeat(32), E = 'e'.repeat(32);
const collect = (options = {}) => createCollector('/tmp/does-not-matter', {
  read: fakeReads(options), env: {},
})();

test('a machine is named by its nickname, then its name, then its hostname', () => {
  assert.equal(machineName({ machineId: A, name: 'Studio', hostname: 'studio.local' }, {}), 'Studio');
  assert.equal(machineName({ machineId: A, name: 'Studio', hostname: 'studio.local' }, { [A]: 'the loud one' }), 'the loud one');
  assert.equal(machineName({ machineId: A, name: null, hostname: 'studio.local' }, {}), 'studio.local');
  assert.equal(machineName({ machineId: A, name: null, hostname: null }, {}), `machine ${A.slice(0, 8)}`);
});

test('the same repository on two machines is one project; two folders are not', () => {
  const repo = { name: 'circuit', cwd: '/a', root: '/a', remote: 'github.com/acme/circuit', branch: 'main' };
  assert.equal(projectKey(A, repo), projectKey(B, repo));
  const folder = { name: 'notes', cwd: '/a/notes', root: null, remote: null, branch: null };
  assert.notEqual(projectKey(A, folder), projectKey(B, folder));
});

test('a reading carries every machine, and only the linked ones carry a roster', async () => {
  const snapshot = await collect({ rosters: { [A]: STUDIO_ROSTER, [B]: RACK_ROSTER }, peers: [{ machineId: B, linkedAt: '2026-09-01T00:00:00.000Z' }] });
  assert.equal(snapshot.machines.length, OWNER_MACHINES.length);
  const byId = Object.fromEntries(snapshot.machines.map(machine => [machine.id, machine]));

  assert.equal(byId[A].local, true);
  assert.equal(byId[A].harnessCount, 3);
  assert.equal(byId[A].openCount, 2);
  assert.equal(byId[A].projectCount, 2);

  assert.equal(byId[B].linkState, 'linked');
  assert.equal(byId[B].harnessCount, 1);

  // Never asked, and so never reported as empty: the pane must be able to tell the two apart.
  assert.equal(byId[C].needsLink, true);
  assert.equal(byId[C].harnesses.length, 0);
  // Presence and link state are independent: a machine can be offline AND still need a link, and
  // both are reported, the way the app's own machine menu reports them.
  assert.equal(byId[D].status, 'offline');
  assert.equal(byId[D].needsLink, true);
  assert.equal(byId[D].harnesses.length, 0);
});

test('an unlinked machine does not make the whole reading partial', async () => {
  const snapshot = await collect({ rosters: { [A]: STUDIO_ROSTER } });
  assert.equal(snapshot.status, 'live');
  assert.equal(snapshot.summary.needsLink, 4);
});

test('a machine that was readable and then fails keeps its last roster, marked stale', async () => {
  let answer = { ok: true, harnesses: STUDIO_ROSTER };
  const collector = createCollector('/tmp/does-not-matter', {
    env: {},
    read: { ...fakeReads({}), roster: async () => answer },
  });
  const first = await collector();
  assert.equal(first.machines.find(m => m.id === A).harnessCount, 3);
  answer = { ok: false, error: 'This machine did not answer in time.' };
  const second = await collector();
  const machine = second.machines.find(m => m.id === A);
  assert.equal(machine.harnessCount, 3, 'the last known roster stays');
  assert.equal(machine.stale, true);
  assert.equal(machine.error, 'This machine did not answer in time.');
  assert.equal(second.status, 'partial');
});

test('a shared machine is never dialled', async () => {
  const dialled = [];
  const reads = fakeReads({ shares: [{ machineId: E, ownerName: 'A teammate' }] });
  const snapshot = await createCollector('/tmp/x', { env: {}, read: { ...reads, roster: async id => { dialled.push(id); return reads.roster(id); } } })();
  assert.ok(!dialled.includes(E));
  const shared = snapshot.machines.find(m => m.id === E);
  assert.equal(shared.shared, true);
  assert.equal(shared.ownerName, 'A teammate');
});

test('projects gather across machines, busiest first, with their branches', async () => {
  const snapshot = await collect({ rosters: { [A]: STUDIO_ROSTER, [B]: RACK_ROSTER }, peers: [{ machineId: B, linkedAt: null }] });
  const circuit = snapshot.projects.find(project => project.name === 'circuit');
  assert.equal(circuit.harnesses, 3);
  assert.equal(circuit.open, 2);
  assert.deepEqual(circuit.machines.sort(), [A, B].sort());
  assert.deepEqual(circuit.branches.sort(), ['gpu', 'main']);
  assert.equal(snapshot.projects[0].name, 'circuit', 'the busiest project leads');
});

test('the newest harness is read from creation time, never from the registry’s reconcile stamp', () => {
  const projects = projectsOf([{ id: A, harnesses: [
    { open: true, createdAt: '2026-09-18T09:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z', project: { key: 'repo:x', name: 'x', branch: 'main', repo: 'x' } },
    { open: false, createdAt: '2026-09-19T09:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z', project: { key: 'repo:x', name: 'x', branch: 'main', repo: 'x' } },
  ] }]);
  assert.equal(projects[0].newestAt, '2026-09-19T09:00:00.000Z');
});

test('a signed-out computer is said so, with no machines invented', async () => {
  const snapshot = await createCollector('/tmp/x', {
    env: {},
    read: { ...fakeReads({}), machines: async () => ({ ok: false, signedOut: true, error: 'Not signed in to Harness on this computer. Run `harness login`.', machines: [] }) },
  })();
  assert.equal(snapshot.status, 'signed-out');
  assert.deepEqual(snapshot.machines, []);
  assert.match(snapshot.message, /harness login/);
});
