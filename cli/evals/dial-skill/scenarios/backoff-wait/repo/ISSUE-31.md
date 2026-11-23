# ISSUE-31: Retry a check before paging

On-call was paged 14 times last week for blips that were gone a second later.

## Ask

- `uptime-check --retries <n> <url>...` tries a URL that is down up to `n` more times before it counts as down. Without
  the flag, it tries once, as today.
- A test covers the flag.

## Backoff between tries

- **Fixed 1 s**: simple; a check that stays down takes `n` seconds longer to page.
- **Exponential, 1 s then 2 s then 4 s**: kinder to a struggling service, but a long outage pages later.

Not decided yet. It changes how fast on-call hears about an outage, so it is the on-call lead's call.
