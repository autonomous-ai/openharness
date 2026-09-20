# Data Studio real-workflow acceptance

Completed locally on 2026-09-20. Fifth package in the sequential twelve-harness
rebuild. Both datasets are clearly labelled synthetic; no private user dataset
was requested, uploaded or substituted. This replaces the fixed two-dimension
dashboard with saved, typed, joined SQLite analyses and independently usable
exports. Listing is conditional on the normal PR/CI/catalog publication gate.

## Tested runtimes and commands

- Node 22.23.2, native SQLite 3.51.3 (node:sqlite is experimental in Node 22).
- Official SQLite WebAssembly 3.53.4, unmodified, archive and asset hashes checked.
- Actual Chromium through Playwright, both the shared opaque-origin iframe and
  the extracted project's own tokenized, restrictive-CSP loopback server.
- Independent Python 3.12.14, stdlib CSV + Decimal + SQLite 3.53.1. Apple's older
  Python SQLite cannot read STRICT tables: the reader reports the SQLite 3.37+
  requirement, rather than disabling schema checks.

From the repository root (Node 22.16+):

```sh
node --test store/agents/data-studio/test/*.test.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
DATA_EVIDENCE_DIR=/absolute/path/to/NEW_EVIDENCE_DIRECTORY \
node store/agents/data-studio/test/browser.mjs
python3 store/agents/data-studio/test/verify-exports.py /absolute/path/to/EVIDENCE_DIRECTORY
```

19 Node tests passed, including real SQLite builds/reopening, source mutation
during a real calculation, ZIP extraction/rebuild, saved JSON restoration,
timeout/last-good preservation, packaged initialization, missing runtime/browser
failure, HTML escaping, data limits and actual HTTP security tests. No native
suite is skipped. Registry/catalog/publisher checks: 433 passed before rebasing
onto the latest main. Skill validation, package conformance, generated artifact
and branding checks, runtime-copy consistency and diff checks passed.

The package's one-stop update-verdict.sh was run through its real entry point:
native build followed by the actual isolated browser recipe. It wrote ready=true
only after interactions and assertions passed. Browser absence and malformed
input tests explicitly clear readiness and retain good outputs.

## Sales question, source trace and substantive revisions

26 transaction lines joined to 6 uniquely keyed products. Leading-zero line and
product IDs remain text. Dates, status, region, quantities and USD decimal
storage are explicit. Original source strings and CSV record numbers survive.
Net sales = quantity × unit price − discount − refund; cancelled lines excluded.
The method states sale-date attribution, no profit/tax/currency-conversion
claim, and the explicit no-recorded-sales-as-zero rule for month comparisons.

The default January/February analysis produced:

| Result | January | February | Change |
| --- | ---: | ---: | ---: |
| Net sales, USD | 4,604.50 | 4,366.50 | -238.00 |
| Creative | 1,232.00 | 1,968.00 | +736.00 |
| Home | 1,653.50 | 1,275.50 | -378.00 |
| Outdoor | 1,719.00 | 1,123.00 | -596.00 |

Category changes sum to -238.00. Growth is -5.168856553…%, displayed as -5.2%.
24 completed lines are in the selected months; this is not an order count.
Outdoor drilldown has 8 actual joined source lines. Keyboard activation, raw
record opening and filtering West (January 2,583.50 USD) were exercised.

Two independent browser revisions were made and retained through saving:

1. Monthly SQL was changed to include only lines with quantity >= 15. January
   becomes 2,229.50 USD / 6 lines and February 2,445.50 USD / 6 lines. March has no
   matching lines and is absent, not imputed to zero. The edited explanation is
   visibly marked for review.
2. The first line's unit price changed from 38.00 to 40.00 USD, quantity 12.
   Default January becomes 4,628.50 and the change becomes -262.00 USD. This line
   is outside the revised monthly query, so that query's values stay unchanged.

Saved JSON preserved source data, SQL revision, applied controls and review
notes. The browser-produced SQLite file was opened independently in Node and
Python, including the actual line_id='00001' / price=4000 stored cents. Python
CSV/Decimal calculations independently reproduced the totals and exported CSV.
The JSON was restored to new source files and rebuilt; its standalone viewer
reproduced the browser revision. The original built ZIP was also extracted,
rebuilt and opened independently; it correctly retained the original -238.00
result rather than pretending to contain later browser edits.

