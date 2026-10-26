import { cp, mkdtemp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveDirectory } from './move-directory.mjs';

// The source is on another disk (a runner's /tmp); renames beside the destination still work.
const crossDevice = async (source, target) => {
  if (source !== from) return rename(source, target);
  throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
};
let scratch, from, to;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'move-directory-'));
  from = path.join(scratch, 'extracted');
  to = path.join(scratch, 'public', 'harness-web');
  await mkdir(path.join(from, 'assets'), { recursive: true });
  await writeFile(path.join(from, 'index.html'), '<base href="/harness-web/">');
  await writeFile(path.join(from, 'assets', 'FontManifest.json'), '[]');
  await mkdir(path.dirname(to));
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

async function expectMoved() {
  expect(await readFile(path.join(to, 'index.html'), 'utf8')).toBe('<base href="/harness-web/">');
  expect(await readFile(path.join(to, 'assets', 'FontManifest.json'), 'utf8')).toBe('[]');
  await expect(stat(from)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('moveDirectory', () => {
  it('renames within one filesystem', async () => {
    await moveDirectory(from, to);
    await expectMoved();
  });
  it('copies, then removes the source, when the rename crosses filesystems (a runner whose /tmp is another disk)', async () => {
    await moveDirectory(from, to, { rename: crossDevice });
    await expectMoved();
  });
  it('leaves no half-written destination when the copy fails partway', async () => {
    const copyThenFail = async (source, target, options) => {
      await cp(path.join(source, 'index.html'), path.join(target, 'index.html'), options);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    await expect(moveDirectory(from, to, { rename: crossDevice, cp: copyThenFail })).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(stat(to)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.dirname(to))).toEqual([]);
    expect(await readFile(path.join(from, 'index.html'), 'utf8')).toBe('<base href="/harness-web/">');
  });
  it('does not hide any other rename failure', async () => {
    const denied = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    await expect(moveDirectory(from, to, { rename: denied })).rejects.toMatchObject({ code: 'EACCES' });
    expect(await readFile(path.join(from, 'index.html'), 'utf8')).toBe('<base href="/harness-web/">');
    await expect(stat(to)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
