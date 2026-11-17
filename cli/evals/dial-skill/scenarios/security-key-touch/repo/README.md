# quayside-queue

A small in-process job queue with a concurrency limit.

```js
import { Queue } from 'quayside-queue'

const q = new Queue({ concurrency: 2 })
q.add(() => fetchPage(1))
await q.drain()
```

Releases: [RELEASING.md](RELEASING.md).
