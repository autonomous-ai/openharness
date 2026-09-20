import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './src/server.mjs';
import { MlxAdapter, MLX_PROFILE } from './src/mlx.mjs';
const packageRoot = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(process.env.HARNESS_WORKSPACE || packageRoot);
const adapter = new MlxAdapter({ packageRoot, dataDir: join(workspace, '.harness') });
await start(Number(process.env.HARNESS_VIEWER_PORT || process.env.HARNESS_PORT || 4311), { workspaceRoot: workspace, assetRoot: join(packageRoot, 'dist'), profile: MLX_PROFILE, adapter });
