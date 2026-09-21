import { access, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const dir = fileURLToPath(new URL('.', import.meta.url));
export async function browserPath({ install = false } = {}) {
  const candidates = [process.env.BROWSER_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  for (const path of candidates) { try { await access(path); return path; } catch {} }
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(dir, 'browsers');
  const { chromium } = await import('./node_modules/playwright-core/index.mjs');
  const path = chromium.executablePath();
  try { await access(path); return path; } catch {}
  if (!install) throw new Error('Browser missing. Run the Game Master setup script.');
  execFileSync(process.execPath, [join(dir, 'node_modules/playwright-core/cli.js'), 'install', 'chromium'], { stdio: 'inherit', env: process.env });
  await access(path); return path;
}
if (process.argv.includes('--install')) console.log(`ok   export browser: ${await browserPath({ install: true })}`);
if (process.argv.includes('--check')) console.log(`ok   export browser: ${await browserPath()}`);
