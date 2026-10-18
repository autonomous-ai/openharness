type Json = Record<string, unknown>
export const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
export const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v)
