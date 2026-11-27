import { isAbsolute } from 'node:path'

/** The path admitted by launch requests and display placeholders, without opening the folder. */
export function validProjectPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
}
