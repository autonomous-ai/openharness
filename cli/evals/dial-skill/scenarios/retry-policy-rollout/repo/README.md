# shop-api-clients

Clients for the shop's internal API (`https://api.shop.invalid/v2`), one per service in `src/clients/`. Each client
takes a `request` function (`src/http.js` by default), so its tests hand it a fake.

The clients were written over a few years, and each retries failed calls in its own way. `src/retry.js` holds the
shared retry helper, `withRetry`, written to replace those loops.

```
npm test
```
