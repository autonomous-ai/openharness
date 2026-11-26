# Moving to the new logger

`lib/logger-v1.js` writes printf-style text lines, which the log pipeline cannot index. `lib/logger.js` writes one
JSON record per event. Move every package in `packages/` to it, then delete `lib/logger-v1.js`.

## In each package

1. Import `createLogger` from `lib/logger.js` and make the package's logger once, named after its folder:
   `const log = createLogger('billing')`.
2. Every call becomes `log.<level>(event, fields)`: `event` is a snake_case name for what happened, `fields` a plain
   object holding the values, each under a name.

   | Old | New |
   |---|---|
   | `log.info('charged %s %d cents', id, cents)` | `log.info('charged', { customer: id, cents })` |
   | ``log.warn(`retrying ${url}`)`` | `log.warn('retrying', { url })` |
   | `log.error('could not parse', err)` | `log.error('parse_failed', { error: err })` |
   | `log.debug('cache state', { size })` | `log.debug('cache_state', { size })` |
   | `const log = scoped('[mailer]')` | `const log = createLogger('mailer')` |
   | `timed('resize', () => work())` | time it with `performance.now()` and log the event with `{ ms }` |

3. Run `npm test`. The new logger throws on a call in an old shape, so a missed call fails its package's tests.

`lib/logger.js` itself stays as it is: the pipeline's schema depends on its records.
