/**
 * Fills a test's own small volume, for the full-disk tests (e2e/diskfull.e2e.ts, e2e/updateHostile.e2e.ts). One
 * helper because their two copies had drifted: one let a full volume's refusal to create the tail fail the test
 * (nightly run 43247147594, updateHostile.e2e.ts). It appends, so a caller can top up a volume that got room back.
 */
import { closeSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** Writes until the volume refuses, and returns the filler, to free the space again by removing it. */
export function fillVolume(volume: string): string {
  const filler = join(volume, 'filler')
  appendUntilFull(filler, Buffer.alloc(1024 * 1024, 7))
  // The last blocks a metadata write may still find: take those too.
  appendUntilFull(join(volume, 'filler-tail'), Buffer.alloc(4096, 7))
  return filler
}

/** On a full volume even the open may be refused: that is full too, not an error. */
function appendUntilFull(path: string, chunk: Buffer): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'a')
    for (;;) writeSync(fd, chunk)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
