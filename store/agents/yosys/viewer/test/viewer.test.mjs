// The pane's readers, without a browser or a toolchain: `npm test` (or node --test viewer/test/*.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extendBits, parseVcd, tickFs, vcdMeta, vcdSignal } from '../lib/vcd.mjs'
import { buildChip, moduleOf, routeSegments, tilesFromText } from '../lib/chip.mjs'
import { cleanModuleName, hierarchy, moduleForRender, moduleIndex, paramsOf, topModule } from '../lib/netlist.mjs'
import { errorLine, fileInfo, findTop, flowState, parsePcf, readText, sources, topPorts } from '../lib/workspace.mjs'
import { formatValue, uartDecode, uartTiming } from '../public/wavecore.js'

// Trimmed from Icarus: two $dumpvars make the testbench scope appear twice, a task scope, a
// parameter, aliases between the testbench and the DUT, left-truncated buses, and $dumpoff.
const VCD = `$date today $end
$version Icarus Verilog $end
$timescale 1ps $end
$scope module tb $end
$var wire 1 ! tx $end
$var reg 1 " clk $end
$var parameter 32 # BIT $end
$upscope $end
$scope module tb $end
$scope module dut $end
$var wire 1 ! tx $end
$var wire 1 " clk $end
$var reg 8 $ data [7:0] $end
$scope task check $end
$var reg 1 % condition $end
$upscope $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
b1101000 #
1!
0"
bx $
$end
#5
1"
b1001000 $
#10
0"
#10
1"
#15
0"
b1 $
#20
$dumpoff
x!
x"
bx $
$end
`

test('timescale and bit extension', () => {
  assert.equal(tickFs('1ps'), 1e3)
  assert.equal(tickFs('10 ns'), 1e7)
  assert.equal(tickFs('nonsense'), 1e3)
  assert.equal(extendBits('1', 4), '0001')
  assert.equal(extendBits('x1', 4), 'xxx1')
  assert.equal(extendBits('z', 3), 'zzz')
  assert.equal(extendBits('0101', 4), '0101')
})

test('scopes merge by path, aliases share a signal, parameters keep their value', () => {
  const p = parseVcd(VCD)
  assert.deepEqual(p.scopes.map((s) => s.path), ['tb'])
  const tb = p.scopes[0]
  assert.deepEqual(tb.vars.map((v) => v.name), ['tx', 'clk', 'BIT'])
  assert.deepEqual(tb.children.map((c) => c.path), ['tb.dut'])
  assert.deepEqual(tb.children[0].children.map((c) => [c.name, c.kind]), [['check', 'task']])
  const dutTx = tb.children[0].vars.find((v) => v.name === 'tx')
  assert.equal(dutTx.id, '!')
  assert.equal(p.vars.find((v) => v.name === 'BIT').value, '00000000000000000000000001101000')
  const data = p.vars.find((v) => v.name === 'data')
  assert.equal(data.width, 8)
  assert.equal(data.msb, 7)
  assert.equal(data.lsb, 0)
  assert.equal(p.end, 20)
  assert.equal(p.timescale, '1ps')
})

test('changes: repeats dropped, same tick collapses, buses extended, $dumpoff is x', () => {
  const p = parseVcd(VCD)
  const clk = p.signals.get('"')
  // 0@0, 1@5, (0 then 1)@10 collapses to "still 1" and is dropped, 0@15, x@20
  assert.deepEqual(clk.times, [0, 5, 15, 20])
  assert.deepEqual(clk.values, ['0', '1', '0', 'x'])
  const data = p.signals.get('$')
  assert.deepEqual(data.values, ['xxxxxxxx', '01001000', '00000001', 'xxxxxxxx'])
  const s = vcdSignal(p, '"')
  assert.deepEqual(s.t, [0, 5, 10, 5])
  assert.equal(s.v, '010x')
  const meta = vcdMeta(p)
  assert.equal(meta.changes['"'], 4)
  assert.equal(meta.scopes[0].vars.find((v) => v.name === 'BIT').value.length, 32)
})

