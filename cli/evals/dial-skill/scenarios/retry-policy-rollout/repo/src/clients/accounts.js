import { request as http } from '../http.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createAccountsClient(request = http) {
  async function get(path) {
    let lastError
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await request('GET', path)
      } catch (error) {
        lastError = error
        if (error.status !== undefined && error.status < 500 && error.status !== 429) throw error
        if (attempt < 2) await sleep(50)
      }
    }
    throw lastError
  }

  return {
    getAccount: (id) => get(`/accounts/${id}`),
    getProfile: (id) => get(`/accounts/${id}/profile`),
  }
}
