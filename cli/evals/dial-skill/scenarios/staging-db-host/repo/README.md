# orders-api

Takes the shop's orders and keeps them in Postgres.

```
npm test
npm start                     # APP_ENV picks config/<env>.json, development by default
npm run db:ping -- <env>      # connects to that environment's database
```

## Databases

Each environment's database is in `config/<env>.json`. Ops run the staging and production databases. When they move
one to a new host, they announce the host in the #ops channel and retire the old one; hosts are never guessed from a
naming pattern, because a wrong guess can point staging at another team's database.
