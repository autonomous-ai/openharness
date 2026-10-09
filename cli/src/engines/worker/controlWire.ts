/** Common bounds for private control messages. Each facet separately validates its payload. */
export const CONTROL_BYTES = 1024 * 1024
export const controlFields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every(key => names.includes(key))
export const controlToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const controlSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= CONTROL_BYTES
export function controlEnvelope(payload: Record<string, unknown>, version: number, names: string[]): boolean {
  return payload.version === version && controlFields(payload, ['version', 'requestId', ...names])
    && (payload.requestId === undefined || (typeof payload.requestId === 'string' && payload.requestId.length <= 200)) && controlSize(payload)
}
