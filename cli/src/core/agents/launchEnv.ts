/** The pane's session environment: the grid's or the profile's, with the DSH's layered on top. */
export function mergedLaunchEnv(
  base: Record<string, string> | undefined,
  dsh: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !dsh) return undefined
  return { ...(base ?? {}), ...(dsh ?? {}) }
}
