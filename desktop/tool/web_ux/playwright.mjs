// Playwright is not a dependency of this repository. Install it once anywhere
// (`pnpm --dir <folder> add playwright`) and point PLAYWRIGHT_DIR at that
// folder; without it, Node's normal lookup is used.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const from = process.env.PLAYWRIGHT_DIR
  ? createRequire(join(process.env.PLAYWRIGHT_DIR, 'package.json'))
  : createRequire(import.meta.url);

export const { chromium, devices } = from('playwright');
