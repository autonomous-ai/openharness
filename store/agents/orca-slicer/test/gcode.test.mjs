import {test} from 'node:test';import assert from 'node:assert/strict';import {parseGcode} from '../skills/orcaslicer/scripts/gcode.mjs';
test('absolute/relative modes, compact words, extrusion resets and speeds',()=>{const p=parseGcode('G21\nG90\nM82\nG0 X10 Y10 Z.2\nG1X20Y10E1F1200\nG92 E0\nM83\nG1 X20 Y20 E.5\nG91\nG1 X-10 E.5\n');assert.equal(p.layers.length,1);assert.equal(p.layers[0].extrusionMm,2);assert.deepEqual(p.layers[0].segments.at(-1).slice(3,6),[10,20,.2]);assert.equal(p.layers[0].segments.at(-1)[6],20);});
test('G92 changes coordinate origin without moving geometry; inches convert to mm',()=>{const p=parseGcode('G20\nG90\nM83\nG0 X1 Y0 Z.01\nG92 X0\nG1 X1 E.1 F60\n');assert.equal(p.layers[0].segments.at(-1)[3],50.8);assert.ok(Math.abs(p.layers[0].segments.at(-1)[6]-25.4)<1e-6);});
test('travel-only heights do not become printed layers; retractions do not extrude',()=>{const p=parseGcode('G90\nM83\nG0 Z.2\nG1 X10 E1\nG0 Z.6\nG0 X20\nG0 Z.2\nG1 X30 E-1\nG0 Z.4\nG1 X40 E1\nG1 X50 E.5\n');assert.deepEqual(p.layers.map(l=>l.z),[.2,.4]);assert.equal(p.layers[0].segments.at(-1)[8],0);assert.match(p.warnings.join(' '),/Travel-only/);});
test('arc, multitool and empty inputs cannot receive a misleading linear preview',()=>{assert.throws(()=>parseGcode('G2 X3 Y2 E1'),/Curved/);assert.throws(()=>parseGcode('T1\nG1 X10 E1'),/Multiple tools/);assert.throws(()=>parseGcode('G0 X10'),/No linear extrusion/);});

test('unretraction is not deposition; full motion retains Z hops and final parking',()=>{
  const p=parseGcode('G90\nM83\nG0 Z.2\n;TYPE:Outer wall\nG1 X10 E1 F1200\nG1 E-2\nG0 Z.6\nG0 X20\nG0 Z.2\nG1 X21 E1\nG1 X22 E1\nG1 X23 E.5\nG0 Z50\nG0 X0\n');
  assert.equal(p.modelLayers,1);assert.equal(p.modelExtrusionMm,1.5);
  assert.equal(p.motions.find(s=>s[3]===21&&s[5]===.2)[8],0);
  assert.equal(p.motions.find(s=>s[3]===22&&s[5]===.2)[8],0);
  assert.equal(p.motions.at(-1)[5],50);assert.equal(p.motionBounds.max[2],50);
});
test('settings, estimates and actual heater commands are retained for independent requirements',()=>{
  const p=parseGcode('; total layer number: 1\nG90\nM83\nM104 S215\nM140 S60\nM190 S60\nM109 S215\nG0 Z.2\n;TYPE:Outer wall\nG1 X10 E1 F1200\nM104 S0\nM140 S0\n; filament used [mm] = 100.5\n; total filament used [g] = 1.2\n; estimated printing time (normal mode) = 1h 2m 3s\n; CONFIG_BLOCK_START\n; layer_height = 0.2\n; curr_bed_type = High Temp Plate\n; CONFIG_BLOCK_END\n');
  assert.equal(p.stats.timeSeconds,3723);assert.equal(p.stats.filamentMm,100.5);
  assert.equal(p.settings.curr_bed_type,'High Temp Plate');assert.equal(p.configBlocks,1);
  assert.deepEqual(p.thermal,{nozzle:0,bed:0});assert.equal(p.temperatures.filter(t=>t.wait).length,2);
  assert.ok(p.temperatures.at(-1).line>p.lastDepositionLine);
});
test('unsupported coordinate systems, macros, checksum streams and malformed motion fail explicitly',()=>{
  for(const input of ['G53 G1 X10','G54','G92.1','G10','M200 D1.75','G1 Xnan E1','G1 X1 X2 E1','G1 X1 A2 E1','G1 X10 E1*0']){
    assert.throws(()=>parseGcode(input));
  }
  assert.throws(()=>parseGcode('G1 X1 E1\n; CONFIG_BLOCK_START\n; layer_height = .2\n'),/Incomplete/);
  assert.throws(()=>parseGcode('G1 X1 E1\n; CONFIG_BLOCK_START\n; layer_height = .2\n; layer_height = .3\n; CONFIG_BLOCK_END\n'),/duplicate/);
  assert.equal(parseGcode('G1 X1 E1\n; CONFIG_BLOCK_START\n; wipe_tower_x = 15.000\n; wipe_tower_x = 15\n; CONFIG_BLOCK_END\n').settings.wipe_tower_x,'15');
});
