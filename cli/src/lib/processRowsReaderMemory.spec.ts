import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

// The fake ps is a POSIX script; Windows uses the installed native source instead.
it.skipIf(process.platform === 'win32')('retained reader identities release both raw native outputs', () => {
  const module = new URL('./processTable.ts', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict';
    import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import { getHeapSnapshot } from 'node:v8';
    import { setImmediate } from 'node:timers/promises';
    const root = mkdtempSync(join(tmpdir(), 'ps-reader-memory-'));
    try {
      process.env.HARNESS_FIXTURE_PROCESS_ROWS = join(root, 'rows');
      process.env.HARNESS_FIXTURE_COMMAND_ROWS = join(root, 'paths');
      process.env.PATH = root + ':' + process.env.PATH;
      writeFileSync(join(root, 'ps'), '#!/bin/sh\\ncase "$2" in "pid=,lstart=,comm=") exec /bin/cat "$HARNESS_FIXTURE_COMMAND_ROWS";; *) exec /bin/cat "$HARNESS_FIXTURE_PROCESS_ROWS";; esac\\n', { mode: 0o700 });
      const pid = 0x7ffffffe, command = '/fixture/long-name/engine', cut = command.slice(0, 16);
      const start = 'Fri Nov 20 12:00:00 2026', args = 'engine --owned-reader';
      function prepare() {
        const row = n => n + ' 1 ' + cut + ' ' + start + ' ' + args + '\\n';
        const path = n => n + ' ' + start + ' ' + command + '\\n';
        // Each output fits the actual execFile limit; unrelated bulk is never returned as a row.
        writeFileSync(process.env.HARNESS_FIXTURE_PROCESS_ROWS,
          'QA_PROCESS_READER_ROWS ' + 'x'.repeat(800 * 1024) + '\\n' + row(pid) + row(process.pid));
        writeFileSync(process.env.HARNESS_FIXTURE_COMMAND_ROWS,
          'QA_PROCESS_READER_PATHS ' + 'y'.repeat(800 * 1024) + '\\n' + path(pid) + path(process.pid));
      }
      prepare();
      const { processRows, createDeletedImageMemo } = await import(${JSON.stringify(module)});
      globalThis.deletedImages = createDeletedImageMemo({ exists: () => false });
      async function identity() {
        const rows = await processRows(pid);
        assert.equal(rows.length, 1);
        const row = rows[0];
        globalThis.deletedImages.remember(row, '/fixture/deleted-engine');
        return { pid: row.pid, executable: row.executable, startMarker: row.startMarker,
          args: row.args, ...(row.commandPath && { commandPath: row.commandPath }) };
      }
      globalThis.retainedIdentity = await identity();
      assert.deepEqual(globalThis.retainedIdentity, { pid, executable: cut, startMarker: start, args,
        ...(process.platform === 'darwin' && { commandPath: command }) });
      assert.equal(globalThis.deletedImages.recall(globalThis.retainedIdentity), '/fixture/deleted-engine');
      // Exclude V8's unrelated last-successful-RegExp input from the ownership check.
      /cleared/.exec('cleared');
      for (let i = 0; i < 3; i++) { await setImmediate(); globalThis.gc(); }
      let data = '';
      for await (const chunk of getHeapSnapshot()) data += chunk;
      const heap = JSON.parse(data), fields = heap.snapshot.meta.node_fields, width = fields.length;
      const ti = fields.indexOf('type'), ni = fields.indexOf('name'), si = fields.indexOf('self_size');
      const types = heap.snapshot.meta.node_types[ti];
      let retainedBytes = 0;
      for (let i = 0; i < heap.nodes.length; i += width) {
        if (types[heap.nodes[i + ti]] === 'string'
          && heap.strings[heap.nodes[i + ni]].startsWith('QA_PROCESS_READER_')
          && heap.nodes[i + si] > 64 * 1024) retainedBytes += heap.nodes[i + si];
      }
      console.log(JSON.stringify({ retainedBytes }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  `
  const output = execFileSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, NODE_OPTIONS: '' }, maxBuffer: 1024 * 1024,
  })
  expect((JSON.parse(output.trim()) as { retainedBytes: number }).retainedBytes).toBe(0)
}, 25_000)
