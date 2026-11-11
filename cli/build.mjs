import * as esbuild from 'esbuild'
import { readdirSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
import { readDshRegistry } from './scripts/lib/dshRegistry.mjs'
import { readBuiltinBundle, readHarnessMonitorBundle, readMemoriesBundle, readModelManagerBundle } from './scripts/lib/modelManagerBundle.mjs'
import { fileURLToPath } from 'node:url'
const modelManagerBundle = JSON.stringify(readModelManagerBundle(fileURLToPath(new URL('../store/agents/autonomous-grid', import.meta.url))))
const devicesBundle = JSON.stringify(readBuiltinBundle(fileURLToPath(new URL('../store/agents/devices', import.meta.url)), ['harness.json', 'AGENTS.md', 'LICENSE', 'template']))
const harnessMonitorBundle = JSON.stringify(readHarnessMonitorBundle(fileURLToPath(new URL('../store/agents/harness-monitor', import.meta.url))))
const memoriesBundle = JSON.stringify(readMemoriesBundle(fileURLToPath(new URL('../store/agents/memories', import.meta.url))))

// Bake the version in so `node dist/cli.js version` works in the dev/per-file build too (parity with
// build-bundle.mjs). The bundle build overrides this from ADAPTER_VERSION at release time.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
// The bundled registry (the store/ folders and store/registry at the repo root) — see src/dsh/registry.ts.
const dshRegistry = JSON.stringify(readDshRegistry(join('..', 'store')))

function getAllTsFiles(dir, fileList = []) {
  const files = readdirSync(dir)

  files.forEach((file) => {
    const filePath = join(dir, file)
    if (statSync(filePath).isDirectory()) {
      getAllTsFiles(filePath, fileList)
    } else if (file.endsWith('.ts')) {
      fileList.push(filePath)
    }
  })

  return fileList
}

const entryPoints = getAllTsFiles('src')

try {
  await esbuild.build({
    entryPoints,
    outdir: 'dist',
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    outExtension: { '.js': '.js' },
    define: {
      __ADAPTER_VERSION__: JSON.stringify(version),
      __DSH_REGISTRY__: JSON.stringify(dshRegistry),
      __MODEL_MANAGER_BUNDLE__: JSON.stringify(modelManagerBundle),
      __DEVICES_BUNDLE__: JSON.stringify(devicesBundle),
      __HARNESS_MONITOR_BUNDLE__: JSON.stringify(harnessMonitorBundle),
      __MEMORIES_BUNDLE__: JSON.stringify(memoriesBundle),
      // The guest helper and its sudoers drop-in (src/lib/guestHelperAssets.ts): the installed CLI is cli.js alone.
      __GUEST_HELPER__: JSON.stringify(readFileSync('assets/guest-helper/guest-helper.sh', 'utf8')),
      __GUEST_SUDOERS__: JSON.stringify(readFileSync('assets/guest-helper/sudoers', 'utf8')),
      // The agent browser's image files (src/services/agentBrowser/assets.ts) and its tool list (src/lib/browserToolsAsset.ts).
      __BROWSER_CONTAINERFILE__: JSON.stringify(readFileSync('assets/browser/Containerfile', 'utf8')),
      __BROWSER_ENTRYPOINT__: JSON.stringify(readFileSync('assets/browser/entrypoint.sh', 'utf8')),
      __BROWSER_POLICY__: JSON.stringify(readFileSync('assets/browser/policy.json', 'utf8')),
      __BROWSER_TOOLS_JSON__: JSON.stringify(readFileSync('assets/browser/browser-tools.json', 'utf8')),
      __BROWSER_TOOLS__: JSON.stringify(readFileSync('assets/browser/browser-tools.mjs', 'utf8')),
      __BROWSER_TOOLS_LIB__: JSON.stringify(readFileSync('assets/browser/browser-tools-lib.mjs', 'utf8')),
      __BROWSER_SOCKS5__: JSON.stringify(readFileSync('assets/browser/socks5.mjs', 'utf8')),
      __BROWSER_HUMAN_INPUT__: JSON.stringify(readFileSync('assets/browser/human-input.mjs', 'utf8')),
      __BROWSER_CHALLENGE__: JSON.stringify(readFileSync('assets/browser/challenge.mjs', 'utf8')),
      __BROWSER_PROXY_RELAY__: JSON.stringify(readFileSync('assets/browser/proxy-relay.mjs', 'utf8')),
      __BROWSER_DEVICE_INJECT__: JSON.stringify(readFileSync('assets/browser/device-inject.mjs', 'utf8')),
      // Claude Code's status line script (src/engines/kit/statusLine.ts), which a launch writes into the data folder.
      __STATUS_LINE_SCRIPT__: JSON.stringify(readFileSync('hook/statusline.mjs', 'utf8')),
    },
    logLevel: 'info',
  })

  console.log('✓ Build completed successfully')
} catch (error) {
  console.error('✗ Build failed:', error)
  process.exit(1)
}
