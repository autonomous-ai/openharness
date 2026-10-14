import type { BuildResult } from 'esbuild'
export function buildNativeHook(options: { outDir: string; processImages?: string; version: string }): Promise<BuildResult<{ metafile: true }>>
