// One GET. A network error or a 5xx is down; any other status is the site answering.
export async function check(url, { fetch = globalThis.fetch } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return { up: res.status < 500, status: res.status }
  } catch (error) {
    return { up: false, status: null, error: error.cause?.code ?? error.name }
  }
}
