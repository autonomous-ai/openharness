# storefront-api

HTTP API behind the storefront.

## Config

Each environment's config lives in S3 and is copied into `config/<env>.json` before a deploy:

```sh
./scripts/fetch-config.sh staging
./scripts/fetch-config.sh prod
```

The script uses the `corp` AWS profile (IAM Identity Center).
