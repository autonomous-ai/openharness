import * as esbuild from 'esbuild'

/** Both CLI layouts ship the same entry; no source checkout or node_modules
 * is available when an engine executes its installed hook command. */
export function buildNativeHook({ outDir, processImages, version }) {
  return esbuild.build({
    entryPoints: ['src/nativeHookEntry.ts'], outfile: `${outDir}/notify.mjs`,
    bundle: true, platform: 'node', format: 'esm', target: 'node20', metafile: true,
    define: { __HARNESS_BUNDLED_HOOK__: 'true',
      __DARWIN_PROCESS_IMAGES__: processImages ? JSON.stringify(processImages) : 'undefined' },
    banner: { js: `#!/usr/bin/env node\n// harness-native-hook-protocol:1\n// harness-native-hook-darwin:${processImages ? 1 : 0}\n// harness-native-rearm-witness:1\n// harness-native-pane-witness:1\n/*! harness v${version} - Copyright (c) 2026 Autonomous, Inc. - MIT (https://github.com/autonomous-ai/openharness) */` },
    legalComments: 'eof', logLevel: 'info',
  })
}