test('radixes', () => {
  assert.equal(formatValue('01001000', 'hex', 8), '48')
  assert.equal(formatValue('01001000', 'ascii', 8), "'H'")
  assert.equal(formatValue('00001010', 'ascii', 8), "'\\n'")
  assert.equal(formatValue('0000000001001000' + '01001001', 'ascii', 24), '"HI"')
  assert.equal(formatValue('11111111', 'sdec', 8), '-1')
  assert.equal(formatValue('11111111', 'dec', 8), '255')
  assert.equal(formatValue('101', 'oct', 3), '5')
  assert.equal(formatValue('0x01', 'hex', 4), 'x')
  assert.equal(formatValue('0000x001', 'hex', 8), '0x')
  assert.equal(formatValue('1'.repeat(64), 'dec', 64), '18446744073709551615')
  assert.equal(formatValue('1', 'hex', 1), '1')
})

/** An idle-high line carrying bytes at `bit` ticks per bit, 8N1, with idle gaps between them. */
function serial(bytes, bit) {
  const t = [0], v = ['1']
  let now = bit * 7
  const put = (level) => {
    if (v[v.length - 1] === level) return
    t.push(now); v.push(level)
  }
  for (const b of bytes) {
    const bits = ['0', ...Array.from({ length: 8 }, (_, k) => ((b >> k) & 1 ? '1' : '0')), '1']
    for (const x of bits) { put(x); now += bit }
    now += bit * 3
  }
  return { t: Float64Array.from(t), v: v.join(''), scalar: true, width: 1 }
}

test('UART: baud from the line, bytes from the frames', () => {
  const bit = 8680555 // ps per bit at 115200 baud; a 1 ps timescale is tickFs 1000
  const d = serial([...'HELLO\n'].map((c) => c.charCodeAt(0)), bit)
  const timing = uartTiming(d, 1000)
  assert.ok(timing)
  assert.equal(timing.baud, 115200)
  const frames = uartDecode(d, timing.bit)
  assert.equal(String.fromCharCode(...frames.map((f) => f.byte)), 'HELLO\n')
  assert.ok(frames.every((f) => !f.err))
})

test('PCF: set_io flags, commented pins, set_frequency', () => {
  const pcf = parsePcf('set_io -nowarn clk 35\nset_frequency clk 12\n#   set_io -nowarn tx 9\nset_io -pullup yes btn_n 10  # the button\n')
  assert.deepEqual(pcf.frequencies, { clk: 12 })
  assert.equal(pcf.ios.length, 3)
  assert.deepEqual(pcf.ios[0], { port: 'clk', pin: '35', line: 1, commented: false, nowarn: true })
  assert.equal(pcf.ios[1].commented, true)
  assert.equal(pcf.ios[2].pullup, 'yes')
  assert.equal(pcf.ios[2].port, 'btn_n')
})

