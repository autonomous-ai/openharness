---
name: graphql-resolvers
description: "Use when writing GraphQL schema types and resolvers: batches database access with a loader to avoid N+1 queries, checks authorization in each resolver, limits query depth and cost, and returns errors the client can tell apart."
---

Design the schema from what clients read, not from the tables. Load related records through a per-request batching loader. Check access in the resolver for each field that needs it. Set depth and complexity limits. Test resolvers through queries against the schema.
