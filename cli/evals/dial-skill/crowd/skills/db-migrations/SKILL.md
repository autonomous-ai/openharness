---
name: db-migrations
description: "Use when adding or changing a database schema: writes forward and backward migrations, keeps each one small and reversible, avoids locking large tables, and splits a column rename or type change into expand, backfill and contract steps across releases."
---

One migration per change, named by date and intent. Add columns as nullable or with a default, backfill in batches, and only then add constraints. Never rename in place on a large table; add the new column, write to both, move the reads, then drop the old one. Run the down migration locally before committing.
