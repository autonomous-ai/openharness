# ledger-export

Exports a month's invoices from `data/invoices.json` to CSV for the finance team.

```sh
npm run export -- 2026-10   # writes exports/invoices-2026-10.csv
npm test
```

Exported files hold customer data, so they stay out of git.
