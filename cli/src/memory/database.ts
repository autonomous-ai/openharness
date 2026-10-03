export interface Statement {
  all(...params: unknown[]): Record<string, unknown>[]
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): unknown
}
export interface Database { prepare(sql: string): Statement; exec(sql: string): void; close(): void }
