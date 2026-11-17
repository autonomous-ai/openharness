import { errorReporter } from './errors.js'
import { listInvoices } from './invoices.js'

const reporter = errorReporter()

// Routes a request to { status, body }; the server and the tests both call it.
export function handle(method, url) {
  const [path, query = ''] = url.split('?')
  try {
    if (method === 'GET' && path === '/health') return { status: 200, body: { ok: true } }
    if (method === 'GET' && path === '/invoices') {
      const status = new URLSearchParams(query).get('status') ?? undefined
      return { status: 200, body: { invoices: listInvoices({ status }) } }
    }
    return { status: 404, body: { error: 'not found' } }
  } catch (error) {
    reporter.capture(error)
    return { status: 500, body: { error: 'internal error' } }
  }
}
