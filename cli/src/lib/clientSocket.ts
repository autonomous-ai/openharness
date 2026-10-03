/** Minimal transport used by command clients. No feature implementation belongs here. */
export interface ClientSocket {
  send(data: string): void
  close(): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: { toString(): string }) => void): unknown
  on(event: 'close', listener: (code: number, reason: { toString(): string }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}
