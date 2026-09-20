import assert from 'node:assert/strict';
import test from 'node:test';
import { lastJson, linkMachine, resolveMachine, setRemotePassword, watchForNewMachine } from '../lib/ops.mjs';

const MACHINES = [
  { id: 'a'.repeat(32), name: 'Studio', givenName: 'Studio', nickname: null, hostname: 'studio.local' },
  { id: 'b'.repeat(32), name: 'Rack', givenName: 'Rack', nickname: null, hostname: 'rack' },
  { id: 'c'.repeat(32), name: 'iMac Office', givenName: 'iMac Office', nickname: 'the office one', hostname: 'imac-office' },
  { id: 'd'.repeat(32), name: 'iMac Home', givenName: 'iMac Home', nickname: null, hostname: 'imac-home' },
];

test('a machine is found by id, id prefix, name, hostname or nickname', () => {
  assert.equal(resolveMachine(MACHINES, 'a'.repeat(32)).machine.name, 'Studio');
  assert.equal(resolveMachine(MACHINES, 'bbbbbbbb').machine.name, 'Rack');
  assert.equal(resolveMachine(MACHINES, 'rack').machine.name, 'Rack');
  assert.equal(resolveMachine(MACHINES, 'the office one').machine.name, 'iMac Office');
  assert.equal(resolveMachine(MACHINES, 'imac-home').machine.name, 'iMac Home');
});

test('an ambiguous name is refused with its candidates, never guessed', () => {
  const found = resolveMachine(MACHINES, 'iMac');
  assert.equal(found.machine, undefined);
  assert.match(found.error, /matches 2 machines/);
  assert.deepEqual(found.candidates.map(machine => machine.name), ['iMac Office', 'iMac Home']);
});

test('a name nothing matches is refused, and an empty one asks', () => {
  assert.match(resolveMachine(MACHINES, 'nowhere').error, /No machine here matches/);
  assert.match(resolveMachine(MACHINES, '   ').error, /Name a machine/);
});

test('the last JSON line of an NDJSON answer is the result', () => {
  assert.deepEqual(lastJson('progress\n{"ok":false}\n{"ok":true,"machineId":"x"}\n'), { ok: true, machineId: 'x' });
  assert.equal(lastJson('nothing to see'), null);
});

test('linking refuses before it runs anything when the inputs are not a link', async () => {
  assert.equal((await linkMachine('not-an-id', 'hunter2')).error, 'That is not a machine id.');
  assert.match((await linkMachine('a'.repeat(32), '   ')).error, /Enter the remote password/);
  assert.match((await setRemotePassword('short')).error, /at least 8 characters/);
});

test('watching reports the machine that arrives, and gives up when none does', async () => {
  const first = [{ machineId: 'a'.repeat(32) }];
  let calls = 0;
  const list = async () => {
    calls += 1;
    return { ok: true, machines: calls > 1 ? [...first, { machineId: 'z'.repeat(32), name: 'New rig' }] : first };
  };
  const found = await watchForNewMachine({ seconds: 5, pollMs: 5, list });
  assert.equal(found.ok, true);
  assert.equal(found.machines[0].name, 'New rig');

  const nothing = await watchForNewMachine({ seconds: 1, pollMs: 20, list: async () => ({ ok: true, machines: first }) });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.timedOut, true);
});

test('watching says so when the fleet itself cannot be read', async () => {
  const result = await watchForNewMachine({ seconds: 1, pollMs: 5, list: async () => ({ ok: false, error: 'Harness is not running on this computer.' }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /not running/);
});
