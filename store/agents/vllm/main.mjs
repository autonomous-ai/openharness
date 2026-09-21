import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './src/server.mjs';
import { VllmAdapter, VLLM_PROFILE } from './src/vllm.mjs';
const packageRoot = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(process.env.HARNESS_WORKSPACE || packageRoot);
const adapter = new VllmAdapter({ packageRoot, dataDir: join(workspace, '.harness') });
await start(Number(process.env.HARNESS_VIEWER_PORT || process.env.HARNESS_PORT || 4312), { workspaceRoot: workspace, assetRoot: join(packageRoot, 'dist'), profile: VLLM_PROFILE, adapter });
