/** `promise`, or a rejection with `timeout` after `ms`: for a call whose own client sets no limit that holds. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}
