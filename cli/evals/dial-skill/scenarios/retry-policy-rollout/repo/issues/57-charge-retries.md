# 57: Retry failed charges?

Status: open

`charge` in `src/clients/payments.js` tries a charge again only when the connection was refused, as the provider never
got it then. When the provider times out, checkout shows "Payment failed" and the customer pays again by hand; support
sees a few of these every week.

The provider's v2 API takes no idempotency key. A charge that timed out may still have gone through, so retrying it
can charge the card twice. Their v3 API accepts an `Idempotency-Key` header, but moving payments to v3 is a project of
its own. Meanwhile `withRetry` retries no POST that comes without a key.

Options:

- Keep charges' own retry after a refused connection, outside `withRetry`.
- Send charges once, with no retry.
- Move charges to v3 first, then retry them through `withRetry` with a key.

Not decided yet. Priya (payments) owns this and has not picked one.
