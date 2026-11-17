# shop-admin

Back office for the shop: customers, orders and refunds. It runs from this checkout on the office server, and its data
lives in `data/store.json` (backed up nightly).

## Migrations

`db/migrations/` changes the shape of the store, one file per change, run in order by `npm run migrate`.
`npm run migrate:status` lists the ones that have not run yet.

To clean up, fold the migrations into one `0000_baseline.js` that builds the current shape, once every migration has
run.

## Data owners

A column that someone else relies on has an owner, and the owner must agree before a migration drops it.

| Column | Owner | Why |
|---|---|---|
| `customers.legacy_notes` | Support | notes imported from the old helpdesk, still read when a customer calls |
