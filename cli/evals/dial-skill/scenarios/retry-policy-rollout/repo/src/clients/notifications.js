import { request as http } from '../http.js'

async function retrying(fn, times) {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (error) {
      const transient = error.status === undefined || error.status === 429 || error.status >= 500
      if (i >= times || !transient) throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * i))
    }
  }
}

export function createNotificationsClient(request = http) {
  return {
    preferences: (userId) => retrying(() => request('GET', `/users/${userId}/notification-preferences`), 3),
    devices: (userId) => retrying(() => request('GET', `/users/${userId}/devices`), 2),
  }
}
