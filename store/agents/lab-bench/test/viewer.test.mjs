import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, cp, rm, readFile, readdir, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {request} from 'node:http';
import {createBenchViewer} from '../viewer/viewer.mjs';
import {approveProtocol} from '../template/studio/design.mjs';
const pkg = fileURLToPath(new URL('..', import.meta.url));

test('source saves retain history, reject stale/foreign writes and protect approved protocol', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'signal-viewer-')), root = join(scratch, 'workspace');
  await cp(join(pkg, 'template'), root, {recursive: true}); process.env.LAB_DSH_DIR = pkg;
  const server = await createBenchViewer(root); await new Promise(r => server.listen(0, '127.0.0.1', r)); const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const get = () => fetch(url + '/api/project').then(r => r.json()), before = (await get()).project, next = approveProtocol(before); next.title = 'A real source edit';
    const put = (p, origin = url, revision = before.revision) => fetch(url + '/api/project', {method: 'PUT', headers: {origin, 'content-type': 'application/json', 'if-match': revision}, body: JSON.stringify(p)});
    assert.equal((await put(next, 'https://foreign.example')).status, 403); assert.equal((await put(next)).status, 200);
    const saved = (await get()).project; assert.equal(saved.title, next.title); assert.equal(saved.approved, true);
    const previous = JSON.parse(await readFile(join(root, '.harness/history', (await readdir(join(root, '.harness/history')))[0]), 'utf8')); assert.equal(previous.title, before.title); assert.equal(previous.approved, false);
    assert.equal((await put(before)).status, 409); const changed = {...saved, protocol: {...saved.protocol, unit: 'A different experimental unit'}};
    assert.equal((await put(changed, url, saved.revision)).status, 400); assert.equal((await get()).project.revision, saved.revision);
    assert.equal((await fetch(url + '/files/.harness/history')).status, 404); await symlink('/etc/passwd', join(root, 'outside')); assert.equal((await fetch(url + '/files/outside')).status, 404);
    assert.match(await fetch(url).then(r => r.text()), /A real source edit/);
    // Hold the first body open while a second writer arrives. Acquire the lock before parsing.
    const body = JSON.stringify({...saved, title: 'First concurrent writer'}); let finish;
    const bodyStarted = new Promise(resolve => server.once('request', resolve));
    const pending = new Promise((resolve, reject) => {const req = request(url + '/api/project', {method: 'PUT', headers: {origin: url, 'content-type': 'application/json', 'if-match': saved.revision}}, res => {res.resume(); res.on('end', () => resolve(res.statusCode));}); req.on('error', reject); req.write(body.slice(0, 40)); finish = () => req.end(body.slice(40));});
    await bodyStarted; const second = await put({...saved, title: 'Second concurrent writer'}, url, saved.revision); finish();
    assert.equal(second.status, 409); assert.equal(await pending, 200); assert.equal((await get()).project.title, 'First concurrent writer');
  } finally {server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(scratch, {recursive: true, force: true});}
});
test('build and check execute through actual symlinked workspace paths', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'signal-entry-')), root = join(scratch, 'real'), link = join(scratch, 'shortcut');
  await cp(join(pkg, 'template'), root, {recursive: true}); await symlink(root, link, 'dir');
  const env = {...process.env, LAB_DSH_DIR: pkg};
  try {
    const built = JSON.parse(execFileSync(process.execPath, [join(link, 'tools/build.mjs')], {cwd: link, env, encoding: 'utf8'})); assert.equal(built.title, 'Clearwater Coffee');
    const checked = JSON.parse(execFileSync(process.execPath, [join(link, 'tools/check.mjs')], {cwd: link, env, encoding: 'utf8'})); assert.equal(checked.runs, 15); assert.equal(checked.measured, 0); assert.equal(checked.repeated, true);
    assert.equal(JSON.parse(await readFile(join(root, '.harness/verdict.json'), 'utf8')).ready, false);
    const report = JSON.parse(await readFile(join(root, '.harness/lab-check.json'), 'utf8')); assert.equal(report.planned.rank, 4); assert.equal(report.sourceHashesVerified, 0);
  } finally {await rm(scratch, {recursive: true, force: true});}
});
