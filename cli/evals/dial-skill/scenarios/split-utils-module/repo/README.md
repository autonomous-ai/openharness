# shop-admin

The back office of the shop: the catalog, orders, customers, daily reports and receipt emails.

## Layout

- `src/products/`, `src/orders/`, `src/customers/`: the shop's records and what staff do with them.
- `src/reports/`: the daily sales report and its CSV export.
- `src/emails/`: the receipt sent after an order.
- `src/utils.js`: helpers for strings, dates and money (amounts are whole cents).

## Development

```sh
npm test
```
