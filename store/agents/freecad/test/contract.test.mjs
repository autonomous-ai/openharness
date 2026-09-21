import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('saved design schema, explicit source allowlist and portable report', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('contract_test.py', import.meta.url))], {encoding:'utf8'});
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.match(result.stderr, /Ran 9 tests/);
});
