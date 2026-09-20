// Opt in with FREECAD_BIN=/path/to/freecadcmd. These checks use real FreeCAD,
// STEP reimports and extracted bundles. A fake CLI cannot satisfy this suite.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp, cp, readFile, writeFile, mkdir, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from '../skills/freecad/scripts/build.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const bin = process.env.FREECAD_BIN;
const options = {skip: !bin && 'Set FREECAD_BIN to run real native acceptance tests', timeout: 900_000};
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n');
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function scratch(prefix) {
  const root = process.env.FREECAD_QA_DIR || tmpdir();
  await mkdir(root, {recursive:true});
  return mkdtemp(join(root, prefix));
}
async function cleanup(path) {
  if (!process.env.FREECAD_QA_DIR) await rm(path, {recursive:true, force:true});
  else console.log('Native QA files retained:', path);
}

test('real kernel detects incorrect holes, interference, containment and dimensions', options, async () => {
  const work = await scratch('freecad-kernel-');
  try {
    const resultFile = join(work, 'result.json');
    const result = spawnSync(bin, ['--user-cfg', join(work, 'user.cfg'), '--system-cfg', join(work, 'system.cfg'), join(here, 'geometry_cases.py')],
      {encoding:'utf8', timeout:300_000, env:{...process.env, FREECAD_TEST_RESULT:resultFile}});
    await writeFile(join(work, 'native.log'), (result.stdout || '') + (result.stderr || ''));
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const report = await json(resultFile);
    assert.equal(report.passed, 6);
    console.log('Real FreeCAD kernel cases:', report);
  } finally { await cleanup(work); }
});

test('new bracket job: measured handoff, broken revision, substantive revision, standalone rebuild', options, async () => {
  const work = await scratch('freecad-bracket-');
  try {
    await cp(join(here, 'fixtures/bench-bracket'), work, {recursive:true});
    // Unselected workspace files must never leak into the downloadable project.
    await writeFile(join(work, 'private-notes.txt'), 'not a source input');
    const first = await build(work, {bin});
    assert.equal(first.parts.length, 1);
    assert.equal(first.checks.length, 17);
    assert.equal(first.requirementsPassed, true);
    assert.equal((await json(join(work, '.harness/verdict.json'))).ready, true);
    for (const [actual, expected] of first.parts[0].boundsMM.map((n, i) => [n, [80, 40, 45][i]])) assert.ok(Math.abs(actual-expected) < .001);
    assert.ok(first.parts[0].meshTriangles > 100);
    const originalZip = await digest(join(work, 'handoff/project.zip'));
    const originalStep = await digest(join(work, 'part.step'));

    const dims = await json(join(work, 'dimensions.json'));
    dims.hole_spacing = 54; // Intentional mistake: the agreed requirement remains 50.
    await save(join(work, 'dimensions.json'), dims);
    await assert.rejects(() => build(work, {bin}), /design requirement\(s\) failed/);
    assert.equal(await digest(join(work, 'handoff/project.zip')), originalZip);
    assert.equal(await digest(join(work, 'part.step')), originalStep);
    const failed = await json(join(work, '.harness/failed-design.json'));
    const failedIds = failed.checks.filter(c => !c.passed).map(c => c.id);
    for (const id of ['back-left-bore', 'back-right-bore', 'base-left-bore', 'base-right-bore']) assert.ok(failedIds.includes(id));
    const verdict = await json(join(work, '.harness/verdict.json'));
    assert.equal(verdict.ready, false);
    assert.equal(verdict.artifact, 'candidate.step');
    await access(join(work, 'candidate.step'));

    // New brief: 60 mm mounting pattern; raise the sensor holes and overall back.
    dims.hole_spacing = 60; dims.height = 52; dims.back_hole_z = 37;
    const design = await json(join(work, 'design.json'));
    design.brief = 'Revised two-face bench bracket: 80 × 40 mm foot, 52 mm overall height, 5 mm material. Use 60 mm mounting-hole centre spacing on both faces; the back holes are 37 mm above the foot. Preserve the sensor envelope and the 10 mm diameter fastener/tool access volumes. This is a fit prototype, not a rated structural mount.';
    design.checks.find(c => c.id === 'overall-envelope').size[2] = 52;
    for (const check of design.checks.filter(c => c.type === 'bore')) {
      check.origin[0] = check.id.includes('left') ? -30 : 30;
      if (check.id.startsWith('back')) check.origin[2] = 37;
      check.reason = check.reason.replace('50 mm', '60 mm');
    }
    for (const check of design.checks.filter(c => c.id.endsWith('-access-envelope'))) {
      check.origin[0] = check.id.includes('left') ? -35 : 25;
      if (check.id.startsWith('back')) check.origin[2] = 32;
    }
    await save(join(work, 'dimensions.json'), dims);
    await save(join(work, 'design.json'), design);
    // A wider pattern can put otherwise correct bores behind a gusset. Checking
    // bores alone is insufficient: protect the declared fastener/tool volumes.
    const macro = await readFile(join(work, 'part.FCMacro'), 'utf8');
    await writeFile(join(work, 'part.FCMacro'), macro.replace('[-width / 2, width / 2 - 3]', '[-width / 2 + 5, width / 2 - 9]'));
    await assert.rejects(() => build(work, {bin}), /design requirement\(s\) failed/);
    const obstructed = await json(join(work, '.harness/failed-design.json'));
    assert.ok(obstructed.checks.some(c => c.id.endsWith('-access') && !c.passed));
    assert.equal(await digest(join(work, 'handoff/project.zip')), originalZip);
    await writeFile(join(work, 'part.FCMacro'), macro);
    const revised = await build(work, {bin});
    assert.equal(revised.requirementsPassed, true);
    assert.ok(Math.abs(revised.parts[0].boundsMM[2]-52) < .001);
    assert.notEqual(revised.sourceRevision, first.sourceRevision);
    assert.equal(await digest(join(revised.previousArtifacts, 'handoff/project.zip')), originalZip);

    const extracted = join(work, 'independent-copy');
    const unzip = spawnSync('python3', ['-m', 'zipfile', '-e', join(work, 'handoff/project.zip'), extracted], {encoding:'utf8'});
    assert.equal(unzip.status, 0, unzip.stderr);
    await assert.rejects(access(join(extracted, 'private-notes.txt')), {code:'ENOENT'});
    await assert.rejects(access(join(extracted, '.harness')), {code:'ENOENT'});
    const standalone = spawnSync(process.execPath, [join(extracted, 'tools/build.mjs')], {
      cwd:extracted, encoding:'utf8', timeout:300_000,
      env:{PATH:process.env.PATH, FREECAD_BIN:resolve(bin)},
    });
    assert.equal(standalone.status, 0, standalone.stderr);
    const reopened = await json(join(extracted, '.harness/geometry.json'));
    assert.equal(reopened.sourceRevision, revised.sourceRevision);
    assert.equal(reopened.requirementsPassed, true);
    assert.ok(Math.abs(reopened.volumeMM3-revised.volumeMM3) < .00001);
    for (const name of ['part.FCStd', 'handoff/parts/bracket.step', 'handoff/parts/bracket.stl', 'handoff/parts/bracket.svg']) await access(join(extracted, name));
    console.log('Bracket: original + wrong spacing + obstructed access + corrected revision + independent ZIP rebuild verified');
  } finally { await cleanup(work); }
});

