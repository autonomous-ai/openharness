import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {serve} from '../skills/freecad/scripts/serve-handoff.mjs';

test('handoff server exposes only generated downloads on loopback', async () => {
  const work = await mkdtemp(join(tmpdir(), 'freecad-downloads-'));
  let server;
  try {
    await mkdir(join(work, 'handoff/parts'), {recursive:true});
    await writeFile(join(work, 'handoff/index.html'), '<h1>Saved handoff</h1>');
    await writeFile(join(work, 'handoff/project.zip'), 'fixture zip');
    await writeFile(join(work, 'design.json'), 'private inputs');
    await symlink(join(work, 'design.json'), join(work, 'handoff/parts/escape.svg'));
    server = await serve(work);
    assert.equal(server.address().address, '127.0.0.1');
    const url = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(url + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Saved handoff/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const zip = await fetch(url + '/handoff/project.zip');
    assert.equal(zip.headers.get('content-disposition'), 'attachment; filename="project.zip"');
    assert.equal(await zip.text(), 'fixture zip');
    for (const path of ['/design.json', '/handoff/../design.json', '/.harness/build.log', '/handoff/parts/escape.svg', '/handoff/parts/', '/%ZZ']) {
      assert.equal((await fetch(url + path)).status,404,path);
    }
    assert.equal((await fetch(url + '/', {method:'POST'})).status,405);
    assert.equal(await (await fetch(url + '/', {method:'HEAD'})).text(),'');
    const status = await new Promise((resolve,reject) => {
      const req = request(url, {headers:{host:'untrusted.example'}}, res => { res.resume(); resolve(res.statusCode); });
      req.on('error',reject); req.end();
    });
    assert.equal(status,403);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(work, {recursive:true, force:true});
  }
});
