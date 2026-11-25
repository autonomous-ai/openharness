import { readFile } from 'node:fs/promises'
import { settingsText } from '../../lib/settingsText.js'
import type { RuntimeControl } from '../facets/runtime.js'

/**
 * Optional native configuration, past a BOM a Windows tool saved (lib/settingsText.ts): an unreadable file, or one
 * that is not UTF-8, contributes no text.
 */
export async function readRuntimeText(file: string): Promise<string> {
  try { return settingsText(await readFile(file)) } catch { return '' }
}

export function confirmObserved(control: RuntimeControl | undefined, model: string, effort: string): void {
  if (!control || control.target.model !== model || control.target.effort !== effort) return
  control.modelConfirmed = true
  control.effortConfirmed = true
}
