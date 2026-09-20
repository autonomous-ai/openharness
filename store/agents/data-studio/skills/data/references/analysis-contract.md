# Analysis contract and verification

The canonical, executable contract is template/core.js. A workspace carries the
same core.js for Node, the page and its worker. Read analysis.json for a complete
sales example; test/fixtures/delivery is a second, independent question.

## Project files

- analysis.json: spec=1, title, question, example boolean, method, limitations,
  tables, relationships, parameters, queries and checks. Unknown fields fail.
- sources/*.csv: original UTF-8 text. Quoted/multiline fields, BOM and CRLF work.
  Duplicate/blank headers, ragged records, blank records and invalid quoting
  fail. _record is the CSV record number (header=1), not physical line number.
- queries/*.sql: one read-only SELECT/WITH per file. Only named :parameters.
- checks/*.sql: each returns one violations column, one row, exactly zero.
- optional view.json: parameters, selectedQuery and notes. Save project captures
  these settings with sources and SQL in a checksum-bound JSON envelope.

## Types and joins

Each table has an id, file, label, columns and optional key array. Each column
has a safe SQL name, an exact source header, a type and explicit nullable boolean.
Supported types: text, integer, decimal (scale 0–6), real, date (YYYY-MM-DD).
The default missing token is the empty string. Set missing explicitly to change
it. Whitespace is preserved unless trim=true. Extra/unmapped CSV headers fail;
do not silently discard columns or source rows. Integer/scaled-decimal values
must stay within JavaScript's exact integer range. Hex, grouped numbers,
currency symbols and implicit precision rounding are rejected. REAL is binary
floating point, not exact money. All source and result values must be finite.

A relationship declares from/to table and column plus allowMissing. The target
must have a single-column unique, non-null key; key types/scales must agree.
Duplicate keys fail before a join can multiply rows. If unmatched rows are
explicitly allowed, name their treatment in the method and query; inner joins
may otherwise drop them. Many-to-many analysis needs an explicitly prepared
bridge and independent reconciliation, not a claim of many-to-one validation.

## Parameters and queries

Parameters have id, label, type, default, optional text choices and hidden.
Dates and numeric controls are validated before binding. Values never enter SQL
through interpolation. Each query has id, title, file, kind, explanation and
optional formats. Kinds: metric (exactly one result row), bar (explicit x/y,
at most 100 categories), table and detail. Result aliases must be unique.
Every chart plots the returned result values; it does not re-aggregate rates or
invent missing combinations. The query defines ordering. Percent charts include
0–100% as well as any out-of-range values; change charts include zero.

Formats map output aliases to style number/currency/percent/text, optional
positive divisor, digits 0–6 and unit. Currency requires a three-letter code.
Example: cents use {style:"currency",currency:"USD",divisor:100,digits:2}.
Formatting never changes the exported stored numeric value.

A trace has a detail query id and bindings mapping hidden parameter ids to
aggregate result aliases. sourceLinks maps detail result aliases to table ids.
Return the table's actual _record; browser links show the original CSV record.
The build checks existence, but authors must verify that the linked record and
detail filters really support the aggregate. Reconcile the arithmetic with an
independent reader/calculation. Do not present record links as automatic proof
of arbitrary SQL semantics.

## Safety and lifecycle

Only one SELECT/WITH statement is accepted. Writes, PRAGMA, file functions,
extension functions and positional parameters are disabled. Native execution
uses an isolated child process; browser execution uses a disposable in-memory
worker. Both have a 20-second budget and 128 MiB SQLite heap. SQL extensions,
origin storage and network services are not needed.
Source bounds: 8 files, 50 columns each, 100,000 total records, 1,000,000 cells,
6 MiB CSV combined. Result bounds: 12 queries, 10,000 rows / 4 MiB per query,
8 MiB combined. Browser runs can also be cancelled without losing good results.

Builds lock, snapshot declared sources/runtime assets, calculate in staging,
reopen SQLite read-only, rerun every query, compare results, validate links,
hash outputs and verify inputs did not change before publishing. The previous
output is retained in .harness/history. Failed builds clear readiness. Do not
remove a lock unless its recorded process is confirmed stopped.

The standalone server serves an exact file allowlist over a tokenized loopback
URL. There is no write/SQL/upload endpoint. Project source files and queries
are editable through the agent; browser edits persist only through download.
Native file checks and browser proofs do not establish real-world correctness
of user-entered assumptions. Name unverified assumptions and remaining review.
