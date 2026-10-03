// Test process only: isolate every default engine/profile directory without changing the caller's
// HOME or CODEX_HOME. Load before the daemon's ESM imports capture os.homedir.
const os = require('node:os');
const { basename, dirname } = require('node:path');
const { realpathSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const root = realpathSync(process.env.HARNESS_SHARE_TEST_HOME || '');
if (process.env.NODE_ENV !== 'test' || !basename(dirname(root)).startsWith('harness-share-e2e-')) {
  throw new Error('Sharing fixture requires its own temporary home.');
}
os.homedir = () => root;
syncBuiltinESMExports();
