/** Captured before lean/full entry dispatch rewrites argv to the canonical CLI helper path. */
export interface ExecutedEntry { file: string; sha256: string; admitted: boolean }
let entry: ExecutedEntry | undefined
export function rememberExecutedEntry(value: ExecutedEntry): void { entry ??= Object.freeze({ ...value }) }
export function executedEntry(): ExecutedEntry | undefined { return entry }
