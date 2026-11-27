import { request as http } from '../http.js'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createLoyaltyClient(request = http) {
  return {
    getPoints(memberId) {
      const path = `/loyalty/members/${memberId}/points`
      // One more try after a short pause: the loyalty service restarts often and is back within a moment.
      return request('GET', path)
        .catch((error) => {
          if (error.status !== undefined && error.status < 500) throw error
          return pause(100).then(() => request('GET', path))
        })
        .then((row) => row.points)
    },
  }
}
