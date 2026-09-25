/**
 * Down-frames the backend mints for an adapter, which a client must never be able to forge.
 *
 * The `__` prefix already marks most of these; these predate that convention and are not prefixed, so
 * each client socket that relays frames down (`webWs`, its legacy apiKey path, `deviceWs`) has to refuse
 * them by name. The adapter refuses them too unless they arrive on the backend's own `connId: ''`.
 *
 * Senders, all backend-side: `lib/adapterWs.ts` (on connect), `services/MachineService.ts`
 * (rename, revoke) and `lib/adapterAccountPushes.ts` (desk_changed, machines_changed — forged, each
 * one makes every window on that computer re-read from this backend).
 */
export const BACKEND_ONLY_DOWN_TYPES = new Set(['machine_meta', 'machine_revoked', 'desk_changed', 'machines_changed'])

/** A type no client may send down: the backend's own `__` control frames and the named ones above. */
export function isBackendOnlyDownType(type: unknown): boolean {
  return typeof type === 'string' && (type.startsWith('__') || BACKEND_ONLY_DOWN_TYPES.has(type))
}
