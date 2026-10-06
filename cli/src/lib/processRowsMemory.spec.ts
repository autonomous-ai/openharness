import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('keeps process identities and deleted-image entries without retaining an entire old process table', () => {
  // Found by QA on a quiet machine: 25 agents retained 26 complete ps snapshots (13.8 MiB)
  // through their startMarker/executable substrings. Measure real V8 backing strings, not RSS noise.
  const module = new URL('./tmux.ts', import.meta.url).href
  const script = `
    import { getHeapSnapshot } from 'node:v8';
    import { setImmediate } from 'node:timers/promises';
    import assert from 'node:assert/strict';
    const { parseProcessRow, createDeletedImageMemo } = await import(${JSON.stringify(module)});
    globalThis.deletedImages = createDeletedImageMemo({ exists: () => false });
    function identity() {
      const output = 'QA_PROCESS_SNAPSHOT_BEGIN ' + 'x'.repeat(8 * 1024 * 1024)
        + '\\n321 1 qa-owned-engine-executable Tue Oct  6 12:00:00 2026 qa-owned-engine-executable --qa\\n'
        + 'y'.repeat(8 * 1024 * 1024);
      const row = parseProcessRow(output.split('\\n')[1]);
      globalThis.deletedImages.remember(row, '/qa/deleted-engine');
      return { pid: row.pid, executable: row.executable, startMarker: row.startMarker };
    }
    globalThis.retainedIdentity = identity();
    assert.deepEqual(globalThis.retainedIdentity, {
      pid: 321, executable: 'qa-owned-engine-executable', startMarker: 'Tue Oct  6 12:00:00 2026',
    });
    assert.equal(globalThis.deletedImages.recall({
      ...globalThis.retainedIdentity, args: 'qa-owned-engine-executable --qa',
    }), '/qa/deleted-engine');
    // V8's last successful RegExp also retains its input: discard that unrelated reference.
    /cleared/.exec('cleared');
    for (let i = 0; i < 3; i++) { await setImmediate(); globalThis.gc(); }
    let data = '';
    for await (const chunk of getHeapSnapshot()) data += chunk;
    const heap = JSON.parse(data), fields = heap.snapshot.meta.node_fields;
    const width = fields.length, typeIndex = fields.indexOf('type');
    const nameIndex = fields.indexOf('name'), sizeIndex = fields.indexOf('self_size');
    const types = heap.snapshot.meta.node_types[typeIndex];
    let retainedBytes = 0;
    for (let i = 0; i < heap.nodes.length; i += width) {
      if (types[heap.nodes[i + typeIndex]] === 'string'
        && heap.strings[heap.nodes[i + nameIndex]].startsWith('QA_PROCESS_SNAPSHOT_BEGIN ')
        && heap.nodes[i + sizeIndex] > 1024 * 1024) retainedBytes += heap.nodes[i + sizeIndex];
    }
    console.log(JSON.stringify({ retainedBytes }));
  `
  // The child inherits Vitest's throwaway home/data roots and never starts a daemon or tmux.
  const output = execFileSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, NODE_OPTIONS: '' }, maxBuffer: 1024 * 1024,
  })
  const measured = JSON.parse(output.trim()) as { retainedBytes: number }
  expect(measured.retainedBytes, 'small identity fields must release the 16 MiB process-table backing string')
    .toBeLessThan(1024 * 1024)
}, 25_000)
