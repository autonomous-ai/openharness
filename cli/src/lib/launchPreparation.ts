import type { CreationAuthority } from './agentCreationReceipt.js'

/** Persist `label` with the request before doing any preparation. Retries and a
 * reconstructed core must keep the same workspace, config and runtime keys. */
export interface LaunchAuthority extends CreationAuthority { readonly label: string }

export type LaunchPreparation<Result> =
  | { ok: true; dispatch: () => Promise<Result> }
  | { ok: false; error: string; detail?: string; unavailable?: string }