test('floorplan: tiles, modules, routes', () => {
  const grid = tilesFromText('.comment x\n.device 5k\n.io_tile 1 0\n0101\n.logic_tile 1 1\n.ramb_tile 6 1\n.dsp0_tile 0 5\n')
  assert.equal(grid.device, '5k')
  assert.equal(grid.width, 7)
  assert.equal(grid.height, 6)
  assert.equal(grid.rows[0][1], 'I')
  assert.equal(grid.rows[1][1], 'L')
  assert.equal(grid.rows[1][6], 'B')
  assert.equal(grid.rows[5][0], 'D')
  assert.equal(moduleOf('u_uart.left_SB_DFFESS_Q_D_SB_LUT4_O_LC'), 'u_uart')
  assert.equal(moduleOf('a.b.c_LC'), 'a.b')
  assert.equal(moduleOf('send_SB_LUT4_I2_LC'), '')
  assert.equal(moduleOf('$abc$123$auto$blifparse.cc:1'), '')
  // lutff_6 in X9/Y5 drives a span-4 at X9/Y8, which drives a local wire in X9/Y4
  const r = routeSegments('X9/Y5/lutff_6:out;;1;X9/Y8/sp4_v_b_9;X9/Y5/9.5.lutff_6:out.->.9.8.sp4_v_b_9;1;X9/Y4/local_g1_5;X9/Y4/9.8.sp4_v_b_9.->.9.4.local_g1_5;1')
  assert.deepEqual(r, { segs: [9, 5, 9, 4], global: false })
  assert.equal(routeSegments('X12/Y2/lutff_global:clk;X12/Y2/0.1.glb_netwk_4.->.12.2.lutff_global:clk;1').global, true)

  const chip = buildChip({
    asc: '.device 5k\n.logic_tile 9 5\n.io_tile 9 0\n',
    routed: {
      modules: {
        top: {
          settings: { 'arch.type': 'up5k', 'arch.package': 'sg48' },
          cells: {
            'u_uart.cnt_SB_DFF_Q_LC': { type: 'ICESTORM_LC', parameters: { DFF_ENABLE: '1', CARRY_ENABLE: '0', LUT_INIT: '0000000000000010' }, attributes: { NEXTPNR_BEL: 'X9/Y5/lc3' }, port_directions: { O: 'output', I0: 'input' }, connections: { O: [7], I0: [8] } },
            'tx$sb_io': { type: 'SB_IO', parameters: {}, attributes: { NEXTPNR_BEL: 'X9/Y0/io1' }, port_directions: { D_OUT_0: 'input' }, connections: { D_OUT_0: [7] } },
          },
          netnames: { 'u_uart.cnt[0]': { bits: [7], attributes: { ROUTING: 'X9/Y5/lutff_3:out;;1;X9/Y0/io_1:D_OUT_0;X9/Y1/9.5.lutff_3:out.->.9.0.io_1:D_OUT_0;1' } } },
        },
      },
    },
    report: { utilization: { ICESTORM_LC: { used: 1, available: 5280 } }, fmax: {}, critical_paths: [] },
  })
  assert.deepEqual(chip.modules, ['', 'u_uart'])
  assert.equal(chip.cells[0].ff, 1)
  assert.equal(chip.cells[0].lut, 1)
  assert.equal(chip.cells[0].b, 'lc3')
  assert.equal(chip.nets[0].d, 0)
  assert.deepEqual(chip.nets[0].k, [1])
  assert.deepEqual(chip.nets[0].s, [9, 5, 9, 1])
  assert.ok(chip.pins.some((p) => p.pin === '35' && p.x === 12 && p.y === 31))
})

test('netlist: readable module names, hierarchy, a module on its own', () => {
  const nl = {
    modules: {
      '$paramod$abc\\uart_tx': { attributes: {}, parameter_default_values: { BAUD: '00000000000000011100001000000000' }, ports: { tx: { direction: 'output', bits: [2] } }, cells: {}, netnames: { tx: { bits: [2] } } },
      top: {
        attributes: { top: '00000000000000000000000000000001', src: 'rtl/top.v:1.1-9.9' },
        ports: { clk: { direction: 'input', bits: [2] } },
        cells: {
          u_uart: { type: '$paramod$abc\\uart_tx', connections: { tx: [3] }, port_directions: { tx: 'output' }, attributes: { src: 'rtl/top.v:5.1-5.20' } },
          '$reduce_or$x': { type: '$reduce_or', connections: {}, port_directions: {}, attributes: {} },
          '$and$y': { type: '$and', connections: {}, port_directions: {}, attributes: {} },
        },
        netnames: { clk: { bits: [2] }, '$0\\q[0:0]': { hide_name: 1, bits: [3] }, q: { bits: [3] } },
      },
    },
  }
  assert.equal(cleanModuleName('$paramod$abc\\uart_tx'), 'uart_tx')
  assert.equal(cleanModuleName("$paramod\\breathe\\STEP_DIV=s32'01"), 'breathe')
  assert.deepEqual(paramsOf(nl.modules['$paramod$abc\\uart_tx']), { BAUD: '115200' })
  const tree = hierarchy(nl)
  assert.equal(tree.label, 'top')
  assert.deepEqual(tree.children.map((c) => [c.name, c.label, c.path, c.params.BAUD]), [['u_uart', 'uart_tx', 'u_uart', '115200']])
  const one = moduleForRender(nl, 'top', new Set(['$and']))
  assert.deepEqual(Object.keys(one.modules), ['top'])
  assert.equal(one.modules.top.attributes.top, 1)
  assert.equal(one.modules.top.cells.u_uart.type, 'uart_tx u_uart')
  assert.equal(one.modules.top.cells['$reduce_or$x'].type, 'reduce_or')
  assert.equal(one.modules.top.cells['$and$y'].type, '$and')
  const idx = moduleIndex(nl, 'top')
  assert.deepEqual(idx.nets['3'].names, ['q', '$0\\q[0:0]'])
  assert.equal(idx.cells.u_uart.module, '$paramod$abc\\uart_tx')
  assert.equal(idx.ports.clk.direction, 'input')
})

