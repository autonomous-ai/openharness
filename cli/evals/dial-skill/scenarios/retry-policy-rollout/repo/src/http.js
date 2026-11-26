// Every client talks to the API through this one function, so a test can hand a client a fake instead.
const BASE = 'https://api.shop.invalid/v2'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export async function request(method, path, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new HttpError(response.status, `${method} ${path}: ${response.status}`)
  return response.status === 204 ? null : response.json()
}
