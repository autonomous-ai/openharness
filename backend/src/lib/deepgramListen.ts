// The one place a Deepgram listen URL is built, so no request can leave without the opt-out.
// A leaf module: it opens no connection, so deepgramWav.ts can import it and stay clear of deepgram.ts.

/**
 * `mip_opt_out=true` keeps customer audio out of Deepgram's Model Improvement Program: it never trains
 * their models, and Deepgram keeps it only as long as it needs to process the request.
 */
export function deepgramListenUrl(params: Record<string, string | number | boolean>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) query.set(key, String(value))
  query.set('mip_opt_out', 'true')
  return `https://api.deepgram.com/v1/listen?${query}`
}
