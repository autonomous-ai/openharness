const COLLECTOR = 'https://telemetry.invalid/v1/events'

// Production drops a failed send; anywhere else it throws, so a broken event shows up at once.
export async function track(event, fields) {
  if (process.env.TELEMETRY === 'off') return
  let failure
  try {
    const response = await fetch(COLLECTOR, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, ...fields }),
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) failure = `HTTP ${response.status}`
  } catch (error) {
    failure = error.cause?.code ?? error.message
  }
  if (failure && process.env.NODE_ENV !== 'production') {
    throw new Error(`telemetry: cannot send "${event}" to telemetry.invalid: ${failure}`)
  }
}