test('flow state: running, done, failed with its error line, skipped once the run is over', () => {
  const ws = mkdtempSync(join(tmpdir(), 'yosys-pane-'))
  try {
    const logs = join(ws, 'out', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(ws, 'out', '.top'), 'blink\n')
    writeFileSync(join(logs, 'run.json'), JSON.stringify({ top: 'blink', pid: process.pid, startedAt: 1, finishedAt: null }))
    writeFileSync(join(logs, 'sim.start'), '1000\n')
    writeFileSync(join(logs, 'sim.time'), '1000 1750\n')
    writeFileSync(join(logs, 'sim.exit'), '0\n')
    writeFileSync(join(logs, 'sim.log'), '  ok   one\nPASS\n')
    writeFileSync(join(logs, 'synth.start'), '2000\n')
    writeFileSync(join(logs, 'synth.log'), 'reading\n3.1 Executing PROC\n')
    let st = flowState(ws)
    assert.equal(findTop(ws, ''), 'blink')
    assert.equal(st.running, true)
    assert.equal(st.steps[0].state, 'done')
    assert.equal(st.steps[0].ms, 750)
    assert.equal(st.steps[2].state, 'running')
    assert.equal(st.steps[2].last, '3.1 Executing PROC')
    assert.equal(st.steps[5].state, 'pending')

    writeFileSync(join(logs, 'synth.exit'), '1\n')
    writeFileSync(join(logs, 'synth.log'), 'reading\nrtl/blink.v:3: ERROR: syntax error, unexpected TOK_END\nEnd of script.\n')
    writeFileSync(join(logs, 'run.json'), JSON.stringify({ top: 'blink', pid: process.pid, startedAt: 1, finishedAt: 3000 }))
    st = flowState(ws)
    assert.equal(st.running, false)
    assert.equal(st.steps[2].state, 'failed')
    assert.equal(st.steps[2].error, 'rtl/blink.v:3: ERROR: syntax error, unexpected TOK_END')
    assert.equal(st.steps[1].state, 'skipped')
    assert.equal(st.steps[5].state, 'skipped')

    // a run whose process is gone and never finished was interrupted, not running forever
    writeFileSync(join(logs, 'run.json'), JSON.stringify({ top: 'blink', pid: 2 ** 22 + 12345, startedAt: 1, finishedAt: null }))
    rmSync(join(logs, 'synth.exit'))
    st = flowState(ws)
    assert.equal(st.abandoned, true)
    assert.equal(st.steps[2].state, 'interrupted')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
  assert.equal(errorLine('fine\n  ok   no error here\nError: it broke\n'), 'Error: it broke')
})

// ------------------------------------------------------------------------------ the edges

test('VCD edges: odd headers, same-tick rewrites, reals, strings, scalar levels, the change cap', () => {
  assert.equal(tickFs(undefined), 1e3)
  assert.equal(extendBits('10101', 3), '101')
  assert.equal(extendBits('', 4), '0000')
  assert.equal(parseVcd('$date never ends').signals.size, 0)

  const p = parseVcd(`$timescale 10 ns $end
$var wire 1 ! top_level $end
$var wire 1 $end
$var reg w # oddwidth $end
$scope module m $end
$var reg 8 @ bus [7:0] $end
$var wire 1 ^ bit [3] $end
$var real 64 % temp $end
$var string 1 & msg $end
$upscope $end
$scope module m $end
$var reg 8 @ bus [7:0] $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
0!
1!
b101 %
x@
#5
1!
$comment 0! not a change $end
r2.5 %
R2.5 %
r9 ?
sHello &
Sbye ?
b1 ?
l^
#6
h^
#7
u^
#8
Z^
#9
X^
0?
`)
  assert.equal(p.tickFs, 1e7)
  assert.deepEqual(p.vars.map((v) => [v.path, v.width, v.msb, v.lsb]),
    [['top_level', 1, 0, 0], ['oddwidth', 1, 0, 0], ['m.bus', 8, 7, 0], ['m.bit', 1, 3, 3], ['m.temp', 64, 63, 0], ['m.msg', 1, 0, 0]])
  const sig = (id) => p.signals.get(id)
  // 0 then 1 in the first tick: the later write wins; 1 again at #5 is no edge
  assert.deepEqual([sig('!').times, sig('!').values], [[0], ['1']])
  assert.deepEqual(sig('@').values, ['xxxxxxxx']) // a scalar x on a bus fills it
  assert.deepEqual([sig('%').real, sig('%').values], [true, ['101', '2.5']])
  assert.deepEqual(sig('&').values, ['Hello'])
  assert.deepEqual(sig('^').values, ['0', '1', 'x', 'z', 'x'])
  assert.equal(p.truncated, false)

  const capped = parseVcd('$var wire 1 ! a $end $enddefinitions $end #0 0! #1 1! #2 0! #3 1!', { maxChanges: 2 })
  assert.deepEqual([capped.truncated, capped.signals.get('!').values], [true, ['0', '1']])
})

test('chipdb: found beside icepack and read from its head, or the built-in UP5K pin table', () => {
  const probe = (env, pins) => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('./chipdb-probe.mjs', import.meta.url))], {
      env: { ...process.env, ...env, PROBE_PINS: JSON.stringify(pins) }, encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  }
  const root = mkdtempSync(join(tmpdir(), 'yosys-chipdb-'))
  try {
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'icepack'), '')
    mkdirSync(join(root, 'share', 'icestorm', 'chipdb'), { recursive: true })
    writeFileSync(join(root, 'share', 'icestorm', 'chipdb', 'chipdb-5k.txt'),
      '.device 5k\n.pins sg48\n2 8 0 0\n3 9 0 1\n\n.pins uwg30\nA1 1 2 3\n.io_tile 1 0\n')
    const found = probe({ PROBE_ICEPACK: join(root, 'bin', 'icepack') },
      [['up5k', 'sg48'], ['up5k', 'uwg30'], ['up5k', 'nope'], ['hx8k', 'ct256'], ['ecp5', 'x']])
    assert.equal(realpathSync(found.dir), realpathSync(join(root, 'share', 'icestorm', 'chipdb')))
    assert.equal(found.cached, true)
    assert.ok(found.lookupPath.endsWith(':/opt/homebrew/bin:/usr/local/bin:/usr/bin'))
    assert.deepEqual(found.pins, [
      [{ pin: '2', x: 8, y: 0, z: 0 }, { pin: '3', x: 9, y: 0, z: 1 }],
      [{ pin: 'A1', x: 1, y: 2, z: 3 }],
      null, // no such package in the chipdb, and not the one the table knows
      null, // chipdb-8k.txt is not there
      null, // not an iCE40
    ])
    assert.equal(found.pinsCached, true)

    // The OSS CAD Suite setup.sh fetches keeps the chipdb in share/icebox, beside the same bin/.
    mkdirSync(join(root, 'suite', 'bin'), { recursive: true })
    writeFileSync(join(root, 'suite', 'bin', 'icepack'), '')
    mkdirSync(join(root, 'suite', 'share', 'icebox'), { recursive: true })
    writeFileSync(join(root, 'suite', 'share', 'icebox', 'chipdb-5k.txt'), '.device 5k\n.pins sg48\n35 12 31 1\n')
    const suite = probe({ PROBE_ICEPACK: join(root, 'suite', 'bin', 'icepack') }, [['up5k', 'sg48']])
    assert.equal(realpathSync(suite.dir), realpathSync(join(root, 'suite', 'share', 'icebox')))
    assert.deepEqual(suite.pins, [[{ pin: '35', x: 12, y: 31, z: 1 }]])

    const none = probe({ PROBE_ICEPACK: '', PROBE_NO_PATH: '1' }, [['up5k', 'sg48'], ['hx8k', 'ct256']])
    assert.equal(none.dir, null)
    assert.equal(none.lookupPath, ':/opt/homebrew/bin:/usr/local/bin:/usr/bin')
    assert.equal(none.pins[0].length, 39)
    assert.deepEqual(none.pins[0].find((pin) => pin.pin === '35'), { pin: '35', x: 12, y: 31, z: 1 })
    assert.equal(none.pins[1], null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('floorplan edges: unknown tiles, odd routes, bare cells and nets, critical paths', () => {
  assert.deepEqual(tilesFromText('.device 5k\n.weird_tile 1 0\n').rows, ['.?'])
  assert.equal(tilesFromText('.device 5k\nno tiles\n'), null)
  assert.equal(moduleOf('9lives.cell_LC'), '')
  // a pip outside any tile, a source wire not in X.Y.name form, and the same segment twice
  const r = routeSegments('X1/Y1/a;;1;X2/Y2/b;junk;1;X3/Y3/c;X3/Y3/nodots.->.x;1;X5/Y5/d;X5/Y5/1.1.a.->.5.5.d;1;X5/Y5/e;X5/Y5/1.1.a.->.5.5.e;1')
  assert.deepEqual(r, { segs: [1, 1, 5, 5], global: false })

  const empty = buildChip({})
  assert.deepEqual([empty.arch, empty.package, empty.grid, empty.cells, empty.nets, empty.utilization, empty.fmax, empty.criticalPaths],
    ['up5k', 'sg48', null, [], [], null, null, []])
  assert.deepEqual(buildChip({ routed: {} }).cells, [])
  assert.equal(buildChip({ asc: '.device 1k\n.logic_tile 0 0\n' }).arch, 'hx1k')
  assert.equal(buildChip({ asc: '.device 2x\n.logic_tile 0 0\n' }).arch, '2x')

  const chip = buildChip({
    asc: '.device 8k\n.logic_tile 1 1\n',
    routed: {
      modules: {
        top: {
          cells: {
            bare: { type: 'ICESTORM_LC' },
            lc: { type: 'ICESTORM_LC', parameters: { DFF_ENABLE: 1, CARRY_ENABLE: '1', LUT_INIT: '1' }, attributes: { NEXTPNR_BEL: 'X1/Y1/lc1' }, port_directions: { I0: 'input', O: 'output' }, connections: { I0: [5], I1: ['0'], O: [6] } },
            carry: { type: 'ICESTORM_LC', parameters: { DFF_ENABLE: '0', CARRY_ENABLE: 1 }, attributes: {}, connections: {} },
            io: { type: 'SB_IO', attributes: { NEXTPNR_BEL: 'X0/Y1/io0' }, port_directions: { D_IN_0: 'output' }, connections: { D_IN_0: [5] } },
          },
          netnames: {
            clk: { bits: [5], attributes: { ROUTING: 'X0/Y1/io_0:D_IN_0;;1;X1/Y1/lutff_1:in_0;X1/Y1/0.1.glb_netwk_1.->.1.1.lutff_1:in_0;1' } },
            clk_alias: { bits: [5], attributes: { ROUTING: 'X9/Y9/x;;1' } },
            unrouted: { bits: [6], attributes: {} },
            constant: { bits: ['x'] },
            floating: { bits: [8], attributes: { ROUTING: 'X2/Y2/w;;1' } },
          },
        },
      },
    },
    report: {
      critical_paths: [
        { from: 'a', to: 'b', path: [
          { type: 'clk-to-q', delay: 0.5, net: 'clk', sources: ['rtl/blink.v:3'], from: { cell: 'x', port: 'Q', loc: [1, 1] }, to: { cell: 'y', port: 'I0', loc: [2, 2] } },
          { type: 'setup', delay: 0.1 },
        ] },
        { from: 'c', to: 'd' },
      ],
    },
  })
  assert.deepEqual([chip.arch, chip.package], ['hx8k', 'sg48'])
  const [bare, lc, carry, io] = chip.cells
  assert.deepEqual([bare.x, bare.y, bare.b, bare.lut, bare.ff, bare.carry, bare.k], [-1, -1, '', 0, 0, 0, undefined])
  assert.deepEqual([lc.lut, lc.ff, lc.carry, lc.k, lc.init], [1, 1, 1, 2, undefined])
  assert.deepEqual([carry.ff, carry.carry], [0, 1])
  assert.equal(io.t, 'SB_IO')
  assert.deepEqual(chip.nets, [
    { n: 'clk', g: 1, s: [0, 1, 1, 1], d: 3, k: [1] },
    { n: 'floating', g: 0, s: [], d: -1, k: [] },
  ])
  assert.deepEqual(chip.criticalPaths, [
    { from: 'a', to: 'b', path: [
      { type: 'clk-to-q', delay: 0.5, net: 'clk', sources: ['rtl/blink.v:3'], from: { cell: 'x', port: 'Q', loc: [1, 1] }, to: { cell: 'y', port: 'I0', loc: [2, 2] } },
      { type: 'setup', delay: 0.1, net: null, sources: [], from: null, to: null },
    ] },
    { from: 'c', to: 'd', path: [] },
  ])
  assert.deepEqual([chip.utilization, chip.fmax], [null, null])
})

test('netlist edges: names, parameters, deep and bare modules', () => {
  assert.equal(cleanModuleName(''), '')
  assert.equal(cleanModuleName(undefined), undefined)
  assert.equal(cleanModuleName('$paramod'), '$paramod')
  assert.equal(cleanModuleName('\\top'), 'top')
  assert.deepEqual(paramsOf({ parameter_default_values: { TEXT: 'abc', WIDE: '1'.repeat(60), N: '101' } }),
    { TEXT: 'abc', WIDE: '1'.repeat(60), N: '5' })
  assert.deepEqual(paramsOf(undefined), {})
  assert.equal(topModule(undefined), null)
  assert.equal(hierarchy({}), null)

  const nl = {
    modules: {
      top: { cells: { m1: { type: 'mid' } } },
      mid: { cells: { l1: { type: 'leaf' }, again: { type: 'mid' } } },
      leaf: {},
    },
  }
  const tree = hierarchy(nl)
  const leaf = tree.children[0].children.find((c) => c.name === 'l1')
  assert.deepEqual([leaf.path, leaf.cells, leaf.children], ['m1.l1', 0, []])
  // a module that instantiates itself stops at the depth limit instead of recursing forever
  let depth = 0
  for (let node = tree.children[0]; node; node = node.children.find((c) => c.name === 'again')) depth++
  assert.equal(depth, 33)

  assert.equal(moduleForRender({}, 'top'), null)
  assert.equal(moduleForRender(nl, 'nope'), null)
  assert.deepEqual(moduleForRender(nl, 'leaf'), { modules: { leaf: { attributes: { top: 1 }, cells: {} } } })

  assert.equal(moduleIndex(undefined, 'top'), null)
  const bare = moduleIndex(nl, 'leaf')
  assert.deepEqual([bare.nets, bare.cells, bare.ports, bare.src], [{}, {}, {}, ''])
  const idx = moduleIndex({
    modules: {
      top: {
        attributes: { src: 'rtl/top.v:1' },
        ports: { nobits: { direction: 'input' } },
        netnames: {
          a: { bits: [2, '0', 'x'] }, b: { bits: [2] }, c: { bits: [2], attributes: { src: 'rtl/top.v:4' } }, d: { bits: [2] },
          e: {},
          '$auto$only': { hide_name: 1, bits: [9] },
        },
      },
    },
  }, 'top')
  assert.deepEqual(idx.bitNames['2'], ['a[0]', 'b', 'c']) // at most three names per bit
  assert.equal(idx.nets[''].width, 0)
  assert.deepEqual([idx.nets['2'].names, idx.nets['2'].src, idx.nets['2'].hidden], [['b', 'c', 'd'], '', 0])
  assert.deepEqual([idx.nets['9'].names, idx.nets['9'].hidden], [['$auto$only'], 1]) // a net only yosys named
  assert.equal(idx.ports.nobits.width, 0)
  assert.equal(idx.src, 'rtl/top.v:1')
})

test('workspace edges: long logs, the top from other files, odd steps, PCF flags, ports', () => {
  const ws = mkdtempSync(join(tmpdir(), 'yosys-ws-'))
  try {
    const put = (rel, text) => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), text) }
    put('big.log', 'head\nmiddle\ntail')
    assert.equal(readText(join(ws, 'big.log'), 4), 'tail')
    assert.equal(readText(join(ws, 'big.log'), 100), 'head\nmiddle\ntail')
    mkdirSync(join(ws, 'out'))
    assert.equal(fileInfo(ws, 'out'), null)

    // no out/.top: a file the pane was opened on, then the newest report, then the testbench
    assert.equal(findTop(ws, 'out/uart.svg'), 'uart')
    assert.equal(findTop(ws, 'out/waves.json'), null)
    put('tb/notes.txt', '')
    assert.equal(findTop(ws, 'out/sim.json'), null)
    put('tb/spi_tb.v', '')
    assert.equal(findTop(ws, null), 'spi')
    put('out/old.report.json', '{}')
    put('out/new.report.json', '{}')
    utimesSync(join(ws, 'out/old.report.json'), new Date(1000), new Date(1000))
    assert.equal(findTop(ws, 'out/waves.json'), 'new')

    // steps: a running step with an empty log, a failed one whose log says nothing, a run with no pid
    const logs = join(ws, 'out', 'logs')
    put('out/logs/run.json', JSON.stringify({ startedAt: 1 }))
    put('out/logs/sim.start', 'soon\n')
    put('out/logs/sim.log', '')
    put('out/logs/synth.exit', '2\n')
    put('out/logs/synth.log', '\n\n')
    put('out/logs/pnr.exit', '1\n')
    put('out/logs/pnr.log', 'placing\nstill placing\n')
    put('out/logs/pack.time', 'not times\n')
    let st = flowState(ws)
    assert.deepEqual([st.abandoned, st.running], [false, true])
    const [sim, , synth, , , pnr, pack] = st.steps
    assert.deepEqual([sim.state, sim.last, sim.startedAt], ['running', '', undefined])
    assert.deepEqual([synth.state, synth.exit, synth.last, synth.error], ['failed', 2, '', ''])
    assert.deepEqual([pnr.last, pnr.error], ['still placing', 'still placing'])
    assert.deepEqual([pack.state, pack.ms], ['pending', undefined])
    assert.ok(logs)
    // a pid that exists but is not ours (EPERM) is still alive
    put('out/logs/run.json', JSON.stringify({ pid: 1, startedAt: 1 }))
    st = flowState(ws)
    assert.deepEqual([st.abandoned, st.running], [false, true])
    assert.equal(errorLine(''), '')

    const pcf = parsePcf('set_io -x -nowarn a 1\nset_io b 2 -pullup\nset_io lonely\n# set_frequency clk 99\n')
    assert.deepEqual(pcf.ios, [
      { port: 'a', pin: '1', line: 1, commented: false, x: true, nowarn: true },
      { port: 'b', pin: '2', line: 2, commented: false, pullup: true },
    ])
    assert.deepEqual(pcf.frequencies, {})
    assert.deepEqual(parsePcf(undefined), { ios: [], frequencies: {} })

    // ports: a synthesised netlist that does not name the top, then a schematic that marks it
    put('out/t.json', JSON.stringify({ modules: { other: { attributes: { top: 0 } } } }))
    put('out/t_schematic.json', JSON.stringify({ modules: { renamed: { attributes: { top: '00000000000000000000000000000001' }, ports: { a: { direction: 'input' } } } } }))
    assert.deepEqual(topPorts(ws, 't'), { from: 'out/t_schematic.json', ports: { a: { direction: 'input', width: 0 } } })
    put('out/u.json', JSON.stringify({ modules: { u: {} } }))
    assert.deepEqual(topPorts(ws, 'u'), { from: 'out/u.json', ports: {} })
    assert.equal(topPorts(ws, 'nobody'), null)
    put('rtl/README.md', '')
    put('rtl/top.sv', '')
    assert.deepEqual(sources(ws).map((f) => f.path), ['rtl/top.sv', 'tb/spi_tb.v'])
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
