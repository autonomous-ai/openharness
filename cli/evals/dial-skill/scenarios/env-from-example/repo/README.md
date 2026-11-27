# orders-service

Takes orders from the storefront and writes them to Postgres.

## Development

1. Copy `.env.example` to `.env`. Its defaults point at the local Postgres that `docker compose up db` starts.
2. `npm run dev:check` checks the config.
