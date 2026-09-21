# Lab Bench — plan, measure, understand, follow up

Published in [PR #155](https://github.com/autonomous-ai/openharness/pull/155). Preserve the original Signal logo/icon and the earlier synthetic viewer under
`store/tools/experiences/lab-bench.*`. The new workshop works with authored experimental plans
and actual user measurements. No synthetic-response generator is part of the product.

The intended delivery is a randomized run sheet, protected protocol, original measurement CSVs,
logged corrections/exclusions, explicit model and design matrix, readable uncertainty/diagnostics,
held-out confirmation runs, portable studio, reports and independently reproducible calculations.
Full factorial designs, numeric/categorical factors, main effects/interactions/quadratics and fixed
blocks are bounded to small continuous-response experiments. Do not imply a generic research engine
or causal inference from arbitrary observational data. A model cannot establish a practical result
before the person carries out the experiment and supplies measured evidence.

Statistical design follows the NIST experimental-design handbook. Numerical tools are pinned
ml-matrix 6.15.0 and jstat 1.9.6, bundled offline with complete notices. Validation must independently
recompute delivered matrices, coefficients, intervals and diagnostics with statsmodels/SciPy;
test unknown/duplicate run ids, raw hashes, missing data, rank/df failures, held-out confirmations,
logged corrections, protocol preservation, source conflicts and actual browser interactions.

The three acceptance briefs are coffee extraction, blocked seedling growth and packaging strength.
Their six delivered editions independently pass statsmodels/SciPy recomputation, source/ZIP/SVG
and PDF checks. All 48 print pages and all three actual Store screenshots were visually reviewed;
six portable studios reopen offline with working controls and 24 narrow-screen views. The seven
browser workflows include protocol protection, real CSV upload/correction, source conflicts,
rank recovery through new runs and held-out confirmation. All 27 package tests and 421 CLI
Store/check tests pass locally. See [the complete evidence and reproducible checks](../store/agents/lab-bench/test/ACCEPTANCE.md).

The response fixtures are explicitly synthetic test data, never empirical product claims.
The rebuilt package has `listed:true` and is live in the public Store. Exact-head CI
`35512306940` passed at `a11fc47003dec8e2263ce85c8c93625be6b567e7`; the merge is
`119c5b69ac1d585a649658a5aeb5f1a52376361e`. Publisher `35512724426` passed. The public catalog
lists all seven rebuilt harnesses; the Lab studio and all three screenshots match the tested
bytes. Published package revision: `ec6642b1ae73fbef5b19d1d0cc792be7573f94ae`.

Normal Store-ID installation at that merge passes setup and doctor on this Mac. Actual
framework materialization and launch environment then run build/check/export, produce real
PDFs, start the installed viewer and save/reopen a browser edit with source history and zero
page errors. The initial unmeasured plan's seven PDF pages were also visually reviewed.
Installed path: `/Users/d/.harness/dsh/autonomous/lab-bench`. Final workspace:
`/var/folders/cm/6rf6j7pn1ys698mtjh434zsw0000gp/T/signal-installed-9VHvVn`.
Proof: `/private/tmp/signal-public-bytes.json`, `/private/tmp/signal-installed-workspace.json`,
`/private/tmp/signal-installed-viewer.json`, `/private/tmp/signal-published-id-install.log`.

The first immediate Store-ID lookup missed the new catalog entry and tried it as a Git source.
The explicit repository/path install passed; forcing a catalog refresh then made Store-ID
installation pass too. The underlying first-lookup cause was not established, so do not claim
a resolver fix. No installed-agent prompt trial or actual physical experiment is claimed.
