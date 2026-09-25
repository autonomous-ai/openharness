// One grid read per poll: `grid stats --json` carries `grid engines --json` and `grid models --json`
// under `listings`, so a poll reads a remote grid once instead of three times — three overview reads of
// one payload, and three `grid` processes, were what every open viewer cost. A `grid` older than the
// listings is read the old way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, stateDir } from '../lib/fleet.mjs';
import { assemble, createCollector } from '../lib/telemetry.mjs';
import { config, reads, remoteNodes } from './fixtures.mjs';
import { awakeVerbs, fakeGrid, logged, READS, verbOf } from './fakes.mjs';

const temporary = async t => { const dir = await mkdtemp(join(tmpdir(), 'grid-oneread-')); t.after(() => rm(dir, { recursive:true, force:true })); return dir; };
const asleepEnvelope = JSON.stringify({ error:{ code:'grid_asleep', message:'Grid test-grid is asleep: this grid is resting', status:503 } });
const listed = { ...reads.stats.value, listings:{ engines:remoteNodes, models:reads.models.value } };

/** A workspace whose `grid` answers `verbs` (over an awake grid), and the log of every argv it ran. */
async function workspaceWith(t, verbs) {
  const dir = await temporary(t), log = join(dir, 'calls.json');
  const binary = await fakeGrid(dir, 'grid', { verbs:{ ...awakeVerbs, ...verbs } }, log);
  const workspace = join(dir, 'ws');
  await atomicJson(join(workspace, 'grid-fleet.json'), { ...config, machines:[{ ...config.machines[0], gridBinary:binary }] });
  const gridReads = async () => (await logged(log)).map(c => c.argv).filter(argv => READS.includes(verbOf(argv)));
  return { workspace, gridReads };
}

test('a grid that lists its engines and models with its stats is read once per poll', async t => {
  const { workspace, gridReads } = await workspaceWith(t, { stats:{ stdout:listed } });

  const snapshot = await createCollector(workspace)();

  assert.deepEqual(await gridReads(), [['--remote', 'stats', 'test-grid', '--no-wake', '--json']]);
  const threeReads = assemble(config, { ...reads, info:{ ok:true, value:awakeVerbs.info.stdout } }, null, snapshot.observedAt);
  assert.equal(snapshot.status, 'live');
  assert.deepEqual(snapshot.nodes, threeReads.nodes);
  assert.deepEqual(snapshot.models, threeReads.models);
  assert.deepEqual(snapshot.summary, threeReads.summary);
});

test('a grid older than the listings is read the old way, every read still without waking it', async t => {
  const { workspace, gridReads } = await workspaceWith(t, {});

  const snapshot = await createCollector(workspace)();

  assert.equal(snapshot.status, 'live');
  assert.equal(snapshot.summary.enginesOnline, 7);
  const asked = await gridReads();
  assert.deepEqual(asked.map(verbOf), ['stats', 'engines', 'models']);
  for (const argv of asked) assert.ok(argv.includes('--no-wake'), argv.join(' '));
});

test('a member grid is asleep when its one read answers grid_asleep, and nothing else is asked', async t => {
  const { workspace, gridReads } = await workspaceWith(t, {
    info:{ stdout:{ grid:'test-grid', type:'domain-restricted', status:null, grid_url:'https://relay.example' } },
    stats:{ stderr:`${asleepEnvelope}\nGrid test-grid is asleep: this grid is resting\n`, exit:1 },
  });
  await atomicJson(join(stateDir(workspace), 'snapshot.json'), assemble(config, reads, null, '2026-09-24T08:05:00Z'));

  const snapshot = await createCollector(workspace)();

  assert.equal(snapshot.status, 'asleep');
  assert.ok(snapshot.nodes.length > 0 && snapshot.nodes.every(n => n.stale));
  assert.equal(snapshot.sources.stats?.ok, true, 'asleep is an answer, not a failed read');
  assert.deepEqual((await gridReads()).map(verbOf), ['stats']);
});

test('an older grid that falls asleep between two reads is shown asleep, and models is not asked', async t => {
  const { workspace, gridReads } = await workspaceWith(t, {
    engines:{ stderr:`${asleepEnvelope}\nGrid test-grid is asleep: this grid is resting\n`, exit:1 },
  });

  const snapshot = await createCollector(workspace)();

  assert.equal(snapshot.status, 'asleep');
  assert.equal(snapshot.sources.engines?.ok, true);
  assert.deepEqual((await gridReads()).map(verbOf), ['stats', 'engines']);
});

test('a stats read that fails for another reason still draws the engines, as a partial reading', async t => {
  const { workspace, gridReads } = await workspaceWith(t, { stats:{ stderr:'Could not reach grid test-grid: timed out\n', exit:1 } });

  const snapshot = await createCollector(workspace)();

  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.summary.enginesOnline, 7);
  assert.equal(snapshot.sources.stats?.ok, false);
  assert.deepEqual((await gridReads()).map(verbOf), ['stats', 'engines', 'models']);
});
