import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, importFlight, analyzeFlight, verifyFlightSource } from '../template/studio/log.mjs';
import { planProject, validateProject } from '../template/studio/project.mjs';
import { orchard, recordedCSV, logMapping } from './fixtures.mjs';

test('CSV respects quoting, CRLF, BOM and rejects malformed or duplicate columns', () => {
  assert.deepEqual(parseCSV('\uFEFFname,value\r\n"A, B","line\nnext"\r\n"quote""value",2\r\n').rows,[['A, B','line\nnext'],['quote"value','2']]);
  assert.throws(() => parseCSV('a,a\n1,2\n3,4'),/unique/); assert.throws(() => parseCSV('a,b\n"oops,1'),/unclosed/); assert.throws(() => parseCSV('a,b\n1,2,3\n1,2'),/same columns/);
});
test('explicit units, capture events, missing heading and gaps remain distinct in evidence', async () => {
  const plan = planProject(orchard()), raw = recordedCSV(plan), log = await importFlight(raw,'synthetic.csv',logMapping,plan.project.origin);
  assert.equal(log.raw,raw); assert.match(log.sha256,/^[a-f0-9]{64}$/); assert.ok(Math.abs(log.records[0].altitude-55)<.00001);
  const evidence = analyzeFlight(plan,log); assert.equal(evidence.discontinuities,1); assert.equal(evidence.paths.length,2); assert.equal(evidence.unknownCaptureSamples,1); assert.equal(evidence.unmodeledCaptures,1);
  assert.ok(evidence.coverage > 0 && evidence.coverage < plan.coverage); assert.ok(evidence.measuredDistance > 100); assert.ok(evidence.startBattery > evidence.endBattery);
  assert.doesNotThrow(() => validateProject({...plan.project,log}));
});
test('missing coordinates break the track; absent event/heading data never becomes observed coverage', async () => {
  const plan = planProject(orchard()), raw = 't,lat,lon\n0,38.466,-122.802\n1,,\n2,38.4661,-122.8019\n3,38.4662,-122.8018';
  const log = await importFlight(raw,'gaps.csv',{time:'t',timeUnit:'seconds',latitude:'lat',longitude:'lon'},plan.project.origin), evidence=analyzeFlight(plan,log);
  assert.equal(evidence.missingCoordinates,1); assert.equal(evidence.discontinuities,1); assert.equal(evidence.captureEvents,0); assert.equal(evidence.coverage,null); assert.equal(evidence.unknownCaptureSamples,3);
});
test('time interpretation and datum conversion are explicit, repeated or ambiguous time is rejected', async () => {
  const p = orchard(), raw='t,lat,lon,alt\n2026-08-12T10:00:00+02:00,38.466,-122.802,123\n2026-08-12T10:00:05+02:00,38.4661,-122.8019,125';
  const mapping={time:'t',timeUnit:'iso',latitude:'lat',longitude:'lon',altitude:'alt',altitudeUnit:'meters',altitudeReference:'amsl',homeElevation:100};
  const log=await importFlight(raw,'utc.csv',mapping,p.origin); assert.equal(log.startTime,'2026-08-12T08:00:00.000Z'); assert.equal(log.records[1].time,5); assert.equal(log.records[1].altitude,25);
  await assert.rejects(() => importFlight(raw.replaceAll('+02:00',''),'ambiguous.csv',mapping,p.origin),/timezone/);
  await assert.rejects(() => importFlight(raw.replace('10:00:05','10:00:00'),'repeated.csv',mapping,p.origin),/increasing/);
  await assert.rejects(() => importFlight(raw,'unknown.csv',{...mapping,homeElevation:undefined},p.origin),/takeoff elevation/);
  await assert.rejects(() => importFlight(raw.replaceAll('2026-08-12','2026-02-30'),'invalid-date.csv',mapping,p.origin),/calendar date/);
});
test('retained flight source tolerates browser math rounding but rejects edited evidence',async()=>{
  const p=orchard();p.log=await importFlight(recordedCSV(planProject(p)),'synthetic.csv',logMapping,p.origin);
  p.log.records[0].point[0]+=1e-9;await verifyFlightSource(p);
  p.log.records[0].point[0]+=1;await assert.rejects(()=>verifyFlightSource(p),/Recorded samples differ/);
  p.log=await importFlight(p.log.raw,p.log.name,p.log.mapping,p.origin);p.log.records[0].capture=true;await assert.rejects(()=>verifyFlightSource(p),/Recorded samples differ/);
});
