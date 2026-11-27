# partner-gateway

Front door for partner API traffic: authenticates partner webhooks and enforces each partner's rate limit.

Partner quotas live in `config/partners.yml`. After editing it, run `npm run check:config`; the deploy refuses a
config that does not pass.
