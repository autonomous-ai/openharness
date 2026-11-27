# billing-api

The billing service's HTTP API: invoices and a health check.

## Running

```sh
npm start                    # listens on PORT, 8080 by default
node src/server.js --check   # prints the /health response and exits; the container health check runs it
```

Settings come from the environment; `.env.example` lists them.

## Error reporting

Errors go to Sentry when `SENTRY_DSN` is set. The DSN is in the billing project's settings at
`https://sentry.acme.invalid`; the platform team grants access. Without it the service logs a warning at start and
runs with error reporting off.

## Development

```sh
npm test
```
