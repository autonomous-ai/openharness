import { readFile } from 'node:fs/promises'
import type { RuntimeControl } from '../facets/runtime.js'

/** Optional native configuration: an unreadable file contributes no text. */
export async function readRuntimeText(file: string): Promise<string> {
  try { return await readFile(file, 'utf8') } catch { return '' }
}

export function confirmObserved(control: RuntimeControl | undefined, model: string, effort: string): void {
  if (!control || control.target.model !== model || control.target.effort !== effort) return
  control.modelConfirmed = true
  control.effortConfirmed = true
}
