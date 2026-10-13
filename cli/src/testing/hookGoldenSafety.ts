/** Corrections to unsafe former file operations, without rewriting their goldens.
 * Healthy bytes and logs still compare with the recorded former implementation. */
import { expect } from 'vitest'

type File = { type: string; mode?: string; text?: string; target?: string }
export type HookFiles = Record<string, File>

/** Atomic publication now preserves file modes, leaf aliases and pre-existing
 * temporary files. Apply those explicit ownership changes to the former result. */
export function preservedHookFiles(before: HookFiles, former: HookFiles): HookFiles {
  const expected = structuredClone(former)
  for (const [path, entry] of Object.entries(before)) {
    if (entry.type === 'file' && expected[path]?.type === 'file') expected[path].mode = entry.mode
    if (path.endsWith('.<pid>.tmp')) expected[path] = entry
    if (entry.type === 'link' && expected[path]?.type === 'file') {
      const target = entry.target!.replace('<root>/', '')
      expected[target] = { ...expected[path], mode: before[target].mode }
      expected[path] = entry
    }
  }
  return expected
}

/** An old basename-only ownership guess could erase these commands. The new
 * installation must retain every foreign command and still add the recorded
 * canonical hooks, without changing unrelated settings. */
export function expectForeignHooksPreserved(before: HookFiles, after: HookFiles, former: HookFiles, file: string): void {
  const prior = JSON.parse(before[file].text!), actual = JSON.parse(after[file].text!), canonical = JSON.parse(former[file].text!)
  for (const [key, value] of Object.entries(prior)) if (key !== 'hooks') expect(actual[key]).toEqual(value)
  for (const [event, blocks] of Object.entries(prior.hooks ?? {})) {
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (Array.isArray(block.hooks)) {
        const foreign = block.hooks.filter((hook: { command?: string }) => !hook.command?.startsWith('<command '))
        if (foreign.length) expect(actual.hooks[event]).toContainEqual({ ...block, hooks: foreign })
      } else expect(actual.hooks[event]).toContainEqual(block)
    }
  }
  for (const [event, blocks] of Object.entries(canonical.hooks ?? {})) {
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (typeof block.command === 'string' && block.command.startsWith('<command ')) expect(actual.hooks[event]).toContainEqual(block)
      else if (Array.isArray(block.hooks) && block.hooks.some((hook: { command?: string }) => hook.command?.startsWith('<command '))) {
        expect(actual.hooks[event]).toContainEqual(block)
      }
    }
  }
  expect(after[file].mode).toBe(before[file].mode)
}