test('two-part enclosure validates the actual board, component and cable envelopes', options, async () => {
  const work = await scratch('freecad-enclosure-');
  try {
    await cp(join(here, '../template'), work, {recursive:true});
    const report = await build(work, {bin});
    assert.equal(report.requirementsPassed, true);
    assert.equal(report.parts.length, 2);
    assert.equal(report.solids, 2); // Reference volumes must not be exported.
    assert.equal(report.checks.length, 10);
    assert.ok(report.checks.find(c => c.id === 'components-clear-base').measured.minimumDistanceMM >= 1);
    assert.ok(report.checks.find(c => c.id === 'components-clear-lid').measured.minimumDistanceMM >= 1.999);
    for (const part of report.parts) assert.equal(part.stepReimported, true);
  } finally { await cleanup(work); }
});

test('source mutation during native execution cannot publish a mixed revision', options, async () => {
  const work = await scratch('freecad-mutation-');
  try {
    await cp(join(here, 'fixtures/bench-bracket'), work, {recursive:true});
    const macro = await readFile(join(work, 'part.FCMacro'), 'utf8');
    await writeFile(join(work, 'part.FCMacro'), macro + '\nwith open(os.path.join(os.environ["HARNESS_WORKSPACE"], "dimensions.json"), "a") as changed:\n    changed.write("\\n")\n');
    await assert.rejects(() => build(work, {bin}), /fresh geometry receipt/);
    assert.match(await readFile(join(work, '.harness/build.log'), 'utf8'), /Source changed during the build/);
    assert.equal((await json(join(work, '.harness/verdict.json'))).ready, false);
    await assert.rejects(access(join(work, 'handoff/project.zip')), {code:'ENOENT'});
  } finally { await cleanup(work); }
});
