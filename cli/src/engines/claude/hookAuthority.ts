import type { HookContract } from '../facets/hooks.js'

/** Mandatory hook admission and turn rules; no installer or native configuration parser. */
export const hookAuthority = {
  sessionFile: { suffix: '.jsonl' },
  stopClosesTurns: true
} satisfies Omit<HookContract, 'settings'>
