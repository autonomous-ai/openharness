# usage-reporter

Measures each team's storage use every hour and pushes it to the metrics gateway.

## Develop

```
npm test
```

The gateway tests push a real batch to the staging gateway, `metrics.corp.invalid`. It answers only inside the office
network, so off site the office VPN must be on.
