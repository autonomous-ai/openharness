/** Native delivery time survives retries; arrival order only orders requests this core already saw. */
export interface AdmissionOrder {
  scope: string
  firedAt: number | undefined
  arrival: number
}

export function compareAdmissionOrder(a: AdmissionOrder, b: AdmissionOrder): number {
  return a.firedAt !== undefined && b.firedAt !== undefined ? a.firedAt - b.firedAt : a.arrival - b.arrival
}

/** Only verified acceptance advances this process-incarnation watermark, never a delegated child. */
export function createAdmissionOrder() {
  const accepted = new Map<string, { id: string; order: AdmissionOrder }>()
  return {
    observe(key: string, scope: string, binding: { id: string; at: number | null } | undefined): void {
      if (!binding?.id) return
      const last = accepted.get(key)
      // A persisted binding protects a restarted core too. A changed binding made
      // outside this queue is newer authority than its previous watermark.
      if (!last || last.order.scope !== scope || last.id !== binding.id) {
        accepted.set(key, { id: binding.id, order: { scope, firedAt: binding.at ?? undefined, arrival: 0 } })
      }
    },
    status(key: string, id: string, order: AdmissionOrder): 'current' | 'older' | 'ambiguous' {
      const last = accepted.get(key)
      if (!last || last.order.scope !== order.scope || last.id === id) return 'current'
      if (order.firedAt !== undefined && last.order.firedAt !== undefined) {
        return order.firedAt < last.order.firedAt ? 'older' : order.firedAt === last.order.firedAt ? 'ambiguous' : 'current'
      }
      // A late headerless delivery is not evidence that another conversation is newer.
      return order.arrival <= last.order.arrival ? 'older' : 'ambiguous'
    },
    accept(key: string, id: string, order: AdmissionOrder): void {
      const last = accepted.get(key)
      if (!last || last.order.scope !== order.scope
        || ((order.firedAt !== undefined || last.order.firedAt === undefined) && compareAdmissionOrder(order, last.order) > 0)) {
        accepted.set(key, { id, order })
      }
    },
    close(): void { accepted.clear() },
  }
}
