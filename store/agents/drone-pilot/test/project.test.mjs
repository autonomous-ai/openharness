import test from 'node:test';
import assert from 'node:assert/strict';
import { planProject, cameraGeometry, validateProject, history, clone } from '../template/studio/project.mjs';
import { segmentWithin, distance, regionArea } from '../template/studio/geo.mjs';
import { orchard, yard, estuary } from './fixtures.mjs';

test('camera dimensions determine footprint, GSD and overlap; no nominal values are invented', () => {
  const p = orchard(), c = cameraGeometry(p);
  assert.equal(c.width,82.5); assert.equal(c.along,55); assert.equal(c.photoSpacing,13.75); assert.ok(Math.abs(c.gsdX - 1.5076754385964912) < 1e-9);
  p.settings.height *= 2; assert.equal(cameraGeometry(p).gsdX,c.gsdX * 2);
});
for (const create of [orchard,yard,estuary]) test(create.name + ': connected return routes, captures and bounded sorties cover the supplied geometry', () => {
  const plan = planProject(create()), s = plan.project.settings;
  assert.ok(plan.photos.length > 30); assert.ok(plan.sorties.length > 1); assert.ok(plan.coverage > .96);
  assert.equal(plan.photos.length,plan.sorties.reduce((n,s) => n + s.photos.length,0));
  assert.ok(Math.abs(regionArea(plan.covered) + regionArea(plan.gaps) - plan.area) < .1);
  for (const sortie of plan.sorties) {
    assert.ok(sortie.seconds <= plan.budgetSeconds + 1e-7); assert.ok(distance(sortie.path[0],plan.project.home) < .001); assert.ok(distance(sortie.path.at(-1),plan.project.home) < .001);
    for (let i = 1; i < sortie.path.length; i++) assert.ok(segmentWithin(plan.region,sortie.path[i-1],sortie.path[i]));
    for (let i = 1; i < sortie.photos.length; i++) assert.ok(sortie.photos[i].time - sortie.photos[i-1].time >= plan.project.camera.minInterval - 1e-7);
    const expected = sortie.distance / s.speed + s.height / s.climbSpeed + s.height / s.descentSpeed + sortie.legs.filter(l => l.kind === 'settle').reduce((n,l) => n+l.seconds,0);
    assert.ok(Math.abs(expected-sortie.seconds) < 1e-7);
  }
});
test('single survey runs can split across batteries without dropping photos', () => {
  const p = orchard(); p.home = [170,180]; p.settings.usableMinutes = 3; p.settings.reservePercent = 10;
  const plan = planProject(p); assert.ok(plan.sorties.length > 6); assert.equal(new Set(plan.photos.map(p => p.id)).size,plan.photos.length);
  assert.ok(plan.runs.some(run => new Set(run.photos.map(p => p.sortie)).size > 1));
});
test('infeasible capture cadence, takeoff, connectivity and time fail explicitly', () => {
  const a = orchard(); a.camera.minInterval = 20; assert.throws(() => planProject(a),/camera cannot capture/);
  const b = orchard(); b.home = [210,120]; assert.throws(() => planProject(b),/takeoff inside/);
  const c = orchard(); c.areas.push({id:'detached',name:'Detached',kind:'boundary',locked:false,ring:[[600,0],[700,0],[700,100],[600,100]]}); assert.throws(() => planProject(c),/disconnected/);
  const d = orchard(); d.settings.usableMinutes=1; assert.throws(() => planProject(d),/time budget/);
});
test('targeted revisions preserve locked geometry and history restores the complete source', () => {
  const p = orchard(), approved = JSON.stringify(p.areas[1]), h = history(p), next = clone(p);
  next.settings.angle=24; next.areas[0].ring[1][0]+=20; h.push(next);
  assert.equal(JSON.stringify(h.value.areas[1]),approved); assert.deepEqual(h.undo(),p); assert.deepEqual(h.redo(),next);
  next.areas[1].id=next.areas[0].id; assert.throws(() => validateProject(next),/unique/);
});
test('geographic export limits reject polar overflow and unsplit antimeridian geometry explicitly',()=>{
  const p=orchard();p.origin=[0,85];assert.throws(()=>validateProject(p),/85/);
  p.origin=[179.999,0];assert.throws(()=>validateProject(p),/180° meridian/);
});
