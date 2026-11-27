# cart-service

Prices shopping carts: line totals, the bulk discount and sales tax. Carts of 10 or more items get 5% off.

## Development

```sh
npm test
```

## Telemetry

Each checkout sends an event to the collector at `https://telemetry.invalid/v1/events`, which is reachable only from
the production network. Outside production a failed send throws, so a broken event shows up at once. Set
`TELEMETRY=off` to turn telemetry off; CI runs the tests with `TELEMETRY=off`.
