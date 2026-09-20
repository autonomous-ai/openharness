import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { operations, readRecord, recordOperation, validateRecord, verdictFor, writeRecord } from '../lib/fleet.mjs';

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'machines-test-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a record keeps unknown keys and bounds the known ones', () => {
  const record = validateRecord({
    nicknames: { abc: 'x'.repeat(200) },
    groups: { studio: ['a', 'b', 7] },
    preferences: { watchForNewMachinesSeconds: 999_999, confirmBeforeRemoving: false },
    somethingElse: { kept: true },
  });
  assert.equal(record.nicknames.abc.length, 40);
  assert.deepEqual(record.groups.studio, ['a', 'b']);
  assert.equal(record.preferences.watchForNewMachinesSeconds, 3600);
  assert.equal(record.preferences.confirmBeforeRemoving, false);
  assert.deepEqual(record.somethingElse, { kept: true });
});

test('a record round-trips through the workspace', async () => {
  const dir = await workspace();
  await writeRecord(dir, { nicknames: { a: 'studio' }, notes: {}, groups: {} });
  const read = await readRecord(dir);
  assert.equal(read.nicknames.a, 'studio');
  assert.equal(read.preferences.confirmBeforeRemoving, true, 'defaults fill in');
});

test('operations are kept newest first and never keep more than the log holds', async () => {
  const dir = await workspace();
  for (let index = 0; index < 45; index += 1) await recordOperation(dir, { kind: 'rename', detail: `rename ${index}` });
  const log = await operations(dir);
  assert.equal(log.length, 40);
  assert.equal(log[0].detail, 'rename 44');
});

test('a failed operation is recorded as failed, and carries no secret', async () => {
  const dir = await workspace();
  await recordOperation(dir, { kind: 'link', machine: 'Rack', ok: false, detail: 'Link refused: that password was not accepted' });
  const [entry] = await operations(dir);
  assert.equal(entry.ok, false);
  const raw = await readFile(join(dir, '.harness', 'operations.json'), 'utf8');
  assert.ok(!raw.includes('password was not accepted\n'), 'the detail is a sentence, not a transcript');
  assert.equal(Object.keys(entry).sort().join(','), 'at,detail,kind,machine,machineId,ok');
});

test('the verdict counts the fleet and names what needs doing', () => {
  const verdict = verdictFor({
    status: 'live', observedAt: '2026-09-20T10:00:00.000Z',
    summary: { machines: 3, online: 2, harnesses: 12 },
    machines: [
      { id: 'a', name: 'Studio', status: 'online', needsLink: false },
      { id: 'b', name: 'Rack', status: 'online', needsLink: true },
      { id: 'c', name: 'Old laptop', status: 'offline', needsLink: true },
    ],
  });
  assert.equal(verdict.summary, '3 machines · 2 online · 12 harnesses');
  assert.equal(verdict.ready, false);
  assert.equal(verdict.findings.find(f => f.ref === 'b').kind, 'needs_link');
  assert.equal(verdict.findings.find(f => f.ref === 'c').kind, 'offline', 'an offline machine is not a linking job');
});

test('a fleet with nothing to do is ready', () => {
  const verdict = verdictFor({
    status: 'live', summary: { machines: 1, online: 1, harnesses: 4 },
    machines: [{ id: 'a', name: 'Studio', status: 'online', needsLink: false }],
  });
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.findings, []);
});

test('a signed-out computer is an error in the header, not a ready fleet', () => {
  const verdict = verdictFor({ status: 'signed-out', observedAt: '2026-09-20T10:00:00.000Z', machines: [], summary: {} });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.findings[0].kind, 'signed_out');
  assert.equal(verdict.summary, 'No machines on this account yet');
});

test('a workspace that has read nothing yet says so, instead of claiming an empty account', () => {
  const verdict = verdictFor({ status: 'connecting', machines: [], summary: {} });
  assert.equal(verdict.summary, 'Reading your machines…');
  assert.equal(verdict.ready, false);
});
