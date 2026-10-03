import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureReleaseAssets, releaseAssetBase } from './harness-web-assets.mjs';

// This package hosts the compiled app; its only source is desktop/ in the same repository.
// Release builds pass the bundle CI just built via HARNESS_WEB_ARCHIVE (see Dockerfile.k8s and
// .github/workflows/release-web.yml); local builds download the pinned release instead.
const root = fileURLToPath(new URL('../', import.meta.url));
const release = JSON.parse(await readFile(path.join(root, 'harness-web-release.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(release.version) ||
    !/^[a-f0-9]{40}$/.test(release.sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    release.baseHref !== '/harness-web/' ||
    release.archiveUrl !== `https://github.com/autonomous-ai/openharness/releases/download/v${release.version}_web/harness-web-${release.version}.tar.gz`) {
  throw new Error('Invalid Harness web release manifest');
}

let bytes;
if (process.env.HARNESS_WEB_ARCHIVE) {
  bytes = await readFile(process.env.HARNESS_WEB_ARCHIVE);
} else {
  const response = await fetch(release.archiveUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Harness web download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) {
  throw new Error('Harness web archive checksum mismatch');
}

const temporary = await mkdtemp(path.join(tmpdir(), 'harness-web-'));
try {
  const archive = path.join(temporary, 'bundle.tar.gz');
  const extracted = path.join(temporary, 'extracted');
  await writeFile(archive, bytes);
  await mkdir(extracted);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (entries.some(entry => path.posix.isAbsolute(entry) || entry.split('/').includes('..'))) {
    throw new Error('Harness web archive contains an unsafe path');
  }
  execFileSync('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', extracted]);
  const metadata = JSON.parse(await readFile(path.join(extracted, 'release.json'), 'utf8'));
  const index = await readFile(path.join(extracted, 'index.html'), 'utf8');
  if (metadata.version !== release.version || metadata.sourceCommit !== release.sourceCommit ||
      metadata.baseHref !== release.baseHref || !index.includes('<base href="/harness-web/">')) {
    throw new Error('Harness web archive does not match its release manifest');
  }
  const entry = configureReleaseAssets(index, release);
  const versioned = path.join(temporary, 'versioned');
  await cp(extracted, versioned, { recursive: true });
  const versionedDestination = path.join(extracted, releaseAssetBase(release).slice('/harness-web/'.length));
  await mkdir(path.dirname(versionedDestination), { recursive: true });
  await rename(versioned, versionedDestination);
  // Retain legacy paths for tabs opened before this deployment. New entries
  // load JavaScript, fonts and CanvasKit exclusively from the archive namespace.
  await writeFile(path.join(extracted, 'index.html'), entry);
  const destination = path.join(root, 'public/harness-web');
  await rm(destination, { recursive: true, force: true });
  await rename(extracted, destination);
  console.log(`Prepared Harness Web ${release.version} (${release.sourceCommit.slice(0, 12)})`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
