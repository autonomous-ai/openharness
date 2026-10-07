# Contract fixtures

`gridProfile.contract.json` is what `GET /api/grid/profile` answers for one known account (a
Google-linked one), in the Autonomous profile shape the Grid control plane parses — ADR 0046 in the
autonomous-grid repository.

**It is hand-duplicated in grid-apis** (`tests/fixtures/harness_grid_profile.contract.json`), the
cross-repo lockstep convention: there is no code dependency between the repositories, so each side
pins its own copy. `routes/gridProfile.test.ts` asserts this route produces it; grid-apis asserts it
parses to the expected identity and account key. Change both copies together — changing one alone
fails a test on that side, which is the point.
