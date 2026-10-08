/** The wire shape of a machine list. State and persistence belong to the gateway. */
export function guestMachineList(computerId: string, name: string, hostname: string): Record<string, unknown> {
  return { success: true, data: { machines: [{ machineId: computerId, computerId, name, hostname,
    status: 'online', authMode: 'remote' }], stale: false, guest: true } }
}

/**
 * Tag a cached machine-list body as stale, where the client actually reads it.
 *
 * The backend answers `{success:true,data:{…}}` and this daemon forwards that verbatim, so the flag has
 * to go INSIDE `data` — a local client unwraps to `data` and would never see a top-level field. Older
 * shapes that return the machines at the top level get it there instead.
 */
export function withStaleMarker(body: Record<string, unknown>, fetchedAt: number): Record<string, unknown> {
  const marker = { stale: true, staleSince: new Date(fetchedAt).toISOString() }
  const data = body.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...body, data: { ...(data as Record<string, unknown>), ...marker } }
  }
  return { ...body, ...marker }
}

