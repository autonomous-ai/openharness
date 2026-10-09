/** Small validators shared by aggregate readers and frame projections. */
import { isAbsolute } from 'node:path'
export const validWorkPath = (v: unknown): v is string =>
  typeof v === 'string' && isAbsolute(v) && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v)
export const validPullRequestUrl = (v: unknown): v is string => typeof v === 'string'
  && /^https:\/\/github\.com\/[\w-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(v)
  && new URL(v).href === v && Number.isSafeInteger(Number(v.split('/').at(-1)))
