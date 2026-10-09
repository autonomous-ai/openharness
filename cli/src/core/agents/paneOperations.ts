/** The short pane dispatch and registry commit belong to core, never to a service preparation. */
export function createPaneOperations() {
  const pending = new Map<string, Promise<unknown>>()
  const runMany = async <T>(agentIds: readonly string[], operation: () => Promise<T>): Promise<T> => {
    if (agentIds.some(id => pending.has(id))) throw new Error('A pane operation is already changing this harness')
    const work = Promise.resolve().then(operation)
    for (const id of agentIds) pending.set(id, work)
    try { return await work } finally { for (const id of agentIds) pending.delete(id) }
  }
  return {
    busy: (agentId: string): boolean => pending.has(agentId),
    pending: (agentId: string): Promise<unknown> | undefined => pending.get(agentId),
    runMany,
    run: <T>(agentId: string, operation: () => Promise<T>): Promise<T> => runMany([agentId], operation),
    // Stop sets its cancellation flag first, then joins only a dispatched pane's commit before
    // capturing the pane it must close. It never joins Store/models preparation or an engine watch.
    settle: async (agentId: string): Promise<void> => { await pending.get(agentId) },
  }
}
