// The server against scratch workspaces, one test per thing the pane asks it: the page and the engine,
// files from both roots with Range and nothing outside them, what to open for every shape a workspace
// can be in, the files a model needs, the picker, a model's directory, and the change feed.
//
//   npm test
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { changedPaths, removeTree, startViewer, touch, write } from './helpers.mjs'

const root = mkdtempSync(join(tmpdir(), 'mujoco-viewer-srv-'))
const ws = join(root, 'ws')
const menagerie = join(root, 'menagerie')
const T = Date.now() - 3_600_000 // mtimes an hour ago, a second apart, so "newest" is ours to decide
const at = (s) => T + s * 1000
let viewer

const MJCF = (name, body = '') => `<mujoco model="${name}">${body}<worldbody><geom size=".1"/></worldbody></mujoco>`

/** Empty the workspace, keeping the directory the server watches. */
function clear() {
  for (const name of readdirSync(ws)) removeTree(join(ws, name))
}

before(async () => {
  write(join(menagerie, 'bot', 'scene.xml'), '<mujoco model="bot"><include file="bot.xml"/><worldbody><geom type="plane" size="1 1 .1"/></worldbody></mujoco>')
  write(join(menagerie, 'bot', 'bot.xml'), '<mujoco><compiler meshdir="assets"/><asset><mesh name="m" file="part.obj"/><texture name="t" type="2d" file="skin.png"/></asset><worldbody><body><freejoint/><geom type="mesh" mesh="m"/></body></worldbody></mujoco>')
  write(join(menagerie, 'bot', 'assets', 'part.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
  write(join(menagerie, 'bot', 'skin.png'), 'png')
  write(join(menagerie, 'bot', 'README.md'), 'not a model file')
  write(join(menagerie, 'arm', 'arm.xml'), MJCF('arm'))
  write(join(menagerie, 'empty', 'notes.txt'), 'no model here')
  write(join(menagerie, '.cache', 'scene.xml'), MJCF('cache'))
  write(join(menagerie, 'index.txt'), 'a file, not a robot')
  mkdirSync(ws)
  viewer = await startViewer({ env: { HARNESS_WORKSPACE: ws, MENAGERIE: menagerie, TEST_TIMERS: '20000=40' } })
})

after(async () => {
  if (viewer) assert.deepEqual(await viewer.stop(), { code: 0, signal: null }, 'SIGTERM is a clean exit')
  removeTree(root)
})

test('serves the page and the engine from the package, and nothing else from it', async () => {
  const page = await viewer.get('/')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-type'], /text\/html/)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.equal((await viewer.get('/index.html')).status, 200)
  const head = await viewer.get('/', {}, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.body.length, 0)
  assert.ok(Number(head.headers['content-length']) > 0)
  assert.match((await viewer.get('/static/main.js')).headers['content-type'], /javascript/)
  assert.match((await viewer.get('/static/style.css')).headers['content-type'], /text\/css/)
  assert.equal((await viewer.get('/static/nope.js')).status, 404)
  assert.equal((await viewer.get('/static/..%2Fviewer.mjs')).status, 404)
  assert.equal((await viewer.get('/static/../viewer.mjs')).status, 404)
  assert.equal((await viewer.get('/favicon.ico')).status, 204)

  const wasm = await viewer.get('/vendor/mujoco/mujoco.wasm', { range: 'bytes=0-3' })
  assert.equal(wasm.status, 206)
  assert.equal(wasm.headers['content-type'], 'application/wasm')
  assert.deepEqual([...wasm.body], [0x00, 0x61, 0x73, 0x6d], 'the WebAssembly magic')
  const three = await viewer.get('/vendor/three/build/three.module.js', {}, 'HEAD')
  assert.equal(three.status, 200)
  assert.equal(three.headers['cache-control'], 'max-age=3600')
  for (const path of ['/vendor/three', '/vendor/nope/x.js', '/vendor//build/three.module.js', '/vendor/three/..%2F..%2Fpackage.json', '/vendor/three/..%2F..%2F..%2Fviewer.mjs']) {
    assert.equal((await viewer.get(path)).status, 404, path)
  }
  assert.equal((await viewer.get('/nothing/here')).status, 404)
})

test('workspace files honour Range the way WebKit asks for video', async () => {
  clear()
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
  write(join(ws, 'out', 'clip.mp4'), bytes)
  write(join(ws, 'out', 'blob.bin'), 'binary')
  write(join(ws, 'scene.XML'), MJCF('upper'))
  const path = '/ws/out/clip.mp4'

  const whole = await viewer.get(path)
  assert.equal(whole.status, 200)
  assert.equal(whole.headers['accept-ranges'], 'bytes')
  assert.equal(whole.headers['content-type'], 'video/mp4')
  assert.equal(whole.headers['content-length'], '4096')
  assert.ok(whole.body.equals(bytes))

  const cases = [
    ['bytes=100-199', 206, 'bytes 100-199/4096', bytes.subarray(100, 200)],
    ['bytes=4000-', 206, 'bytes 4000-4095/4096', bytes.subarray(4000)],
    ['bytes=-96', 206, 'bytes 4000-4095/4096', bytes.subarray(4000)],
    ['bytes=-9999', 206, 'bytes 0-4095/4096', bytes],
    ['bytes=4090-99999', 206, 'bytes 4090-4095/4096', bytes.subarray(4090)],
    ['bytes=5000-', 416, 'bytes */4096', Buffer.alloc(0)],
    ['bytes=200-100', 416, 'bytes */4096', Buffer.alloc(0)],
  ]
  for (const [range, status, contentRange, body] of cases) {
    const r = await viewer.get(path, { range })
    assert.equal(r.status, status, range)
    assert.equal(r.headers['content-range'], contentRange, range)
    assert.ok(r.body.equals(body), range)
  }
  for (const range of ['bytes=-', 'items=0-10']) {
    const r = await viewer.get(path, { range })
    assert.equal(r.status, 200, `${range} is not a range this server answers with part of the file`)
    assert.equal(r.body.length, 4096)
  }
  const partHead = await viewer.get(path, { range: 'bytes=0-9' }, 'HEAD')
  assert.equal(partHead.status, 206)
  assert.equal(partHead.headers['content-length'], '10')
  assert.equal(partHead.body.length, 0)
  const wholeHead = await viewer.get(path, {}, 'HEAD')
  assert.equal(wholeHead.headers['content-length'], '4096')
  assert.equal(wholeHead.body.length, 0)

  assert.equal((await viewer.get('/ws/out/blob.bin')).headers['content-type'], 'application/octet-stream')
  assert.equal((await viewer.get('/ws/scene.XML')).headers['content-type'], 'text/xml')
  assert.equal((await viewer.get('/ws/out/nope.mp4')).status, 404)
})

test('both roots are sandboxed: the workspace and the Menagerie, and nothing above either', async () => {
  write(join(root, 'secret.txt'), 'outside both roots')
  for (const path of ['/ws', '/ws/', '/ws/out', '/ws/../secret.txt', '/ws/%2e%2e/secret.txt', '/ws/..%2Fsecret.txt', '/ws/out%2F..%2F..%2Fsecret.txt',
    '/menagerie', '/menagerie/', '/menagerie/..%2Fsecret.txt', '/menagerie/bot%2F..%2F..%2Fsecret.txt', '/menagerie/../secret.txt']) {
    const r = await viewer.get(path)
    assert.equal(r.status, 404, path)
    assert.doesNotMatch(r.body.toString(), /outside both roots/, path)
  }
  const robot = await viewer.get('/menagerie/bot/scene.xml')
  assert.equal(robot.status, 200)
  assert.equal(robot.headers['cache-control'], 'max-age=3600')
  assert.equal(robot.headers['content-type'], 'text/xml')
  assert.equal((await viewer.get('/menagerie/bot/assets/part.obj', { range: 'bytes=0-4' })).body.toString(), 'v 0 0')
})

test('a request line no browser sends, or a path that does not decode, is a 400 and the pane stays up', async () => {
  // Before the fix, `new URL` threw outside the handler's try and the whole viewer exited.
  assert.equal(await viewer.raw('GET http://a:99999/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'), 'HTTP/1.1 400 Bad Request')
  assert.equal((await viewer.get('/%zz')).status, 400)
  assert.equal((await viewer.get('/ws/%E0%A4%A')).status, 400)
  assert.equal(viewer.child.exitCode, null, 'still running')
  assert.equal((await viewer.get('/')).status, 200)
})

const NOTHING = { trajectory: null, trajectoryStatus: null, model: null, modelXml: null, video: null, report: null, source: null, stamps: { trajectory: null, model: null, modelXml: null, video: null } }
const resolve = (query = '') => viewer.json(`/api/resolve${query}`)

test('with no rollout: nothing, then the model a script loads, then a scene in the workspace', async () => {
  clear()
  assert.deepEqual(await resolve(), NOTHING)
  assert.deepEqual(await resolve('?file='), NOTHING)

  // Scripts, newest first; a file that is not a script, and a directory named like one, are not read.
  write(join(ws, 'sim', 'a.py'), 'from harness_mujoco import load_menagerie\nmodel, data = load_menagerie("bot")\n', at(1))
  write(join(ws, 'sim', 'b.py'), 'model, data = load_menagerie("bot", scene="bot.xml")\n', at(2))
  write(join(ws, 'sim', 'notes.txt'), 'load_menagerie("arm", "arm.xml")', at(3))
  mkdirSync(join(ws, 'sim', 'folder.py'))
  let r = await resolve('?file=')
  assert.equal(r.model, 'menagerie/bot/bot.xml')
  assert.equal(r.source, 'script')
  assert.match(r.stamps.model, /^\d+:\d+$/, 'a Menagerie model is stamped by itself')

  // The newest script names nothing that exists, the next cannot be read: the one after them wins.
  write(join(ws, 'data', 'not.xml'), '<robot name="urdf"/>')
  write(join(ws, 'sim', 'c.py'), [
    'robot = load_menagerie("nope")',
    'label = "hello world"',
    'import_name = "numpy"',
    'up = ".."',
    'x = "x"',
    'outside = "../outside.xml"',
    'urdf = "data/not.xml"',
    'elsewhere = "/opt/menagerie/bot/nope.xml"',
    "doc = '''bot'''",
    "scene = r'missing.xml'",
  ].join('\n'), at(4))
  chmodSync(join(ws, 'sim', 'b.py'), 0o000)
  r = await resolve('?file=')
  assert.equal(r.model, 'menagerie/bot/scene.xml', 'from a.py')
  assert.equal(r.source, 'script')

  // Paths built by hand: a robot then its XML, a robot alone, a Menagerie path from another machine, a workspace MJCF.
  clear()
  write(join(ws, 'scenes', 'arm.xml'), MJCF('arm', '<include file="parts/base.xml"/>'))
  write(join(ws, 'scenes', 'parts', 'base.xml'), '<mujoco/>')
  const guesses = [
    ['spec = MjSpec.from_file(str(Path(os.environ["MENAGERIE"]) / "bot" / "bot.xml"))', 'menagerie/bot/bot.xml'],
    ['ROBOT = "bot"', 'menagerie/bot/scene.xml'],
    ['m = mujoco.MjModel.from_xml_path("/opt/menagerie/arm/arm.xml")', 'menagerie/arm/arm.xml'],
    ['m = mujoco.MjModel.from_xml_path("scenes/arm.xml")', 'scenes/arm.xml'],
  ]
  for (const [source, model] of guesses) {
    write(join(ws, 'sim', 'run.py'), source)
    r = await resolve()
    assert.equal(r.model, model, source)
    assert.equal(r.source, 'script', source)
  }
  assert.equal(r.stamps.model.split('|').map((s) => s.split(':')[0]).sort().join(','), 'scenes/arm.xml,scenes/parts/base.xml', 'a workspace model is stamped with every XML it may include')

  // No script: the newest MJCF under scenes/ — not a hidden one, a link, one that cannot be read,
  // one that is not MJCF, one in node_modules, or one too deep to look for.
  clear()
  write(join(ws, 'scenes', 'p.xml'), `<?xml version="1.0"?>\n<!-- the first scene -->\n${MJCF('p')}`, at(10))
  write(join(ws, 'scenes', 'q.xml'), MJCF('q'), at(11))
  write(join(ws, 'scenes', 'sub', 'r.xml'), MJCF('r'), at(5))
  write(join(ws, 'scenes', '.hidden.xml'), MJCF('hidden'), at(50))
  write(join(ws, 'scenes', 'fake.xml'), '<mujocoish/>', at(51))
  write(join(ws, 'scenes', 'notes.txt'), MJCF('text'), at(52))
  write(join(ws, 'scenes', 'node_modules', 'n.xml'), MJCF('n'), at(53))
  write(join(ws, 'scenes', '1', '2', '3', '4', '5', 'deep.xml'), MJCF('deep'), at(54))
  write(join(ws, 'scenes', 'locked.xml'), MJCF('locked'), at(55))
  chmodSync(join(ws, 'scenes', 'locked.xml'), 0o000)
  symlinkSync(join(ws, 'scenes', 'p.xml'), join(ws, 'scenes', 'link.xml'))
  r = await resolve()
  assert.equal(r.model, 'scenes/q.xml')
  assert.equal(r.source, 'workspace')
  touch(join(ws, 'scenes', 'p.xml'), at(11))
  touch(join(ws, 'scenes', 'q.xml'), at(10))
  assert.equal((await resolve()).model, 'scenes/p.xml', 'whichever order the directory lists them in')

  // No scenes/: an MJCF anywhere else, but not under out/ (renders and snapshots) or the workspace's own menagerie/.
  clear()
  write(join(ws, 'root.xml'), MJCF('root'), at(1))
  write(join(ws, 'out', 'rollout.model.xml'), MJCF('snapshot'), at(99))
  write(join(ws, 'menagerie', 'x.xml'), MJCF('x'), at(99))
  write(join(ws, 'data', 'not.xml'), '<robot/>', at(98))
  r = await resolve()
  assert.equal(r.model, 'root.xml')
  assert.equal(r.source, 'workspace')
})

test('with a rollout: the trajectory, its model, snapshot and video, whatever the artifact names', async () => {
  clear()
  write(join(ws, 'scenes', 'arm.xml'), MJCF('arm', '<include file="parts/inc.xml"/><asset><mesh file="arm.obj"/></asset>'), at(1))
  write(join(ws, 'scenes', 'parts', 'inc.xml'), '<mujoco/>', at(1))
  write(join(ws, 'scenes', 'arm.obj'), 'v 0 0 0', at(1))
  write(join(ws, 'out', 'run.mp4'), Buffer.alloc(2048, 1), at(2))
  write(join(ws, 'out', 'run.model.xml'), MJCF('snapshot'), at(2))
  write(join(ws, 'out', 'run.qpos.json'), JSON.stringify({ model: 'menagerie/bot/scene.xml', model_xml: 'out/run.model.xml', video: 'out/run.mp4', status: 'recording', qpos: [[0]] }), at(3))

  const recording = { trajectory: 'out/run.qpos.json', trajectoryStatus: 'recording', model: 'menagerie/bot/scene.xml', modelXml: 'out/run.model.xml', video: 'out/run.mp4', source: 'rollout' }
  let r = await resolve('?file=out/run.qpos.json')
  assert.deepEqual({ ...r, stamps: undefined, report: undefined }, { ...recording, stamps: undefined, report: undefined })
  for (const key of ['trajectory', 'model', 'modelXml', 'video']) assert.match(r.stamps[key], /^\d+:\d+$/, key)
  r = await resolve('?file=out/run.mp4')
  assert.equal(r.trajectory, 'out/run.qpos.json', 'the trajectory beside the video')
  assert.equal(r.video, 'out/run.mp4')

  // A video that is not there, with no trajectory beside it: the newest video under out/ that can be
  // read (not one in a folder that cannot be listed into, a link, or a hidden one), and a scene.
  write(join(ws, 'out', 'ro', 'newer.mp4'), 'x', at(90))
  chmodSync(join(ws, 'out', 'ro'), 0o444)
  symlinkSync(join(ws, 'out', 'run.mp4'), join(ws, 'out', 'link.mp4'))
  write(join(ws, 'out', '.hidden.mp4'), 'x', at(91))
  r = await resolve('?file=out/other.mp4')
  assert.equal(r.trajectory, null)
  assert.equal(r.video, 'out/run.mp4')
  assert.equal(r.model, 'scenes/arm.xml')
  assert.equal(r.source, 'workspace')
  assert.deepEqual(r.stamps.model.split('|').map((s) => s.split(':')[0]).sort(), ['scenes/arm.xml', 'scenes/parts/inc.xml'], 'XML only, not the mesh')
  removeTree(join(ws, 'out', 'ro'))

  // The fixed rollout path, with nothing but a model and qpos: status done, no snapshot, video from out/.
  write(join(ws, 'out', 'rollout.qpos.json'), JSON.stringify({ model: 'scenes/arm.xml', qpos: [] }), at(4))
  r = await resolve()
  assert.equal(r.trajectory, 'out/rollout.qpos.json')
  assert.equal(r.trajectoryStatus, 'done')
  assert.equal(r.model, 'scenes/arm.xml')
  assert.equal(r.source, 'rollout')
  assert.equal(r.modelXml, null)
  assert.equal(r.video, 'out/run.mp4')
  // A snapshot and a video it names that are gone are not offered.
  write(join(ws, 'out', 'rollout.qpos.json'), JSON.stringify({ model: 'scenes/arm.xml', model_xml: 'out/gone.xml', video: 'out/gone.mp4', qpos: [] }), at(4))
  r = await resolve()
  assert.equal(r.modelXml, null)
  assert.equal(r.video, 'out/run.mp4')
  // A model that is gone is reported missing, not opened.
  write(join(ws, 'out', 'rollout.qpos.json'), JSON.stringify({ model: 'scenes/gone.xml', qpos: [] }), at(4))
  r = await resolve()
  assert.equal(r.model, null)
  assert.equal(r.missing, 'scenes/gone.xml')
  assert.equal(r.stamps.model, null)

  // An MJCF artifact is the model; the rollout still plays on it, with its video.
  write(join(ws, 'out', 'rollout.qpos.json'), JSON.stringify({ model: 'menagerie/bot/scene.xml', video: 'out/run.mp4', model_xml: 'out/run.model.xml', qpos: [[1]] }), at(4))
  r = await resolve('?file=scenes/arm.xml')
  assert.equal(r.model, 'scenes/arm.xml')
  assert.equal(r.source, 'artifact')
  assert.equal(r.modelXml, null)
  assert.equal(r.trajectory, 'out/rollout.qpos.json')
  assert.equal(r.video, 'out/run.mp4')
  write(join(ws, 'data', 'not.xml'), '<robot name="urdf"/>')
  r = await resolve('?file=data/not.xml')
  assert.equal(r.model, 'menagerie/bot/scene.xml', 'an XML that is not MJCF is only a hint')
  assert.equal(r.source, 'rollout')

  // A picked model: another sets the rollout aside, the rollout's own keeps it and its snapshot.
  r = await resolve('?file=&model=scenes/arm.xml')
  assert.equal(r.model, 'scenes/arm.xml')
  assert.equal(r.source, 'picked')
  assert.equal(r.trajectory, null)
  assert.equal(r.modelXml, null)
  r = await resolve('?model=menagerie/bot/scene.xml')
  assert.equal(r.source, 'picked')
  assert.equal(r.trajectory, 'out/rollout.qpos.json')
  assert.equal(r.modelXml, 'out/run.model.xml')
  r = await resolve('?model=scenes/gone.xml')
  assert.equal(r.missing, 'scenes/gone.xml')
  r = await resolve('?model=scenes')
  assert.equal(r.missing, 'scenes', 'a directory is not a model')
  assert.equal(r.model, null)
  r = await resolve(`?model=${encodeURIComponent('../../secret.xml')}`)
  assert.equal(r.model, 'scenes/arm.xml', 'a picked path outside the roots is never opened: the workspace decides')
  assert.equal(r.source, 'workspace')
  assert.equal(r.trajectory, null)
  removeTree(join(ws, 'out', 'rollout.qpos.json'))
  r = await resolve('?model=scenes/arm.xml')
  assert.equal(r.model, 'scenes/arm.xml')
  assert.equal(r.source, 'picked')
})

test('with a report: the trajectory it names, or its model and video', async () => {
  clear()
  write(join(ws, 'scenes', 'arm.xml'), MJCF('arm'), at(1))
  write(join(ws, 'out', 'run.mp4'), 'video', at(2))
  write(join(ws, 'out', 'late.mp4'), 'video', at(3))
  write(join(ws, 'out', 'run.qpos.json'), JSON.stringify({ model: 'menagerie/bot/scene.xml', qpos: [[0], [1]] }), at(2))
  write(join(ws, 'out', 'rollout.json'), JSON.stringify({ trajectory: 'out/run.qpos.json', model_path: 'menagerie/arm/arm.xml', video: 'out/run.mp4' }), at(2))

  let r = await resolve('?file=out/rollout.json')
  assert.equal(r.report, 'out/rollout.json')
  assert.equal(r.trajectory, 'out/run.qpos.json', 'the trajectory the report names')
  assert.equal(r.model, 'menagerie/bot/scene.xml')

  // A report that only names a model (and a trajectory that is not a path).
  write(join(ws, 'out', 'meta.json'), JSON.stringify({ model_path: 'scenes/arm.xml', trajectory: 5 }), at(2))
  r = await resolve('?file=out/meta.json')
  assert.equal(r.report, 'out/meta.json')
  assert.equal(r.trajectory, null)
  assert.equal(r.model, 'scenes/arm.xml')
  assert.equal(r.source, 'report')
  assert.equal(r.video, 'out/late.mp4', 'no video in the report: the newest one')

  // JSON that is neither: the workspace's own report is read instead.
  write(join(ws, 'out', 'plain.json'), JSON.stringify({ frames: 3 }))
  write(join(ws, 'out', 'null.json'), 'null')
  write(join(ws, 'out', 'noqpos.json'), JSON.stringify({ model: 'scenes/arm.xml' }))
  write(join(ws, 'out', 'broken.json'), '{ not json')
  for (const file of ['out/plain.json', 'out/null.json', 'out/noqpos.json', 'out/broken.json', 'out/absent.json']) {
    r = await resolve(`?file=${file}`)
    assert.equal(r.report, 'out/rollout.json', file)
    assert.equal(r.trajectory, null, file)
    assert.equal(r.model, 'menagerie/arm/arm.xml', file)
    assert.equal(r.source, 'report', file)
    assert.equal(r.video, 'out/run.mp4', file)
  }

  // A report whose model and video are not strings, or are gone: the workspace decides.
  write(join(ws, 'out', 'rollout.json'), JSON.stringify({ model_path: 7, video: 7 }))
  r = await resolve()
  assert.equal(r.report, 'out/rollout.json')
  assert.deepEqual([r.model, r.source, r.video], ['scenes/arm.xml', 'workspace', 'out/late.mp4'])
  write(join(ws, 'out', 'rollout.json'), JSON.stringify({ model_path: 'scenes/gone.xml', video: 'out/gone.mp4' }))
  r = await resolve()
  assert.deepEqual([r.model, r.source, r.video], ['scenes/arm.xml', 'workspace', 'out/late.mp4'])
  // A report naming files above the workspace: never opened, however real they are.
  write(join(root, 'outside.xml'), MJCF('outside'))
  write(join(root, 'outside.mp4'), 'video')
  write(join(ws, 'out', 'rollout.json'), JSON.stringify({ model_path: '../outside.xml', video: '../outside.mp4' }))
  r = await resolve()
  assert.deepEqual([r.model, r.source, r.video], ['scenes/arm.xml', 'workspace', 'out/late.mp4'])
})

test('the files a model needs: includes, compiler dirs, every file attribute, and nothing outside the roots', async () => {
  clear()
  write(join(ws, 'robot', 'model.xml'), `<mujoco model="robot">
  <!-- <include file="commented.xml"/> -->
  <compiler meshdir="meshes" texturedir='textures' assetdir="assets"/>
  <include file="model.xml"/>
  <include file="parts/leg.xml"/>
  <asset>
    <mesh name="body" file="body.stl"/>
    <mesh name="again" file="body.stl"/>
    <mesh name="shared" file="shared.obj"/>
    <skin file="skin.skn"/>
    <texture name="sky" type="skybox" fileright="right.png" fileleft="left.png"/>
    <hfield name="h" file="terrain.png"/>
    <mesh name="blank" file=""/>
    <mesh name="absolute" file="/etc/hosts"/>
    <mesh name="escape" file="../../../../../../secret.txt"/>
    <material name="m" texture="sky"/>
  </asset>
</mujoco>`)
  write(join(ws, 'robot', 'parts', 'leg.xml'), '<mujoco><include file="../model.xml"/><asset><mesh file="leg.obj"/></asset></mujoco>')
  write(join(ws, 'robot', 'meshes', 'body.stl'), 'solid')
  write(join(ws, 'robot', 'meshes', 'skin.skn'), 'skin')
  write(join(ws, 'robot', 'meshes', 'leg.obj'), 'v 0 0 0')
  write(join(ws, 'robot', 'meshes', 'snapmesh.obj'), 'v 0 0 0')
  write(join(ws, 'robot', 'assets', 'shared.obj'), 'v 0 0 0')
  write(join(ws, 'robot', 'textures', 'right.png'), 'png')
  write(join(ws, 'robot', 'textures', 'terrain.png'), 'png')
  write(join(ws, 'robot', 'commented.xml'), '<mujoco/>')
  write(join(root, 'secret.txt'), 'outside both roots')
  const needs = ['robot/assets/shared.obj', 'robot/meshes/body.stl', 'robot/meshes/leg.obj', 'robot/meshes/skin.skn', 'robot/model.xml', 'robot/parts/leg.xml', 'robot/textures/right.png', 'robot/textures/terrain.png']
  const files = async (query) => {
    const r = await viewer.get(`/api/files?${query}`)
    const body = JSON.parse(r.body.toString())
    return { status: r.status, error: body.error, paths: body.files?.map((f) => f.path).sort() }
  }

  assert.deepEqual(await files('model=robot/model.xml'), { status: 200, error: null, paths: needs })
  assert.deepEqual(await files('model=robot/model.xml&xml=out/nope.xml'), { status: 200, error: null, paths: needs }, 'a snapshot that is not there is ignored')
  // A snapshot is read in place of the model, and resolves against the model's directory.
  write(join(ws, 'out', 'snap.xml'), '<mujoco><asset><mesh file="snapmesh.obj"/></asset></mujoco>')
  assert.deepEqual(await files('model=robot/model.xml&xml=out/snap.xml'), { status: 200, error: null, paths: [...needs, 'out/snap.xml', 'robot/meshes/snapmesh.obj'].sort() })
  write(join(ws, 'out', 'locked.xml'), '<mujoco><asset><mesh file="snapmesh.obj"/></asset></mujoco>')
  chmodSync(join(ws, 'out', 'locked.xml'), 0o000)
  assert.deepEqual(await files('model=robot/model.xml&xml=out/locked.xml'), { status: 200, error: null, paths: [...needs, 'out/locked.xml'].sort() }, 'an unreadable snapshot adds nothing of its own')

  assert.deepEqual(await files('model=menagerie/bot/scene.xml'), { status: 200, error: null, paths: ['menagerie/bot/assets/part.obj', 'menagerie/bot/bot.xml', 'menagerie/bot/scene.xml', 'menagerie/bot/skin.png'] })
  assert.deepEqual(await files('model=robot/gone.xml'), { status: 404, error: 'robot/gone.xml does not exist', paths: [] })
  write(join(ws, 'robot', 'locked.xml'), '<mujoco><include file="parts/leg.xml"/></mujoco>')
  chmodSync(join(ws, 'robot', 'locked.xml'), 0o000)
  assert.deepEqual(await files('model=robot/locked.xml'), { status: 200, error: null, paths: ['robot/locked.xml'] }, 'a model that cannot be read needs only itself, as far as anyone can tell')
  for (const query of ['', 'model=', `model=${encodeURIComponent('../secret.txt')}`]) {
    const r = await viewer.get(`/api/files?${query}`)
    assert.equal(r.status, 400, query)
    assert.deepEqual(JSON.parse(r.body.toString()), { error: 'no model' })
  }
})

test('the model picker: Menagerie robots by name, and the MJCF in the workspace', async () => {
  clear()
  write(join(ws, 'scenes', 'a.xml'), MJCF('a'))
  write(join(ws, 'd1', 'd2', 'd3', 'ok.xml'), MJCF('ok'))
  write(join(ws, 'd1', 'd2', 'd3', 'd4', 'deep.xml'), MJCF('deep'))
  write(join(ws, 'node_modules', 'n.xml'), MJCF('n'))
  write(join(ws, 'out', 'o.xml'), MJCF('o'))
  write(join(ws, '.git', 'g.xml'), MJCF('g'))
  write(join(ws, 'data', 'not.xml'), '<robot/>')
  write(join(ws, 'readme.md'), MJCF('md'))
  write(join(ws, 'locked', 'l.xml'), MJCF('l'))
  chmodSync(join(ws, 'locked'), 0o000)
  let models = await viewer.json('/api/models')
  assert.deepEqual(models.robots, [{ path: 'menagerie/arm/arm.xml', name: 'arm' }, { path: 'menagerie/bot/scene.xml', name: 'bot' }])
  assert.deepEqual(models.scenes.map((s) => s.path).sort(), ['d1/d2/d3/ok.xml', 'scenes/a.xml'])
  assert.deepEqual(models.scenes[0], { path: models.scenes[0].path, name: models.scenes[0].path })

  // Enough is enough: once 40 are found, no further directory is read.
  clear()
  for (let i = 0; i < 45; i++) {
    write(join(ws, 'many-a', `a${i}.xml`), MJCF(`a${i}`))
    write(join(ws, 'many-b', `b${i}.xml`), MJCF(`b${i}`))
  }
  models = await viewer.json('/api/models')
  assert.equal(models.scenes.length, 45, 'one folder, then the list is full')
})

test('a model\'s whole directory, for a model whose MJCF the scan could not follow', async () => {
  clear()
  for (const rel of ['kit/model.xml', 'kit/mesh.OBJ', 'kit/tex.jpeg', 'kit/readme.md', 'kit/.hidden.obj', 'kit/node_modules/x.obj', 'kit/out/y.obj',
    'kit/sub/z.stl', 'kit/deep/1/2/3/4/5/near.obj', 'kit/deep/1/2/3/4/5/6/far.obj', 'kit/ro/p.obj']) write(join(ws, rel), 'x')
  symlinkSync(join(ws, 'kit', 'model.xml'), join(ws, 'kit', 'link.obj'))
  chmodSync(join(ws, 'kit', 'ro'), 0o444)
  const list = async (query) => (await viewer.json(`/api/list${query}`)).files.map((f) => f.path).sort()
  assert.deepEqual(await list('?dir=kit'), ['kit/deep/1/2/3/4/5/near.obj', 'kit/mesh.OBJ', 'kit/model.xml', 'kit/sub/z.stl', 'kit/tex.jpeg'])
  assert.deepEqual(await list('?dir=menagerie/bot'), ['menagerie/bot/assets/part.obj', 'menagerie/bot/bot.xml', 'menagerie/bot/scene.xml', 'menagerie/bot/skin.png'])
  const robots = await list('?dir=menagerie')
  assert.deepEqual(robots.filter((p) => !p.startsWith('menagerie/big/')), ['menagerie/arm/arm.xml', 'menagerie/bot/assets/part.obj', 'menagerie/bot/bot.xml', 'menagerie/bot/scene.xml', 'menagerie/bot/skin.png'], 'the Menagerie root itself')
  assert.deepEqual(await list('?dir=nope'), [])
  const everything = await list('')
  assert.ok(everything.includes('kit/model.xml'))
  assert.deepEqual(await list(`?dir=${encodeURIComponent('../..')}`), everything, 'a directory above the workspace lists the workspace, never its parent')
  assert.ok(everything.every((p) => !p.startsWith('..')))

  // At most a few thousand files: past 4000 no further directory is read. (In the Menagerie, which
  // is not watched, so eight thousand new files do not flood the change feed the next test reads.)
  for (const half of ['a', 'b']) {
    mkdirSync(join(menagerie, 'big', half), { recursive: true })
    for (let i = 0; i < 4001; i++) writeFileSync(join(menagerie, 'big', half, `${i}.obj`), '')
  }
  assert.equal((await list('?dir=menagerie/big')).length, 4001)
  removeTree(join(menagerie, 'big'))
})

test('the change feed: the workspace paths that changed, in batches, not the noise, with a keep-alive', async () => {
  clear()
  const alias = await viewer.events('/events')
  assert.equal(alias.status, 200)
  assert.equal(alias.headers['content-type'], 'text/event-stream')
  assert.ok(await alias.until((b) => b.includes(': hello')), 'the stream opens with a hello')
  alias.close()

  const feed = await viewer.events('/api/events')
  assert.match(await feed.until((b) => b.startsWith('retry: 1000')), /: hello/)
  await new Promise((r) => setTimeout(r, 300)) // let the clear() above go by
  write(join(ws, 'node_modules', 'x', 'index.js'), 'x')
  write(join(ws, '.git', 'HEAD'), 'ref')
  write(join(ws, 'out', 'frame.tmp'), 'x')
  write(join(ws, 'out', 'frame.xml~'), 'x')
  write(join(ws, 'out', '.frame.xml.swp'), 'x')
  write(join(ws, 'out', 'a.json'), '{}')
  write(join(ws, 'out', 'b.json'), '{}')
  const block = await feed.until((b) => changedPaths(b)?.includes('out/b.json'))
  assert.ok(block, 'the change is heard')
  await new Promise((r) => setTimeout(r, 400))
  const heard = feed.blocks.flatMap((b) => changedPaths(b) ?? [])
  assert.ok(heard.includes('out/a.json'))
  for (const noise of ['node_modules/x/index.js', '.git/HEAD', 'out/frame.tmp', 'out/frame.xml~', 'out/.frame.xml.swp']) assert.ok(!heard.includes(noise), noise)
  assert.ok(heard.every((p) => p && !/node_modules|\.git(\/|$)/.test(p)), heard.join(' '))
  assert.ok(await feed.until((b) => b === ': ping'), 'a keep-alive ping')
  feed.close()
  assert.equal((await viewer.get('/')).status, 200, 'a closed stream is forgotten')
})
