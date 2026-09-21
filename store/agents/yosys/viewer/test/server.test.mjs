// viewer.mjs as Harness runs it: a child process on a loopback port over a workspace laid out as
// flow.sh leaves it. `node --test viewer/test/` — the schematic is drawn for real when this
// checkout's node_modules has netlistsvg (toolchain/setup.sh), and says it cannot be otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const PKG = fileURLToPath(new URL('../..', import.meta.url))
const PRELOAD = fileURLToPath(new URL('./sigterm-exit.mjs', import.meta.url))
const HAS_NETLISTSVG = existsSync(join(PKG, 'node_modules', 'netlistsvg', 'lib', 'default.svg'))

const VCD = `$timescale 1ps $end
$scope module blink_tb $end
$var reg 1 ! clk $end
$var reg 4 " count [3:0] $end
$upscope $end
$enddefinitions $end
#0
0!
b0 "
#5
1!
b1 "
`

const DIVIDER = "$paramod\\divider\\N=s32'00000000000000000000000000001000"
const SCHEMATIC = {
  modules: {
    blink: {
      attributes: { top: '00000000000000000000000000000001', src: 'rtl/blink.v:1.1-20.10' },
      ports: { clk: { direction: 'input', bits: [2] }, led: { direction: 'output', bits: [3] } },
      cells: {
        u_div: { type: DIVIDER, port_directions: { clk: 'input', q: 'output' }, connections: { clk: [2], q: [4] }, attributes: { src: 'rtl/blink.v:5.3-5.30' } },
        '$not$rtl/blink.v:9$1': { type: '$not', port_directions: { A: 'input', Y: 'output' }, connections: { A: [4], Y: [3] }, attributes: {} },
      },
      netnames: {
        clk: { hide_name: 0, bits: [2], attributes: {} },
        led: { hide_name: 0, bits: [3], attributes: {} },
        tick: { hide_name: 0, bits: [4], attributes: { src: 'rtl/blink.v:3' } },
        '$auto$tick': { hide_name: 1, bits: [4], attributes: {} },
      },
    },
    [DIVIDER]: {
      attributes: { src: 'rtl/blink.v:22.1-30.10' },
      parameter_default_values: { N: '00000000000000000000000000001000' },
      ports: { clk: { direction: 'input', bits: [2] }, q: { direction: 'output', bits: [3] } },
      cells: {},
      netnames: { clk: { hide_name: 0, bits: [2] }, q: { hide_name: 0, bits: [3] }, count: { hide_name: 0, bits: [4, 5] } },
    },
    // netlistsvg cannot draw a port whose bits are not a list
    broken: { attributes: {}, ports: { a: { direction: 'input', bits: 'zz' } }, cells: {}, netnames: {} },
  },
}

const ROUTED = {
  modules: {
    blink: {
      settings: { 'arch.type': 'up5k', 'arch.package': 'sg48' },
      cells: {
        'led$sb_io': { type: 'SB_IO', parameters: {}, attributes: { NEXTPNR_BEL: 'X13/Y31/io1' }, port_directions: {}, connections: {} },
        'tick_LC': { type: 'ICESTORM_LC', parameters: { DFF_ENABLE: '1' }, attributes: { NEXTPNR_BEL: 'X12/Y30/lc0' }, port_directions: {}, connections: {} },
      },
      netnames: {},
    },
  },
}

function write(root, rel, content) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content))
}