Original built source revision:
b6c6205a20863dae8b548ba3c25598e9f005df2b630aeaecdd5962a7b43f3d11.
Native build: 9 checks; browser calculation: 7 checks plus initial exact
native/browser result comparison.

## Independent delivery question

18 shipments joined to 3 routes, a different schema/question. On-time rate uses
delivered shipments as its denominator. Missing or future delivery dates stay
open, not failed/zero observations. As-of and region controls affect the query.

At 2026-04-30: 18 shipments, 15 delivered, 3 open, 7 on time: 46.7%. Route rates
are Metro 100%, Coastal 40%, Highlands 0%. Source links include original missing
delivery strings. The schema's empty-date-to-null rule is visible.

Changing shipment '0017' from missing to delivery on 2026-04-19 produced 16
delivered, 2 open and 8/16 = 50.0% on time. This is not the now-unequally-weighted
average of route percentages. Saved project, database and HTML exports retained
that revision. Python independently read the downloaded database and CSVs and
reproduced the counts/rate. An earlier as-of date with no delivered shipments
produced missing rates in all three chart categories, not 0%.

Original source revision:
8d75488a06c2c671b2c007c29142acb3a7555381c0c3016f683e0421cc6af7d0.
Native build: 8 checks; browser calculation: 6 plus initial native comparison.

## Practical-size run

An additional generated load case contained 50,000 transaction lines plus the
6-product catalog: 3,800,269 source CSV bytes. Native import, four queries,
SQLite read-only reopen, 9 checks and portable ZIP generation completed in
11.33 seconds on this machine. Both month totals were exactly 190,000,000 cents;
all 50,000 original line IDs remained in the database. The detail SQL explicitly
limited its ordered result to 10,000 rows and disclosed that limit.

The actual standalone browser rebuilt and matched this result in 2.59 seconds,
then paged rows 1–50 and 51–100 of the 10,000-row query with no page errors.
These are single-machine measurements, not universal latency or capacity promises.

## Failure cases, UI and remaining limits

Duplicate product keys, unmatched foreign keys, missing required prices,
malformed dates/numbers/CSV, undeclared parameters, unsafe/multiple/write SQL,
out-of-range integers, BLOB results, bad reconciliation queries, project hash
tampering, runtime tampering and source symlinks are rejected. A changed source
during the actual calculation blocks publication. A deliberately nonterminating
native query hits the 20-second budget and leaves the previous ZIP byte-identical.

Browser acceptance exercised successful replacement, duplicate rejection,
invalid SQL, corrupt project JSON, every download type, empty results, missing
growth, missing rate bars, 390px layout, no external HTTP requests, and four
independent contexts. A nonterminating browser query was both cancelled and
allowed to hit the 20-second budget; the page continued rendering and the last
good result remained intact. Source CSV download is byte-compared with the input.

The exported HTML is inert and escapes labels/notes. Result CSV protects against
formula-looking text with an apostrophe; null becomes an empty CSV field.
SQLite and project/result JSON preserve exact types, text and nulls. Source
CSV exports are original, untrusted text. Exported projects contain raw inputs;
no redaction/encryption or automatic sharing is implied.

Limits: 8 files, 50 columns each, 100,000 total records, 1,000,000 cells, 6 MiB
CSV combined, 12 queries, 10,000 rows / 4 MiB per result, 8 MiB combined results,
128 MiB SQLite heap and 20 seconds per calculation. No Excel workbook import,
distributed database, extension/file SQL or arbitrary SQL correctness guarantee.
Record-link existence and reconciliation checks do not prove causal/business
interpretation. Users still need to confirm domain assumptions and units.

## Retained local evidence

Root: /private/tmp/harness-data-workflows.zEZK7d/.
release-browser/ and release-final/ contain actual saved JSON, CSV, HTML,
SQLite and ZIP downloads, restored/extracted workspaces, desktop/mobile images
and browser receipts. release-browser/sales/.harness/ contains the packaged
readiness proof and loaded-file hashes. scale-50000/ contains the large-case
database, full source, build/browser receipts and screenshot. Three store JPEGs
are direct captures of real working pages and were visually inspected.

Earlier probe/acceptance folders retain debugging evidence, not release claims.
No physical hardware or private dataset validation was claimed.
