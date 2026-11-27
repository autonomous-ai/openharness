// Sends errors to Sentry when SENTRY_DSN is set; without it, errors reach only the log.
export function errorReporter(env = process.env) {
  if (!env.SENTRY_DSN) {
    console.warn('SENTRY_DSN not set, error reporting disabled')
    return { capture: (error) => console.error(error) }
  }
  const dsn = new URL(env.SENTRY_DSN)
  const endpoint = `${dsn.protocol}//${dsn.host}/api${dsn.pathname}/store/`
  return {
    capture(error) {
      console.error(error)
      // A failed report must never fail the request that hit the error.
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${dsn.username}`,
        },
        body: JSON.stringify({ message: error.message, level: 'error' }),
      }).catch(() => {})
    },
  }
}
