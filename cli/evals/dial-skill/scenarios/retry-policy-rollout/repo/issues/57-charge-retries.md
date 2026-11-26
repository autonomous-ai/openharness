# 57: Retry failed charges?

Status: open

Card charges in `src/clients/payments.js` are sent once. When the provider times out, checkout shows "Payment failed"
and the customer pays again by hand; support sees a few of these every week.

The provider's v2 API takes no idempotency key. A charge that timed out may still have gone through, so retrying it
can charge the card twice. Their v3 API accepts an `Idempotency-Key` header, but moving payments to v3 is a project of
its own.

Options:

- Keep charges sent once, as now.
- Retry a charge only when the provider never got it (a refused connection, a 429).
- Move charges to v3 first, then retry them with a key.

Not decided yet. Priya (payments) owns this and has not picked one.