function workspace(t) {
  const ws = mkdtempSync(join(tmpdir(), 'yosys-viewer-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  return ws
}

/** A workspace after a whole flow run. */
function built(ws) {
  write(ws, 'rtl/blink.v', 'module blink(input clk, output led); endmodule\n')
  write(ws, 'tb/blink_tb.v', 'module blink_tb; endmodule\n')
  write(ws, 'constraints/blink.pcf', 'set_io -nowarn clk 35\nset_io led 39\nset_frequency clk 12\n')
  write(ws, 'notes.xyz', 'odd\n')
  write(ws, 'out/.top', 'blink\n')
  write(ws, 'out/sim.vcd', VCD)
  write(ws, 'out/blink_schematic.json', SCHEMATIC)
  write(ws, 'out/blink.asc', '.device 5k\n.logic_tile 12 30\n.io_tile 13 31\n')
  write(ws, 'out/blink_routed.json', ROUTED)
  write(ws, 'out/blink_pnr.json', { utilization: { ICESTORM_LC: { used: 1, available: 5280 } }, fmax: {}, critical_paths: [] })
  write(ws, 'out/blink.report.json', { top: 'blink', ready: true })
  write(ws, 'out/blink.svg', '<svg/>')
  write(ws, 'out/blink.bin', Buffer.from([0, 1, 2, 3]))
  write(ws, 'out/logs/run.json', { top: 'blink', pid: 1, startedAt: 1, finishedAt: 2, device: '--up5k', package: 'sg48' })
  write(ws, 'out/logs/sim.exit', '0\n')
  write(ws, 'out/logs/sim.log', 'PASS  blink\n')
  return ws
}

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  server.close()
  await once(server, 'close')
  return port
}

async function startViewer(t, ws, { cwd } = {}) {
  const port = await freePort()
  const env = { ...process.env, HARNESS_VIEWER_PORT: String(port) }
  if (ws) env.HARNESS_WORKSPACE = ws
  else delete env.HARNESS_WORKSPACE
  const child = spawn(process.execPath, ['--import', PRELOAD, join(PKG, 'viewer.mjs')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
  }
  t.after(stop)
  for (let k = 0; k < 200 && !output.includes('listening on'); k++) await sleep(25)
  assert.match(output, /\[yosys\] listening on http:\/\/127\.0\.0\.1:\d+\//)
  return { port, output: () => output, stop }
}

function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(body) } catch { /* not JSON */ }
        resolve({ status: res.statusCode, type: res.headers['content-type'], headers: res.headers, body, json })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

test('the page, its files, and workspace files — never anything outside either', async (t) => {
  const ws = built(workspace(t))
  const { port } = await startViewer(t, ws)

  for (const path of ['/', '/index.html']) {
    const r = await get(port, path)
    assert.equal(r.status, 200)
    assert.equal(r.type, 'text/html; charset=utf-8')
    assert.match(r.body, /<html/i)
  }
  const head = await get(port, '/', 'HEAD')
  assert.deepEqual([head.status, head.body], [200, ''])
  assert.ok(Number(head.headers['content-length']) > 0)

  assert.equal((await get(port, '/app/app.js')).type, 'text/javascript; charset=utf-8')
  assert.equal((await get(port, '/app/app.css')).type, 'text/css; charset=utf-8')
  assert.equal((await get(port, '/app/nope.js')).status, 404)
  assert.equal((await get(port, '/app/..%2F..%2Fviewer.mjs')).status, 404)

  const v = await get(port, '/ws/rtl/blink.v')
  assert.deepEqual([v.status, v.type, v.body], [200, 'text/plain; charset=utf-8', 'module blink(input clk, output led); endmodule\n'])
  assert.equal((await get(port, '/ws/out/blink.bin')).type, 'application/octet-stream')
  assert.equal((await get(port, '/ws/notes.xyz')).type, 'application/octet-stream')
  assert.equal((await get(port, '/ws/')).status, 404) // the workspace itself is not a file
  assert.equal((await get(port, '/ws/..%2F..%2F..%2Fetc%2Fhosts')).status, 404)
  // old links: a workspace path at the root
  const svg = await get(port, '/out/blink.svg')
  assert.deepEqual([svg.status, svg.type], [200, 'image/svg+xml'])
  assert.equal((await get(port, '/out/missing.svg')).status, 404)
})

test('a malformed path or an unreadable file is a 500, and the server keeps serving', async (t) => {
  const ws = built(workspace(t))
  write(ws, 'rtl/locked.v', 'secret\n')
  chmodSync(join(ws, 'rtl/locked.v'), 0o000) // a regular file in the temp workspace; removed with it
  const { port, output } = await startViewer(t, ws)
  const bad = await get(port, '/%E0%A4%A')
  assert.equal(bad.status, 500)
  assert.match(bad.json.error, /URI malformed/)
  const locked = await get(port, '/ws/rtl/locked.v')
  assert.equal(locked.status, 500)
  assert.match(locked.json.error, /EACCES/)
  assert.equal((await get(port, '/ws/rtl/blink.v')).status, 200)
  assert.match(output(), /\[yosys\] URIError/)
})

test('/api/state: the top, the flow, the report and which files exist', async (t) => {
  const ws = workspace(t)
  const { port } = await startViewer(t, ws)
  let s = (await get(port, '/api/state')).json
  assert.equal(s.top, null)
  assert.deepEqual([s.files, s.sources, s.report], [{}, [], null])
  assert.equal(s.workspace, ws.split('/').pop())

  built(ws)
  s = (await get(port, '/api/state?file=out%2Fblink.report.json')).json
  assert.equal(s.top, 'blink')
  assert.deepEqual(s.report, { top: 'blink', ready: true })
  assert.equal(s.files.vcd.path, 'out/sim.vcd')
  assert.equal(s.files.waves, null)
  assert.equal(s.files.bin.size, 4)
  assert.equal(s.flow.steps[0].state, 'done')
  assert.deepEqual(s.sources.map((f) => f.path), ['rtl/blink.v', 'tb/blink_tb.v', 'constraints/blink.pcf'])
})

test('/api/vcd: the hierarchy up front, the changes on demand, re-read when the dump changes', async (t) => {
  const ws = workspace(t)
  const { port } = await startViewer(t, ws)
  assert.deepEqual((await get(port, '/api/vcd/meta')).json, { error: 'no out/sim.vcd yet' })
  assert.equal((await get(port, '/api/vcd/data?ids=!')).status, 404)

  write(ws, 'out/sim.vcd', VCD)
  const meta = (await get(port, '/api/vcd/meta')).json
  assert.equal(meta.path, 'out/sim.vcd')
  assert.equal(meta.end, 5)
  assert.deepEqual(meta.scopes[0].vars.map((v) => v.name), ['clk', 'count'])
  assert.equal((await get(port, '/api/vcd/meta')).json.mtime, meta.mtime) // cached

  const data = (await get(port, `/api/vcd/data?ids=${encodeURIComponent('! " nope')}`)).json
  assert.equal(data.mtime, meta.mtime)
  assert.deepEqual(data.signals.map((s) => [s.id, s.v]), [['!', '01'], ['"', ['0000', '0001']]])
  assert.deepEqual((await get(port, '/api/vcd/data')).json.signals, [])

  write(ws, 'out/sim.vcd', VCD + '#9\n0!\n#12\n')
  assert.equal((await get(port, '/api/vcd/meta')).json.end, 12)
})

test('/api/netlist: the instance tree, one module\'s names, and every name for search', async (t) => {
  const ws = workspace(t)
  const { port } = await startViewer(t, ws)
  for (const path of ['/api/netlist', '/api/netlist/module?module=blink', '/api/netlist/names']) {
    assert.equal((await get(port, path)).status, 404, path) // no top module yet
  }
  write(ws, 'out/.top', 'blink\n')
  assert.deepEqual((await get(port, '/api/netlist')).json, { error: 'no schematic netlist yet' })
  assert.equal((await get(port, '/api/netlist/names')).status, 404)

  write(ws, 'out/blink_schematic.json', SCHEMATIC)
  const tree = (await get(port, '/api/netlist')).json
  assert.equal(tree.top, 'blink')
  assert.match(tree.stamp, /^\d+:\d+$/)
  assert.deepEqual(tree.tree.children.map((c) => [c.name, c.label, c.params]), [['u_div', 'divider', { N: '8' }]])

  const mod = (await get(port, `/api/netlist/module?module=${encodeURIComponent(DIVIDER)}`)).json
  assert.equal(mod.label, 'divider')
  assert.deepEqual(Object.keys(mod.ports), ['clk', 'q'])
  assert.equal((await get(port, '/api/netlist/module?module=nope')).status, 404)
  assert.equal((await get(port, '/api/netlist/module')).status, 404)
  // ?top= wins over the workspace's own
  assert.equal((await get(port, '/api/netlist?top=other')).status, 404)

  const { names } = (await get(port, '/api/netlist/names')).json
  assert.deepEqual(names, [
    { kind: 'port', name: 'clk', path: '' }, { kind: 'port', name: 'led', path: '' },
    { kind: 'net', name: 'tick', path: '' },
    { kind: 'inst', name: 'u_div', path: '' },
    { kind: 'port', name: 'clk', path: 'u_div' }, { kind: 'port', name: 'q', path: 'u_div' },
    { kind: 'net', name: 'count', path: 'u_div' },
  ])

  // a netlist with no modules has no tree to search; a top that is not a module has no names
  write(ws, 'out/blink_schematic.json', '{}')
  assert.deepEqual((await get(port, '/api/netlist/names')).json, { names: [] })
  assert.equal((await get(port, '/api/schematic.svg?module=blink')).status, 404)
  write(ws, 'out/blink_schematic.json', '{"modules": {"blink": null}}')
  assert.deepEqual((await get(port, '/api/netlist/names')).json, { names: [] })
  // a netlist that is not JSON (yosys still writing it) is not there yet
  write(ws, 'out/blink_schematic.json', '{"modules": ')
  assert.equal((await get(port, '/api/netlist')).status, 404)
})

test('/api/schematic.svg: one module drawn by netlistsvg, once per netlist', async (t) => {
  const ws = built(workspace(t))
  const { port } = await startViewer(t, ws)
  assert.equal((await get(port, '/api/schematic.svg?module=nope')).status, 404)
  assert.equal((await get(port, '/api/schematic.svg')).status, 404)
  const first = await get(port, '/api/schematic.svg?module=blink')
  if (HAS_NETLISTSVG) {
    assert.deepEqual([first.status, first.type], [200, 'image/svg+xml'])
    assert.match(first.body, /^<svg/)
    assert.equal((await get(port, '/api/schematic.svg?module=blink')).body, first.body) // the cached job
    const broken = await get(port, '/api/schematic.svg?module=broken')
    assert.deepEqual([broken.status, broken.type], [500, 'text/plain'])
    assert.match(broken.body, /is not a function/)
    // a failed drawing is forgotten, so the next request tries again
    assert.equal((await get(port, '/api/schematic.svg?module=broken')).status, 500)
  } else {
    assert.deepEqual([first.status, first.body], [500, 'netlistsvg is not installed here — run toolchain/setup.sh'])
  }
  write(ws, 'out/.top', 'nobody\n')
  assert.equal((await get(port, '/api/schematic.svg?module=blink')).status, 404)
})

test('/api/chip and /api/board: the floorplan, the pins, the constraints', async (t) => {
  const ws = workspace(t)
  const { port } = await startViewer(t, ws)
  const nothing = (await get(port, '/api/board')).json // no top module at all
  assert.deepEqual([nothing.top, nothing.pcf, nothing.ports, nothing.arch], [null, null, null, 'up5k'])
  write(ws, 'out/.top', 'blink\n')
  assert.deepEqual((await get(port, '/api/chip')).json, { error: 'no place-and-route output yet' })

  // before place and route: the board from the run record, no ports yet
  write(ws, 'out/logs/run.json', { device: '--hx8k', package: 'ct256' })
  let board = (await get(port, '/api/board')).json
  assert.deepEqual([board.top, board.pcf, board.ports, board.arch, board.package, board.placed], ['blink', null, null, 'hx8k', 'ct256', []])
  rmSync(join(ws, 'out/logs/run.json'))
  board = (await get(port, '/api/board')).json
  assert.deepEqual([board.arch, board.package], ['up5k', 'sg48'])
  assert.ok(board.pins.some((p) => p.pin === '35'))

  built(ws)
  const chip = (await get(port, '/api/chip')).json
  assert.equal(chip.arch, 'up5k')
  assert.deepEqual(chip.cells.map((c) => [c.n, c.t, c.x, c.y]), [['led$sb_io', 'SB_IO', 13, 31], ['tick_LC', 'ICESTORM_LC', 12, 30]])
  assert.equal(chip.grid.width, 14)
  assert.equal(chip.files.length, 3)
  assert.equal((await get(port, '/api/chip')).json.stamp, chip.stamp) // cached

  board = (await get(port, '/api/board')).json
  assert.deepEqual(board.pcf.ios.map((io) => [io.port, io.pin]), [['clk', '35'], ['led', '39']])
  assert.equal(board.pcf.path, 'constraints/blink.pcf')
  assert.deepEqual(board.placed, [{ cell: 'led$sb_io', x: 13, y: 31, z: 1 }])
  // the ports come from the schematic netlist until synthesis writes its own
  assert.deepEqual(board.ports, { from: 'out/blink_schematic.json', ports: { clk: { direction: 'input', width: 1 }, led: { direction: 'output', width: 1 } } })
  write(ws, 'out/blink.json', { modules: { blink: { ports: { clk: { direction: 'input', bits: [2] } } } } })
  assert.deepEqual((await get(port, '/api/board')).json.ports, { from: 'out/blink.json', ports: { clk: { direction: 'input', width: 1 } } })
})

test('/api/log and unknown endpoints', async (t) => {
  const ws = built(workspace(t))
  const { port } = await startViewer(t, ws)
  const log = await get(port, '/api/log?step=sim')
  assert.deepEqual([log.status, log.type, log.body], [200, 'text/plain; charset=utf-8', 'PASS  blink\n'])
  assert.equal((await get(port, '/api/log?step=..%2F..%2Fsim')).body, 'PASS  blink\n') // only letters survive
  assert.equal((await get(port, '/api/log?step=pack')).status, 404)
  assert.equal((await get(port, '/api/log')).status, 404)
  assert.deepEqual((await get(port, '/api/nope')).json, { error: 'unknown endpoint' })
})

test('/events: batched change events naming the files, not the noise', async (t) => {
  const ws = built(workspace(t))
  const { port } = await startViewer(t, ws)
  const events = []
  const res = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/events' }, resolve)
    req.on('error', reject)
    req.end()
  })
  assert.equal(res.headers['content-type'], 'text/event-stream')
  let buffer = ''
  res.setEncoding('utf8')
  res.on('data', (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
      events.push(buffer.slice(0, at))
      buffer = buffer.slice(at + 2)
    }
  })
  for (let k = 0; k < 100 && !events.length; k++) await sleep(20)
  assert.equal(events[0], 'retry: 1000')
  await sleep(300) // let the watcher settle past the files built() wrote

  events.length = 0
  write(ws, 'node_modules/x.js', '')
  write(ws, '.git/HEAD', '')
  write(ws, '.claude/settings.json', '{}')
  write(ws, 'out/sim.vvp', '')
  write(ws, 'rtl/blink.v', 'module blink; endmodule\n')
  write(ws, 'out/logs/synth.log', 'reading\n')
  for (let k = 0; k < 100 && !events.some((e) => e.includes('synth.log')); k++) await sleep(20)
  const paths = new Set(events.filter((e) => e.startsWith('event: change')).flatMap((e) => JSON.parse(e.split('data: ')[1]).paths))
  assert.ok(paths.has('rtl/blink.v'), [...paths].join(' '))
  assert.ok(paths.has('out/logs/synth.log'), [...paths].join(' '))
  for (const p of paths) assert.doesNotMatch(p, /node_modules|^\.git\/|\.vvp$|^\.claude/)
  res.destroy()
})

test('with no HARNESS_WORKSPACE it serves the directory it was started in; a workspace that is not there is not watched', async (t) => {
  const ws = built(workspace(t))
  const here = await startViewer(t, null, { cwd: ws })
  assert.equal((await get(here.port, '/api/state')).json.top, 'blink')
  const gone = await startViewer(t, join(ws, 'not-there'))
  assert.match(gone.output(), /\[yosys\] watch failed: /)
  assert.equal((await get(gone.port, '/api/state')).json.top, null)
})
