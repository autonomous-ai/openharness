# billing

Issues the monthly invoices for each customer's plan.

```
npm test
```

Plans are in `src/plans.js`; how long each plan's invoices have until they are due is in `src/terms.js`.

The Enterprise plan is new. Its payment terms are whatever the signed contract says; Sales keeps the contract, and
it is not in this repo.
