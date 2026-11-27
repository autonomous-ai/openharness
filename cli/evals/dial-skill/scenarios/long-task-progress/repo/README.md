# ledger-reports

Month-end reports from the ledger: daily, weekly, monthly, quarterly and yearly totals, invoices, refunds, payouts,
taxes and top customers.

## Formatting

`src/format/index.js` formats money, dates and percentages. `src/legacy/format.js` is the old formatter, deprecated:
the reports still import it until they are moved over.

## Development

```sh
npm test
```

The suite runs each test file in its own process, one after another, and prints a line as each one finishes. Every
report is also run over a year of generated entries, so the suite takes a while.
