/**
 * The Model Manager's grid commands' handshake (`grid_fleet_capabilities`): which protocol they speak and
 * the longest a command may run. The socket answers it while the commands themselves are the models
 * service's (`gridFleetRpc.ts`, services/models.ts), so a Grid harness asking while models is down hears
 * the command refused, never "update Harness" (core/api.ts `MODELS_REQUESTS`).
 */
export const GRID_FLEET_PROTOCOL = 1
export const GRID_FLEET_MAX_TIMEOUT_MS = 30 * 60_000
