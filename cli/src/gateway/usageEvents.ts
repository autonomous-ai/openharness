/**
 * The usage report's counters for what the core tells of its requests (core/api.ts `UsageEvent`, core/usageOutcomes.ts):
 * named here, in the gateway, with the backend's vocabulary (lib/productUsageSignals.ts), which the core's process no
 * longer loads (the core audit of 2026-11-12, section 2). The names and totals are the ones the core counted itself before
 * (gateway/usageEvents.spec.ts holds them side by side): each event goes through the same reductions, unchanged, as they
 * ran in the core. An answer runs its request's reduction again with its start not counted twice, and its clock set to
 * the time the core measured, so the gateway keeps nothing between a request and its answer, and a gateway that
 * restarted in between counts the answer as the one before it would have.
 */
import type { UsageEvent } from '../core/api.js'
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
import { messageReceipt, productObservation, productUsageIntent, productUsageLaunch, productUsageRequest, productUsageSource,
  type ProductUsageLaunchSignal } from '../lib/productUsageSignals.js'
import type { MessageOutcome } from '../lib/sessionInput.js'

export function countUsage(event: UsageEvent, counter: (metric: ProductUsageMetric) => void, launch: (signal: ProductUsageLaunchSignal) => void): void {
  if (event.kind === 'observed') {
    for (const metric of productObservation(event.payload)) counter(metric)
    return
  }
  const { request } = event
  const source = productUsageSource(request.local, request.tool, request.role, request.phone ? { usageSurface: 'phone' } : undefined)
  const launching = (emit: (signal: ProductUsageLaunchSignal) => void) => productUsageLaunch(request.type, request.creationId, emit,
    request.engine, request.agentStarted === true, request.hachiStarted === true)
  if (event.kind === 'request') {
    launching(launch)
    productUsageRequest(request.type, counter, Date.now, source, request.userAction === true)
    productUsageIntent(request.type, request.interactive ? 'interactive' : undefined, request.agentId, source, launch)
    return
  }
  // The request's reductions again, counting nothing of its start: that was counted as it came.
  let answering = false
  let clock = 0
  const measured = productUsageRequest(request.type, (metric) => { if (answering) counter(metric) }, () => clock, source, request.userAction === true)
  const launched = launching((signal) => { if (answering) launch(signal) })
  answering = true
  clock = event.elapsedMs
  const { answer } = event
  if (answer.message !== undefined) {
    if (event.first) messageReceipt(measured)(answer.message as MessageOutcome)
    return
  }
  if (event.first) measured(answer.error, answer.state, answer.hasAgent === true, answer.ok, undefined, answer.preparation)
  // The agent frame itself: a created launch's agent is watched until it starts (gateway/productUsage.ts).
  launched(answer.error, answer.state, answer.agent, answer.held)
}
