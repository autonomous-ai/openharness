/** Discovery hints never grant creation authority; the primary receipt is read again before preparation. */
export interface PendingCreationPage {
  cursor: string
  ids: string[]
  done: boolean
  damaged: number
}

export interface PendingCreationDiscovery {
  ensure(id: string): Promise<void>
  scan(): AsyncGenerator<string | null>
}
