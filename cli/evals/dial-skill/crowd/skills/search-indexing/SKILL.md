---
name: search-indexing
description: "Use when adding or changing full-text search: defines the index mapping and analyzers per language, keeps the index in step with the database through an outbox or change stream, reindexes behind an alias without downtime, and tests ranking with a fixed set of queries."
---

Decide which fields are searched, which are filtered and which are only returned, and map each accordingly. Feed the index from committed changes so it never sees data that rolled back. Build a new index beside the old and switch the alias. Keep a list of queries with their expected top results as a test.
