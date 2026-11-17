export class Queue {
  #concurrency
  #running = 0
  #waiting = []
  #idle = []

  constructor({ concurrency = 1 } = {}) {
    this.#concurrency = concurrency
  }

  get size() {
    return this.#waiting.length
  }

  add(job) {
    return new Promise((resolve, reject) => {
      this.#waiting.push({ job, resolve, reject })
      this.#next()
    })
  }

  clear() {
    this.#waiting = []
  }

  drain() {
    if (this.#running === 0 && this.#waiting.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.#idle.push(resolve))
  }

  #next() {
    while (this.#running < this.#concurrency && this.#waiting.length > 0) {
      const { job, resolve, reject } = this.#waiting.shift()
      this.#running++
      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          this.#running--
          this.#next()
          if (this.#running === 0 && this.#waiting.length === 0) for (const done of this.#idle.splice(0)) done()
        })
    }
  }
}
